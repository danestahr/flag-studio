import './landing.css';
import './icons.js';
import { requireAuth, isStaffOrAdmin } from './auth.js';
import { loadProject, loadFlagConfig, loadHoleSignConfig, loadOrderIntake,
         updateProject, deleteProject, upsertCustomerInfo,
         submitDesignForReview, adminRequestDesignChanges, adminSendDesignProof, adminMarkDesignSentToPrint,
         sendProofReady, loadLatestChangeNote, loadLatestPrintAction, sendPrestigeOrder } from './supabase.js';
import { FLAGS } from './data.js';
import { loadAllFlags } from './svgLoader.js';
import { hydrateFlagStateForProject, buildFlagsPrintZip } from './flags/print-export.js';
import { esc } from './dom-utils.js';
import { STATUS_LABEL } from './status-labels.js';

const session = await requireAuth();
const isAdmin = await isStaffOrAdmin(session);

const pid = new URLSearchParams(window.location.search).get('project');
if (!pid) window.location.href = '/';

let _project = null;
let _intake = null;
let _flagCfg = null;
let _holeCfg = null;

// Flags and hole signs each carry their own status (flag_config.status /
// hole_sign_config.status - see supabase/migrations/
// 20260913000000_per_design_status_workflow.sql) and progress through
// review independently - a project can have Flags: Draft and Hole Signs:
// In Review at once. `projects.share_token`/`proof_shared_at` stay
// project-level: one shared review link for both design types. Each design's
// card (see renderToolCards()) combines the tool launcher with this status,
// so everything for one product type lives in one place.
const DESIGN_TYPES = [
  { productType: 'flags', label: 'Flags', name: 'Tournament Flags', unit: 'flag', editorHref: `/flags?project=${pid}` },
  { productType: 'hole-signs', label: 'Hole Signs', name: 'Hole Signs', unit: 'hole sign', editorHref: `/hole-signs?project=${pid}` },
];

// Section-jump targets for each design type's wizard - shown as numbered
// links in the tool card footer once a design has been started (cfg
// exists), so staff/customers can deep-link straight into a specific step
// instead of always landing on Design. Flags' three steps are separate
// pages (flags.html / flags-variations.html / flags-gallery.html); hole
// signs is one page that reads `panel` from the URL (see hs/app.js).
const STEP_SECTIONS = {
  flags: [
    { label: 'Design', href: p => `/flags?project=${p}` },
    { label: 'Variations', href: p => `/flags-variations?project=${p}` },
    { label: 'Review', href: p => `/flags-gallery?project=${p}` },
  ],
  'hole-signs': [
    { label: 'Design', href: p => `/hole-signs?project=${p}&panel=1` },
    { label: 'Variations', href: p => `/hole-signs?project=${p}&panel=2` },
    { label: 'Review', href: p => `/hole-signs?project=${p}&panel=3` },
  ],
};

function cfgFor(productType) { return productType === 'flags' ? _flagCfg : _holeCfg; }

// flag_config.variations is a wrapper object ({layout, items, gsTag, ...} -
// see saveFlagConfig); hole_sign_config.variations is a plain array (see
// saveHoleSignConfig). A shared `(cfg.variations || []).length` check across
// both product types silently always reads 0 for flags, since a plain
// object has no .length - this unwraps each shape correctly instead.
function designHasVariations(productType, cfg) {
  if (!cfg) return false;
  if (productType === 'flags') {
    const v = cfg.variations;
    return (Array.isArray(v) ? v : (v?.items || [])).length > 0;
  }
  return (cfg.variations || []).length > 0;
}

// Same shape-unwrap as designHasVariations, but returns the counts themselves
// - variation count, and total printed-unit count (sum of each variation's
// qty, defaulting to 1 for any variation created before qty existed).
function variationStats(productType, cfg) {
  if (!cfg) return { count: 0, qty: 0 };
  const items = productType === 'flags'
    ? (Array.isArray(cfg.variations) ? cfg.variations : (cfg.variations?.items || []))
    : (cfg.variations || []);
  return {
    count: items.length,
    qty: items.reduce((sum, v) => sum + (parseInt(v.qty, 10) || 1), 0),
  };
}

