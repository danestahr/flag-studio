import './landing.css';
import './icons.js';
import { requireAuth, isStaffOrAdmin } from './auth.js';
import { loadProject, loadFlagConfig, loadHoleSignConfig, loadOrderIntake,
         updateProject, deleteProject, upsertCustomerInfo,
         adminRequestChanges, adminSendProof, adminMarkSentToPrint,
         listPrintSheets, getPrintSheetDownloadUrl, sendProofReady } from './supabase.js';
import { FLAGS } from './data.js';
import { esc } from './dom-utils.js';

const session = await requireAuth();
const isAdmin = await isStaffOrAdmin(session);

const pid = new URLSearchParams(window.location.search).get('project');
if (!pid) window.location.href = '/';

const flagCard  = document.getElementById('flagCard');
const holeCard  = document.getElementById('holeCard');
flagCard.href  = `/flags.html?project=${pid}`;
holeCard.href  = `/hole-signs.html?project=${pid}`;

let _project = null;
let _intake = null;

const STATUS_LABEL = {
  draft: 'Draft',
  submitted: 'Submitted for review',
  needs_changes: 'Changes requested',
  proof_sent: 'Proof sent — awaiting client',
  approved: 'Approved',
  sent_to_print: 'Sent to print',
};

async function init() {
  try {
    const [project, flagCfg, holeCfg, intake] = await Promise.all([
      loadProject(pid),
      loadFlagConfig(pid).catch(() => null),
      loadHoleSignConfig(pid).catch(() => null),
      loadOrderIntake(pid).catch(() => null),
    ]);
    _project = project;
    _intake = intake;

    const nameInput = document.getElementById('projectNameInput');
    nameInput.value = project.name || '';
    nameInput.addEventListener('input', e => {
      updateProject(pid, { name: e.target.value || null }).catch(() => {});
    });

    const creatorName = [project.profiles?.first_name, project.profiles?.last_name].filter(Boolean).join(' ');
    const creator = creatorName || project.profiles?.email;
    const creatorEl = document.getElementById('projectCreatorInfo');
    if (creatorEl && creator) {
      creatorEl.textContent = `Created by ${creator}`;
      creatorEl.style.display = '';
    }

    setStatus('flagStatus', flagCfg, intake);
    setStatus('holeStatus', holeCfg, intake);

    if (intake?.flag_style) {
      const flag = FLAGS.find(f => f.id === intake.flag_style);
      const templateEl = document.getElementById('flagTemplateInfo');
      if (templateEl && flag) {
        templateEl.textContent = 'Template: ' + flag.name;
        templateEl.style.display = '';
      }
    }

    // Show a summary line if customer info exists
    const ci = project.customer_info;
    if (ci?.contact_name || ci?.event_name || intake?.contact_name || intake?.event_name) {
      const name = ci?.contact_name || intake?.contact_name || '';
      const event = ci?.event_name || intake?.event_name || '';
      const summary = [name, event].filter(Boolean).join(' · ');
      const summaryEl = document.getElementById('customerInfoSummary');
      if (summaryEl && summary) summaryEl.textContent = summary;
    }

    if (isAdmin) {
      document.getElementById('adminReviewPanel').style.display = '';
      renderStatus(_project);
      renderReviewLink(_project);
      loadPrintSheets(pid);
    }
    // Customer-facing status/submit UI is a later phase - customers keep
    // today's hub view unchanged for now.
  } catch (err) {
    console.error('Failed to load project', err);
  }
}

function setStatus(elId, cfg, intake) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (cfg) {
    el.textContent = 'Draft saved';
    el.classList.add('configured');
  } else if (intake) {
    el.textContent = 'Order received';
    el.classList.add('configured');
  } else {
    el.textContent = 'Not started';
  }
}

init();

// ── Customer details modal ──────────────────────────────────
// The dedicated /customer.html page was removed (it depended on a local-only
// package path that broke the Vercel build). This is an editable form instead
// of a read-only view — customer_info is separate from the original order
// intake, so designers can fill in or correct details straight from here,
// including for projects where no order form was ever submitted.
const customerModal = document.getElementById('customerModal');

const CUSTOMER_FIELDS = [
  { key: 'event_name', label: 'Event Name', type: 'text' },
  { key: 'event_date', label: 'Event Date', type: 'date' },
  { key: 'contact_name', label: 'Contact Name', type: 'text' },
  { key: 'contact_email', label: 'Contact Email', type: 'email' },
  { key: 'address_line1', label: 'Address Line 1', type: 'text' },
  { key: 'address_line2', label: 'Address Line 2', type: 'text' },
  { key: 'city', label: 'City', type: 'text', pair: true },
  { key: 'state_province', label: 'State / Province', type: 'text', pair: true },
  { key: 'postal_code', label: 'Postal Code', type: 'text', pair: true },
  { key: 'country', label: 'Country', type: 'text', pair: true },
  { key: 'design_notes', label: 'Notes', type: 'textarea' },
];

