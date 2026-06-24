import './landing.css';
import { requireAuth } from './auth.js';
import { loadProject, loadFlagConfig, loadHoleSignConfig, loadOrderIntake,
         updateProject } from './supabase.js';

await requireAuth();

const pid = new URLSearchParams(window.location.search).get('project');
if (!pid) window.location.href = '/';

const flagCard  = document.getElementById('flagCard');
const holeCard  = document.getElementById('holeCard');
flagCard.href = `/flags.html?project=${pid}`;
holeCard.href = `/hole-signs.html?project=${pid}`;

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