// Re-fetches project/flagCfg/holeCfg/intake fresh from Supabase — split out
// of init() so the "Update" button (next to each design's review-link Copy
// button) can re-run just the fetch, without init()'s one-time DOM wiring
// (re-running that on every click would stack a duplicate nameInput
// listener per click, firing updateProject() multiple times per keystroke).
async function loadProjectData() {
  const [project, flagCfg, holeCfg, intake] = await Promise.all([
    loadProject(pid),
    loadFlagConfig(pid).catch(() => null),
    loadHoleSignConfig(pid).catch(() => null),
    loadOrderIntake(pid).catch(() => null),
  ]);
  _project = project;
  _intake = intake;
  _flagCfg = flagCfg;
  _holeCfg = holeCfg;
}

async function init() {
  try {
    await loadProjectData();

    const nameInput = document.getElementById('projectNameInput');
    nameInput.value = _project.name || '';
    nameInput.addEventListener('input', e => {
      updateProject(pid, { name: e.target.value || null }).catch(() => {});
    });

    const creatorName = [_project.profiles?.first_name, _project.profiles?.last_name].filter(Boolean).join(' ');
    const creator = creatorName || _project.profiles?.email;
    const creatorEl = document.getElementById('projectCreatorInfo');
    if (creatorEl && creator) {
      creatorEl.textContent = `Created by ${creator}`;
      creatorEl.style.display = '';
    }

    // Show a summary line if customer info exists
    const ci = _project.customer_info;
    if (ci?.contact_name || ci?.event_name || _intake?.contact_name || _intake?.event_name) {
      const name = ci?.contact_name || _intake?.contact_name || '';
      const event = ci?.event_name || _intake?.event_name || '';
      const summary = [name, event].filter(Boolean).join(' · ');
      const summaryEl = document.getElementById('customerInfoSummary');
      if (summaryEl && summary) summaryEl.textContent = summary;
    }

    renderToolCards();
  } catch (err) {
    console.error('Failed to load project', err);
  }
}

// ── Tool cards ("Choose a tool") ───────────────────────────────
// One card per design type, combining the tool launcher with that design's
// review/approval status and actions (admin) or submit/status (customer) -
// merged into a single stacked column instead of separate sections.
function renderToolCards() {
  const cardsEl = document.getElementById('toolCards');
  cardsEl.innerHTML = DESIGN_TYPES.map(t => `
    <div class="tool-card">
      <div class="tool-card-body">
        <div class="tool-card-name">${esc(t.name)}</div>
      </div>
      <div id="toolCardStatus-${t.productType}" class="tool-card-status"></div>
    </div>`).join('');

  DESIGN_TYPES.forEach(t => renderToolCardStatus(t));
}

