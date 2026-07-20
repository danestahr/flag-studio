import './landing.css';
import './icons.js';
import { requireAuth } from './auth.js';
import { loadProject, loadFlagConfig, loadHoleSignConfig, loadOrderIntake,
         updateProject, deleteProject, upsertCustomerInfo } from './supabase.js';
import { FLAGS } from './data.js';
import { esc } from './dom-utils.js';

await requireAuth();

const pid = new URLSearchParams(window.location.search).get('project');
if (!pid) window.location.href = '/';

const flagCard  = document.getElementById('flagCard');
const holeCard  = document.getElementById('holeCard');
flagCard.href  = `/flags.html?project=${pid}`;
holeCard.href  = `/hole-signs.html?project=${pid}`;

let _project = null;
let _intake = null;

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