function fieldHtml(f, value) {
  const v = esc(value ?? '');
  const inputId = 'cf-' + f.key;
  if (f.type === 'textarea') {
    return `<div class="form-row"><label class="form-label" for="${inputId}">${f.label}</label><textarea class="form-textarea" id="${inputId}">${v}</textarea></div>`;
  }
  return `<div class="form-row"><label class="form-label" for="${inputId}">${f.label}</label><input class="form-input" id="${inputId}" type="${f.type}" value="${v}"></div>`;
}

window.openCustomerModal = function () {
  const body = document.getElementById('customerModalBody');
  const status = document.getElementById('customerModalStatus');
  if (status) status.textContent = '';
  // customer_info is the editable record; fall back to the original order-form
  // submission only to pre-fill fields that have never been edited here yet.
  const ci = _project?.customer_info || {};
  const intake = _intake || {};
  const get = key => ci[key] ?? intake[key] ?? '';

  let html = '';
  let i = 0;
  while (i < CUSTOMER_FIELDS.length) {
    const f = CUSTOMER_FIELDS[i];
    if (f.pair && CUSTOMER_FIELDS[i + 1]?.pair) {
      html += `<div class="form-row-pair">${fieldHtml(f, get(f.key))}${fieldHtml(CUSTOMER_FIELDS[i + 1], get(CUSTOMER_FIELDS[i + 1].key))}</div>`;
      i += 2;
    } else {
      html += fieldHtml(f, get(f.key));
      i += 1;
    }
  }
  body.innerHTML = html;
  customerModal.style.display = 'flex';
};

window.saveCustomerInfo = async function () {
  const btn = document.getElementById('customerSaveBtn');
  const status = document.getElementById('customerModalStatus');
  const info = { ..._project?.customer_info };
  CUSTOMER_FIELDS.forEach(f => {
    const el = document.getElementById('cf-' + f.key);
    if (el) info[f.key] = el.value || null;
  });
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await upsertCustomerInfo(pid, info);
    _project = { ..._project, customer_info: info };
    const name = info.contact_name || '';
    const event = info.event_name || '';
    const summary = [name, event].filter(Boolean).join(' · ');
    const summaryEl = document.getElementById('customerInfoSummary');
    if (summaryEl) summaryEl.textContent = summary || 'Contact, shipping & design preferences';
    customerModal.style.display = 'none';
  } catch (err) {
    console.error('Failed to save customer info', err);
    if (status) status.textContent = 'Could not save — please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
};

window.closeCustomerModal = function () {
  customerModal.style.display = 'none';
};

// ── Delete modal ───────────────────────────────────────────
const deleteModal = document.getElementById('deleteModal');
const deleteBtn   = document.getElementById('deleteConfirmBtn');

window.openDeleteModal = function() {
  deleteModal.style.display = 'flex';
};

window.closeDeleteModal = function() {
  deleteModal.style.display = 'none';
};

window.confirmDelete = async function() {
  deleteBtn.disabled = true;
  deleteBtn.textContent = 'Deleting…';
  try {
    await deleteProject(pid);
    window.location.href = '/';
  } catch (err) {
    console.error(err);
    alert('Could not delete project.');
    deleteBtn.disabled = false;
    deleteBtn.textContent = 'Delete';
  }
};

// ── Admin review panel (staff/admin only) ───────────────────
function renderStatus(project) {
  const pill = document.getElementById('statusPill');
  pill.textContent = STATUS_LABEL[project.status] || project.status;
  pill.className = 'status-pill status-' + project.status;

  const actionsEl = document.getElementById('statusActions');
  document.getElementById('requestChangesForm').style.display = 'none';

  const btn = (label, onClick, primary = false) => {
    const b = document.createElement('button');
    b.className = 'btn' + (primary ? ' primary' : '');
    b.style.marginRight = '8px';
    b.textContent = label;
    b.onclick = onClick;
    return b;
  };

  actionsEl.innerHTML = '';
  if (project.status === 'submitted') {
    actionsEl.appendChild(btn('Request changes', () => {
      document.getElementById('requestChangesForm').style.display = '';
      document.getElementById('requestChangesNote').value = '';
    }));
    actionsEl.appendChild(btn('Send proof to client', window.sendProofToClient, true));
  } else if (project.status === 'needs_changes') {
    actionsEl.appendChild(document.createTextNode('Waiting on the client to resubmit. '));
    actionsEl.appendChild(btn('Send proof to client', window.sendProofToClient, true));
  } else if (project.status === 'proof_sent') {
    actionsEl.appendChild(btn('Resend proof email', window.resendProofEmail));
  } else if (project.status === 'approved') {
    actionsEl.appendChild(document.createTextNode('Client approved — ready to print.'));
  } else if (project.status === 'sent_to_print') {
    actionsEl.appendChild(document.createTextNode('Sent to print.'));
  } else {
    actionsEl.appendChild(document.createTextNode('Waiting on the client to submit for review.'));
  }

  document.getElementById('markSentToPrintBtn').style.display = project.status === 'approved' ? '' : 'none';
  document.getElementById('markSentToPrintConfirm').style.display = 'none';
}