// Refreshes one design type's status block - called from init() and from
// every action that changes that design's status (submit, request changes,
// send proof, mark sent to print), so only that card needs to re-render.
function renderToolCardStatus(t) {
  const statusEl = document.getElementById(`toolCardStatus-${t.productType}`);
  const cfg = cfgFor(t.productType);

  if (!cfg) {
    statusEl.innerHTML = `
      <div class="tool-card-group">
        <div class="status-block status-draft">
          <div class="status-block-label">Status</div>
          <div class="status-block-value">${_intake ? 'Order received' : 'Not started'}</div>
        </div>
        <div class="tool-card-footer">
          <a class="btn primary block" href="${esc(t.editorHref)}">Start designing</a>
        </div>
      </div>`;
    return;
  }

  // Same "which step is next" logic the wizard sidebar uses for its own
  // active/done split (n < activeStep), just fed by design-progress signals
  // instead of "which panel is open" - there's no open wizard here. Design
  // is always done by this point (cfg exists), so activeStep only needs to
  // distinguish "no variations yet" (Variations is next) from "has
  // variations" (Review is next). Review itself is only marked done once the
  // design has actually been sent to print - short of that there's no signal
  // that it was ever visited.
  const activeStep = designHasVariations(t.productType, cfg) ? 3 : 2;
  const stepLinks = STEP_SECTIONS[t.productType].map((s, i) => {
    const n = i + 1;
    const done = n < activeStep || (n === 3 && cfg.status === 'sent_to_print');
    const state = (n === activeStep ? ' active' : '') + (done ? ' done' : '');
    return `
    <a class="step-item${state}" href="${esc(s.href(pid))}" title="${esc(s.label)}">
      <div class="step-num"><span>${n}</span></div>
      <div class="step-label">${esc(s.label)}</div>
    </a>`;
  }).join('');

  const status = cfg.status || 'draft';
  const stats = variationStats(t.productType, cfg);
  statusEl.innerHTML = `
    <div class="tool-card-group">
      <div class="tool-card-stats">${stats.count} variation${stats.count === 1 ? '' : 's'} &middot; ${stats.qty} ${t.unit}${stats.qty === 1 ? '' : 's'} total</div>
      <div id="statusBlock-${t.productType}" class="status-block">
        <div class="status-block-label">Status</div>
        <div id="statusValue-${t.productType}" class="status-block-value"></div>
      </div>
      <div class="tool-steps-nav">${stepLinks}</div>
    </div>
    ${isAdmin ? `
    <hr class="tool-card-divider" id="reviewLinkDividerTop-${t.productType}" style="display:none">
    <div id="reviewLinkRow-${t.productType}" style="display:none">
      <div style="font-size:12px;color:var(--gray-400);margin-bottom:6px">Review link</div>
      <div class="link-btn-row" id="reviewLinkBtnRow-${t.productType}"></div>
    </div>
    <hr class="tool-card-divider" id="reviewLinkDividerBottom-${t.productType}" style="display:none">
    <div id="statusActions-${t.productType}"></div>
    <div id="requestChangesForm-${t.productType}" style="display:none;margin-top:.75rem">
      <textarea class="form-textarea" id="requestChangesNote-${t.productType}" placeholder="What needs to change?"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn primary" onclick="window.confirmRequestChanges('${t.productType}')">Send to client</button>
        <button class="btn-secondary" onclick="window.cancelRequestChanges('${t.productType}')">Cancel</button>
      </div>
    </div>
    <div id="reviewPanelStatus-${t.productType}" style="font-size:12px;color:var(--gray-400);min-height:16px;margin-top:8px"></div>
    <div id="printSection-${t.productType}" style="display:flex;flex-direction:column;gap:.75rem"></div>
    ` : `<div id="customerStatusBody-${t.productType}" style="margin-top:1.5rem;font-size:13px;color:var(--gray-600);line-height:1.5"></div>`}
  `;

  setStatusValue(t.productType, status);

  if (isAdmin) renderDesignAdminActions(t, cfg, status);
  else renderCustomerDesignBody(t, cfg, status);
}

// STATUS_LABEL (status-labels.js) deliberately collapses approved/
// sent_to_print into one "Approved" bucket for the landing-page filter list
// - but here on project.html, once a design has actually gone to print,
// staff need that to read differently from merely "Approved" so a design
// already sent doesn't look identical to one still waiting to be sent.
function displayStatusLabel(status) {
  if (status === 'sent_to_print') return 'Sent to Print';
  return STATUS_LABEL[status] || status;
}

// Paints the colored status block - the normal state shows the status
// label; passing `loading` swaps the value for a spinner + an in-progress
// message without losing the status-colored container, so an in-flight
// send-proof/send-to-print action reads as part of the same status block
// instead of a separate transient line below it.
function setStatusValue(productType, status, loading) {
  const block = document.getElementById(`statusBlock-${productType}`);
  const value = document.getElementById(`statusValue-${productType}`);
  if (!block || !value) return;
  block.className = 'status-block status-' + status;
  value.innerHTML = loading
    ? `<span class="spinner-sm"></span>${esc(loading)}`
    : esc(displayStatusLabel(status));
}

