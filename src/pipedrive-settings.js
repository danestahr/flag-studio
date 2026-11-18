import './landing.css';
import './icons.js';
import { requireAuth, isStaffOrAdmin } from './auth.js';
import { pipedriveListPipelines, loadPipedriveStageMap, savePipedriveStageMap } from './supabase.js';
import { esc } from './dom-utils.js';

const session = await requireAuth();
// UI-convenience gate only - pipedrive_stage_map's RLS and the edge function
// are what actually keep non-staff out.
if (!(await isStaffOrAdmin(session))) window.location.href = '/';

const PRODUCTS = [
  { productType: 'flags', label: 'Flags' },
  { productType: 'hole-signs', label: 'Hole Signs' },
];
// 'not_started' (no design row yet) plus the six flag_config.status / hole_sign_config.status values. Labels here are
// the granular ones (STATUS_LABEL collapses draft/submitted), since each can map
// to its own stage.
const STATUSES = [
  { value: 'not_started', label: 'Not started' },
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Submitted for review' },
  { value: 'needs_changes', label: 'Changes requested' },
  { value: 'proof_sent', label: 'Proof sent to client' },
  { value: 'approved', label: 'Approved by client' },
  { value: 'sent_to_print', label: 'Sent to print' },
];

const form = document.getElementById('pdForm');
const sections = document.getElementById('pdSections');
const errEl = document.getElementById('pdError');
const noticeEl = document.getElementById('pdNotice');
const saveBtn = document.getElementById('pdSaveBtn');

let pipelines = [];
let saved = []; // rows currently in the DB

function showError(msg) { errEl.textContent = msg; errEl.style.display = msg ? '' : 'none'; }
function showNotice(msg) { noticeEl.textContent = msg; noticeEl.style.display = msg ? '' : 'none'; }

const optVal = (pipelineId, stageId) => `${pipelineId}:${stageId}`;

function stageOptions(selected) {
  const known = new Set(pipelines.flatMap(p => p.stages.map(s => optVal(p.id, s.id))));
  const groups = pipelines.map(p => `
    <optgroup label="${esc(p.name)}">
      ${p.stages.map(s => {
        const v = optVal(p.id, s.id);
        return `<option value="${v}"${v === selected ? ' selected' : ''}>${esc(s.name)}</option>`;
      }).join('')}
    </optgroup>`).join('');
  // A mapping to a stage that was since deleted in Pipedrive stays visible (and
  // is kept on save) rather than silently reading as "not mapped".
  const orphan = selected && !known.has(selected)
    ? `<option value="${selected}" selected>Stage #${esc(selected.split(':')[1])} (no longer in Pipedrive)</option>` : '';
  return `<option value=""${selected ? '' : ' selected'}>Don't move the deal</option>${orphan}${groups}`;
}

function render() {
  sections.innerHTML = PRODUCTS.map(p => `
    <div class="ci-section">
      <h2 style="font-size:1rem;margin:0 0 .75rem">${esc(p.label)}</h2>
      ${STATUSES.map(st => {
        const row = saved.find(r => r.product_type === p.productType && r.studio_status === st.value);
        const sel = row ? optVal(row.pipeline_id, row.stage_id) : '';
        return `
        <div class="ci-row" style="align-items:center;margin-bottom:.5rem">
          <label class="ci-label" style="flex:1;margin:0" for="pd-${p.productType}-${st.value}">${esc(st.label)}</label>
          <select class="ci-input" style="flex:1.4" id="pd-${p.productType}-${st.value}"
                  data-product="${p.productType}" data-status="${st.value}">${stageOptions(sel)}</select>
        </div>`;
      }).join('')}
    </div>`).join('');
}

async function init() {
  try {
    const [pl, map] = await Promise.all([pipedriveListPipelines(), loadPipedriveStageMap()]);
    pipelines = pl.pipelines;
    saved = map;
    render();
    form.style.display = '';
  } catch (err) {
    showError(`Couldn't load Pipedrive pipelines: ${err.message}`);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(''); showNotice('');
  const rows = []; const unmapped = [];
  sections.querySelectorAll('select').forEach(sel => {
    const key = { product_type: sel.dataset.product, studio_status: sel.dataset.status };
    if (!sel.value) { unmapped.push(key); return; }
    const [pipeline_id, stage_id] = sel.value.split(':').map(Number);
    rows.push({ ...key, pipeline_id, stage_id });
  });
  saveBtn.disabled = true;
  try {
    await savePipedriveStageMap(rows, unmapped);
    saved = rows;
    showNotice('Saved.');
  } catch (err) {
    showError(`Couldn't save: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
  }
});

init();