function setReviewPanelStatus(message) {
  const el = document.getElementById('reviewPanelStatus');
  if (el) el.textContent = message || '';
}

window.cancelRequestChanges = function () {
  document.getElementById('requestChangesForm').style.display = 'none';
};

window.confirmRequestChanges = async function () {
  const note = document.getElementById('requestChangesNote').value.trim() || null;
  const confirmBtn = document.getElementById('confirmRequestChangesBtn');
  confirmBtn.disabled = true;
  setReviewPanelStatus('');
  try {
    await adminRequestChanges(pid, note);
    _project = await loadProject(pid);
    renderStatus(_project);
  } catch (err) {
    console.error('Failed to request changes', err);
    setReviewPanelStatus('Could not request changes — please try again.');
  } finally {
    confirmBtn.disabled = false;
  }
};

window.sendProofToClient = async function () {
  setReviewPanelStatus('Sending proof…');
  try {
    const token = await adminSendProof(pid);
    _project = { ..._project, status: 'proof_sent', share_token: token };
    const reviewUrl = `${window.location.origin}/review.html?token=${token}`;
    if (_intake?.contact_email) {
      await sendProofReady({
        contactName: _intake.contact_name || '',
        contactEmail: _intake.contact_email,
        eventName: _intake.event_name || 'your event',
        reviewUrl,
      }).catch(err => console.error('sendProofReady failed', err));
    }
    _project = await loadProject(pid);
    renderStatus(_project);
    renderReviewLink(_project);
    setReviewPanelStatus('Proof sent.');
  } catch (err) {
    console.error('Failed to send proof', err);
    setReviewPanelStatus('Could not send the proof — please try again.');
  }
};

window.resendProofEmail = async function () {
  if (!_project?.share_token) return;
  const reviewUrl = `${window.location.origin}/review.html?token=${_project.share_token}`;
  setReviewPanelStatus('Resending…');
  try {
    await sendProofReady({
      contactName: _intake?.contact_name || '',
      contactEmail: _intake?.contact_email || '',
      eventName: _intake?.event_name || 'your event',
      reviewUrl,
    });
    setReviewPanelStatus('Proof email resent.');
  } catch (err) {
    console.error('Failed to resend proof email', err);
    setReviewPanelStatus('Could not resend the email — please try again.');
  }
};

window.revealMarkSentToPrintConfirm = function () {
  document.getElementById('markSentToPrintConfirm').style.display = '';
};

window.cancelMarkSentToPrint = function () {
  document.getElementById('markSentToPrintConfirm').style.display = 'none';
};

window.confirmMarkSentToPrint = async function () {
  setReviewPanelStatus('');
  try {
    await adminMarkSentToPrint(pid);
    document.getElementById('markSentToPrintConfirm').style.display = 'none';
    _project = await loadProject(pid);
    renderStatus(_project);
  } catch (err) {
    console.error('Failed to mark sent to print', err);
    setReviewPanelStatus('Could not update — please try again.');
  }
};

function renderReviewLink(project) {
  const emptyEl = document.getElementById('reviewLinkEmpty');
  const boxEl = document.getElementById('reviewLinkBox');
  if (!project.share_token) {
    emptyEl.style.display = '';
    boxEl.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  boxEl.style.display = '';
  document.getElementById('reviewLinkInput').value = `${window.location.origin}/review.html?token=${project.share_token}`;
}

window.copyReviewLink = function () {
  const input = document.getElementById('reviewLinkInput');
  navigator.clipboard.writeText(input.value).catch(() => {});
  input.select();
};

async function loadPrintSheets(projectId) {
  const listEl = document.getElementById('printSheetList');
  try {
    const sheets = await listPrintSheets(projectId);
    if (!sheets.length) {
      listEl.textContent = 'No print files uploaded yet.';
      return;
    }
    listEl.innerHTML = sheets.map(s => {
      const match = s.name.match(/^([a-z-]+)-\d+\.zip$/);
      const label = match ? (match[1] === 'flags' ? 'Flags' : match[1] === 'hole-signs' ? 'Hole Signs' : match[1]) : s.name;
      return `<div class="print-sheet-row"><span>${esc(label)} — ${new Date(s.createdAt).toLocaleDateString()}</span>` +
        `<button class="btn sm" data-path="${esc(s.path)}">Download</button></div>`;
    }).join('');
    listEl.querySelectorAll('button[data-path]').forEach(b => b.addEventListener('click', async () => {
      // Open the tab synchronously, in the click handler, before the await -
      // Chrome only allows window.open() as a popup-blocker-exempt trusted
      // action within the same tick as the user gesture that triggered it.
      const win = window.open('', '_blank');
      try {
        const url = await getPrintSheetDownloadUrl(b.dataset.path);
        if (win) win.location.href = url;
      } catch (err) {
        console.error('Failed to get print sheet download url', err);
        if (win) win.close();
        setReviewPanelStatus('Could not generate a download link.');
      }
    }));
  } catch (err) {
    console.error('Failed to load print sheets', err);
    listEl.textContent = 'Could not load print files.';
  }
}