// ── Admin actions (staff/admin only) ──────────────────────────
function renderDesignAdminActions(t, cfg, status) {
  const actionsEl = document.getElementById(`statusActions-${t.productType}`);
  document.getElementById(`requestChangesForm-${t.productType}`).style.display = 'none';

  const btn = (label, onClick, primary = false) => {
    const b = document.createElement('button');
    b.className = 'btn' + (primary ? ' primary' : '');
    b.style.marginRight = '8px';
    b.textContent = label;
    b.onclick = onClick;
    return b;
  };

  actionsEl.innerHTML = '';
  if (status === 'submitted') {
    actionsEl.appendChild(btn('Request changes', () => {
      document.getElementById(`requestChangesForm-${t.productType}`).style.display = '';
      document.getElementById(`requestChangesNote-${t.productType}`).value = '';
    }));
  } else if (status === 'draft') {
    // Normally the client submits it themselves - but an admin-created
    // project (landing.js's "+ New project" fast path, owned by the staff
    // member who made it) has no separate client to do that, so it would
    // otherwise sit in draft forever. Staff can submit on its behalf here
    // too - the RPC already allows staff/admin to call
    // submit_design_for_review for any project, owned or not.
    actionsEl.appendChild(document.createTextNode('Waiting on the client to submit for review. '));
    if (designHasVariations(t.productType, cfg)) {
      actionsEl.appendChild(btn('Submit for review', () => window.submitForReview(t.productType), true));
    }
  }
  // needs_changes/proof_sent: nothing extra here - sending/resending a
  // proof is handled by the "Send proof" button in the review-link section
  // below. approved/sent_to_print: handled by the full-width print section.

  renderReviewLinkSection(t.productType, status);
  renderPrintSection(t.productType, status);
}

// Once a proof has gone out at least once (share_token set), surface the
// same link staff already emailed so it can be copied again - one shared
// link/token for both design types. The "Send proof" button covers both
// the very first send and every resend/reshare after (admin_send_design_proof
// accepts submitted/needs_changes/proof_sent and reuses the existing token -
// see 20260913000000_per_design_status_workflow.sql), so there's no separate
// "resend" action to maintain.
function renderReviewLinkSection(productType, status) {
  const row = document.getElementById(`reviewLinkRow-${productType}`);
  const dividerTop = document.getElementById(`reviewLinkDividerTop-${productType}`);
  const dividerBottom = document.getElementById(`reviewLinkDividerBottom-${productType}`);
  const hasToken = !!_project.share_token;
  const canSend = ['submitted', 'needs_changes', 'proof_sent'].includes(status);
  if (!hasToken && !canSend) {
    row.style.display = 'none';
    dividerTop.style.display = 'none';
    dividerBottom.style.display = 'none';
    return;
  }
  row.style.display = '';
  dividerTop.style.display = '';
  dividerBottom.style.display = '';

  // No visible URL - just the actions. Copy/refreshProjectStatus build the
  // link straight from _project.share_token instead of reading it back out
  // of an input.
  document.getElementById(`reviewLinkBtnRow-${productType}`).innerHTML = `
    ${hasToken ? `<button class="btn sm" onclick="window.copyReviewLink('${productType}')">Copy</button>` : ''}
    ${hasToken ? `<button class="btn sm" onclick="window.refreshProjectStatus('${productType}')" title="Refresh with the latest saved design"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Update</button>` : ''}
    ${canSend ? `<button class="btn sm primary" onclick="window.sendProofToClient('${productType}')">Send proof</button>` : ''}
  `;
}

