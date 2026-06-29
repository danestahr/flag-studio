import './landing.css';
import { requireAuth } from './auth.js';
import { loadProject, loadFlagConfig, loadHoleSignConfig, loadOrderIntake,
         updateProject, deleteProject } from './supabase.js';

await requireAuth();

const pid = new URLSearchParams(window.location.search).get('project');
if (!pid) window.location.href = '/';

const flagCard  = document.getElementById('flagCard');
const holeCard  = document.getElementById('holeCard');
const ciLink    = document.getElementById('customerInfoLink');
flagCard.href  = `/flags.html?project=${pid}`;
holeCard.href  = `/hole-signs.html?project=${pid}`;
ciLink.href    = `/customer.html?project=${pid}`;

async function init() {
  try {
    const [project, flagCfg, holeCfg, intake] = await Promise.all([
      loadProject(pid),
      loadFlagConfig(pid).catch(() => null),
      loadHoleSignConfig(pid).catch(() => null),
      loadOrderIntake(pid).catch(() => null),
    ]);

    const nameInput = document.getElementById('projectNameInput');
    nameInput.value = project.name || '';
    nameInput.addEventListener('input', e => {
      updateProject(pid, { name: e.target.value || null }).catch(() => {});
    });

    setStatus('flagStatus', flagCfg, intake);
    setStatus('holeStatus', holeCfg, intake);

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

// ── Delete modal ───────────────────────────────────────────
const deleteModal = document.getElementById('deleteModal');
const deleteInput = document.getElementById('deleteConfirmInput');
const deleteBtn   = document.getElementById('deleteConfirmBtn');

deleteInput.addEventListener('input', () => {
  deleteBtn.disabled = deleteInput.value.trim().toLowerCase() !== 'delete';
});

window.openDeleteModal = function() {
  deleteInput.value = '';
  deleteBtn.disabled = true;
  deleteModal.style.display = 'flex';
  deleteInput.focus();
};

window.closeDeleteModal = function() {
  deleteModal.style.display = 'none';
};

window.confirmDelete = async function() {
  if (deleteInput.value.trim().toLowerCase() !== 'delete') return;
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