// Full-width, divider-separated print action - split out from the other
// (lighter-weight) review actions above since sending to print is the
// irreversible, "this is really happening" step. Flags can still be
// tweaked and resent after going to print (a client-requested change
// caught late, a vendor-flagged issue) - see
// 20260915000000_allow_resend_to_print.sql. Hole signs go through a
// separate, non-automated print process, so there's nothing to resend.
function renderPrintSection(productType, status) {
  const el = document.getElementById(`printSection-${productType}`);
  const label = productType === 'flags'
    ? (status === 'sent_to_print' ? 'Resend to Prestige Flag' : 'Send to Prestige Flag')
    : 'Mark sent to print';
  const show = status === 'approved' || (status === 'sent_to_print' && productType === 'flags');
  if (!show) {
    el.innerHTML = '';
    return;
  }

  // The "last sent" label only applies once there's actually a previous
  // send to show (sent_to_print) - omitted entirely for 'approved' (nothing
  // sent yet) rather than left as an empty flex child, which would still
  // eat a gap slot between the divider and the button.
  el.innerHTML = `
    <hr class="tool-card-divider">
    ${status === 'sent_to_print' ? `<div id="printMeta-${productType}" style="font-size:12px;color:var(--gray-400)"></div>` : ''}
    <button class="btn primary block" onclick="window.confirmMarkSentToPrint('${productType}')">${esc(label)}</button>
  `;

  // Fetched separately (not awaited) so the button itself renders instantly
  // - the timestamp just fills in a beat later once the query resolves.
  if (status === 'sent_to_print') {
    loadLatestPrintAction(pid, productType).then(action => {
      if (!action?.created_at) return;
      const metaEl = document.getElementById(`printMeta-${productType}`);
      if (!metaEl) return;
      const stamp = new Date(action.created_at).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      metaEl.textContent = `Last sent ${stamp}`;
    }).catch(err => console.error('Failed to load last print timestamp', err));
  }
}

// ── Customer status body (non-admin owners) ───────────────────
async function renderCustomerDesignBody(t, cfg, status) {
  const body = document.getElementById(`customerStatusBody-${t.productType}`);
  const hasVariations = designHasVariations(t.productType, cfg);
  const submitBtn = (label) => `<br><button type="button" class="btn sm primary" style="margin-top:8px" onclick="window.submitForReview('${t.productType}')">${esc(label)}</button>`;

  if (status === 'draft') {
    body.innerHTML = hasVariations
      ? `Finish your design, then submit for review when you’re ready.${submitBtn('Submit for review')}`
      : 'Choose a tool above to start designing. You’ll be able to submit for review once you have a variation.';
  } else if (status === 'needs_changes') {
    let note = null;
    try {
      note = await loadLatestChangeNote(pid, t.productType);
    } catch (err) {
      console.error('Failed to load change note', err);
    }
    const noteText = note?.note ? `"${note.note}"` : 'Changes were requested.';
    body.innerHTML = `${esc(noteText)}<br><a href="${esc(t.editorHref)}" style="color:var(--accent)">Make your changes →</a>${hasVariations ? submitBtn('Resubmit for review') : ''}`;
  } else if (status === 'submitted') {
    body.textContent = 'Submitted — our design team will review it shortly.';
  } else if (status === 'proof_sent') {
    body.textContent = 'We’ve sent your proof for review. We’ll follow up once you’ve responded.';
  } else if (status === 'approved') {
    body.textContent = 'Approved — your order is being prepared for print.';
  } else if (status === 'sent_to_print') {
    body.textContent = 'Sent to print.';
  }
}

// Shared by the customer status body's own button and the admin panel's
// staff-submit action below (submit_design_for_review's RPC already permits
// staff/admin to call this for any project, not just ones they own - see
// 20260913000000_per_design_status_workflow.sql).
window.submitForReview = async function (productType) {
  try {
    await submitDesignForReview(pid, productType);
    const cfg = cfgFor(productType);
    if (cfg) cfg.status = 'submitted';
    renderToolCardStatus(DESIGN_TYPES.find(t => t.productType === productType));
  } catch (err) {
    console.error('Failed to submit for review', err);
    alert('Could not submit for review — please try again.');
  }
};

init();

// ── Customer details modal ──────────────────────────────────
// The dedicated /customer.html page was removed (it depended on a local-only
// package path that broke the Vercel build). This is an editable form instead
// of a read-only view — customer_info is separate from the original order
// intake, so designers can fill in or correct details straight from here,
// including for projects where no order form was ever submitted.
const customerModal = document.getElementById('customerModal');

// Covers every field the order form collects across Steps 1-3 (event
// details, contact/shipping, design preferences) so staff can see and correct
// the full original submission in one place - not just name/address. The one
// exception is flag_colors: it's a structured {zones,gsTag,gsTagMode} object
// coming from the color pickers, not a simple scalar this generic text/date/
// textarea form can edit; see the flag/hole-sign designer for that instead.
const CUSTOMER_FIELDS = [
  { key: 'event_name', label: 'Event Name', type: 'text' },
  { key: 'course_name', label: 'Course Name', type: 'text' },
  { key: 'event_date', label: 'Event Date', type: 'date' },
  { key: 'event_source_url', label: 'Event Site Link', type: 'url' },
  { key: 'contact_name', label: 'Contact Name', type: 'text' },
  { key: 'contact_email', label: 'Contact Email', type: 'email' },
  { key: 'attn', label: 'ATTN', type: 'text' },
  { key: 'address_line1', label: 'Address Line 1', type: 'text' },
  { key: 'address_line2', label: 'Address Line 2', type: 'text' },
  { key: 'city', label: 'City', type: 'text', pair: true },
  { key: 'state_province', label: 'State / Province', type: 'text', pair: true },
  { key: 'postal_code', label: 'Postal Code', type: 'text', pair: true },
  { key: 'country', label: 'Country', type: 'text', pair: true },
  { key: 'flag_style', label: 'Flag Style', type: 'text' },
  { key: 'flag_setup', label: 'Flag Setup', type: 'text' },
  { key: 'flag_qty', label: 'Quantity', type: 'number' },
  { key: 'design_notes', label: 'Design Description', type: 'textarea' },
  { key: 'front_design_notes', label: 'Front Design Notes', type: 'textarea' },
  { key: 'back_design_notes', label: 'Back Design Notes', type: 'textarea' },
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

function setReviewPanelStatus(productType, message) {
  const el = document.getElementById(`reviewPanelStatus-${productType}`);
  if (el) el.textContent = message || '';
}

window.cancelRequestChanges = function (productType) {
  document.getElementById(`requestChangesForm-${productType}`).style.display = 'none';
};

window.confirmRequestChanges = async function (productType) {
  const note = document.getElementById(`requestChangesNote-${productType}`).value.trim() || null;
  setReviewPanelStatus(productType, '');
  try {
    await adminRequestDesignChanges(pid, productType, note);
    const cfg = cfgFor(productType);
    if (cfg) cfg.status = 'needs_changes';
    renderToolCardStatus(DESIGN_TYPES.find(t => t.productType === productType));
  } catch (err) {
    console.error('Failed to request changes', err);
    setReviewPanelStatus(productType, 'Could not request changes — please try again.');
  }
};

// Same "best known contact" precedence as the Customer details modal's `get`
// (line ~246): customer_info overrides only exist because staff corrected or
// filled in a value there, so they take priority; the order-submitted intake
// is the default for anything staff hasn't touched.
function contactInfo() {
  const ci = _project?.customer_info || {};
  const intake = _intake || {};
  return {
    name: ci.contact_name ?? intake.contact_name ?? '',
    email: ci.contact_email ?? intake.contact_email ?? '',
    eventName: ci.event_name ?? intake.event_name ?? '',
  };
}

window.sendProofToClient = async function (productType) {
  // Any send that isn't the client's very first proof - a resend after
  // needs_changes, or a reshare of an updated design while still proof_sent -
  // gets the "revised proof" copy instead of the original "ready for review".
  const isRevision = cfgFor(productType)?.status !== 'submitted';
  const status = cfgFor(productType)?.status || 'draft';
  setStatusValue(productType, status, 'Sending proof…');
  try {
    const token = await adminSendDesignProof(pid, productType);
    const reviewUrl = `${window.location.origin}/review?token=${token}`;
    const contact = contactInfo();
    if (contact.email) {
      await sendProofReady({
        contactName: contact.name,
        contactEmail: contact.email,
        eventName: contact.eventName || 'your event',
        reviewUrl,
        isRevision,
        productType,
      }).catch(err => console.error('sendProofReady failed', err));
    }
    const [project, flagCfg, holeCfg] = await Promise.all([
      loadProject(pid),
      loadFlagConfig(pid).catch(() => null),
      loadHoleSignConfig(pid).catch(() => null),
    ]);
    _project = project;
    _flagCfg = flagCfg;
    _holeCfg = holeCfg;
    renderToolCardStatus(DESIGN_TYPES.find(t => t.productType === productType));
    setReviewPanelStatus(productType, 'Proof sent.');
  } catch (err) {
    console.error('Failed to send proof', err);
    setStatusValue(productType, status);
    setReviewPanelStatus(productType, 'Could not send the proof — please try again.');
  }
};

window.copyReviewLink = function (productType) {
  if (!_project?.share_token) return;
  const url = `${window.location.origin}/review?token=${_project.share_token}`;
  navigator.clipboard.writeText(url).then(() => {
    setReviewPanelStatus(productType, 'Link copied!');
    setTimeout(() => setReviewPanelStatus(productType, ''), 2000);
  });
};

// Re-fetches the project/flag/hole-sign config and re-renders both tool
// cards — for staff's own peace of mind before sharing/copying the link,
// since this page (unlike review.html) has no realtime subscription of its
// own and only ever reflects whatever was loaded at page load or the last
// refresh. Refreshing here doesn't need to write anything: review.html
// always reads the current DB row itself, so once a design is actually
// saved, the review page already has it either way — this just brings
// THIS page's own view back in sync so staff aren't looking at a stale
// status/variation count while copying the link.
window.refreshProjectStatus = async function (productType) {
  try {
    await loadProjectData();
    renderToolCards();
    setReviewPanelStatus(productType, 'Updated with the latest design.');
    setTimeout(() => setReviewPanelStatus(productType, ''), 2000);
  } catch (err) {
    console.error('Failed to refresh project status', err);
    setReviewPanelStatus(productType, 'Could not refresh — try again.');
  }
};

// For flags, this actually builds the print PDFs and emails them to
// Prestige Flag (same pipeline as flags/gallery.js's "Send to Prestige
// Flag") before marking the design sent to print - see ./flags/print-export.js.
// Hole signs go through a separate, non-automated process, so this just
// records the status transition for them, as it always has. Runs directly
// off the button click - the prominent status block above already makes
// what's about to happen ("Approved" → sending → "Sent to print") clear
// enough that a separate explain-and-confirm step would be redundant.
window.confirmMarkSentToPrint = async function (productType) {
  const status = cfgFor(productType)?.status || 'draft';
  setReviewPanelStatus(productType, '');
  let prestigeSent = false;
  try {
    if (productType === 'flags') {
      setStatusValue(productType, status, 'Preparing print files…');
      await loadAllFlags(FLAGS);
      await hydrateFlagStateForProject(pid);
      const { zipBlob } = await buildFlagsPrintZip(msg => setStatusValue(productType, status, msg));
      setStatusValue(productType, status, 'Sending to Prestige…');
      await sendPrestigeOrder(pid, _project?.name || 'Flag Order', zipBlob);
      prestigeSent = true;
    } else {
      setStatusValue(productType, status, 'Sending to print…');
    }
    await adminMarkDesignSentToPrint(pid, productType);
    if (productType === 'flags') _flagCfg = await loadFlagConfig(pid);
    else _holeCfg = await loadHoleSignConfig(pid);
    renderToolCardStatus(DESIGN_TYPES.find(t => t.productType === productType));
    setReviewPanelStatus(productType, productType === 'flags' ? 'Sent to Prestige Flag.' : '');
  } catch (err) {
    console.error('Failed to send to print', err);
    setStatusValue(productType, status);
    // The Prestige email can succeed even if the status-update RPC that
    // follows it then fails (network blip, RLS hiccup) - the "Send to
    // print"/"Resend to print" button is still what re-triggers this whole
    // function, so a plain "please try again" here would invite staff to
    // re-click and email Prestige a second time for the same order. Callers
    // can still explicitly resend (that's what "Resend to print" is for
    // once status is sent_to_print) - this message just stops a *failed*
    // attempt from being mistaken for one that needs a plain retry.
    if (prestigeSent) {
      setReviewPanelStatus(productType, 'Sent to Prestige Flag, but updating the status failed — refresh and check before sending again to avoid a duplicate order email.');
    } else {
      setReviewPanelStatus(productType, 'Could not send to print — please try again.');
    }
  }
};
