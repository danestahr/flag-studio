import { esc } from './dom-utils.js';

// Each wizard step is its own HTML page, so the project name would otherwise
// flash "—" on every click while it re-fetches from Supabase. Cache it per
// project so a step switch can paint the last-known name immediately.
const NAME_CACHE_KEY = 'gs_sidebar_project_names';

function readNameCache() {
  try { return JSON.parse(sessionStorage.getItem(NAME_CACHE_KEY) || '{}'); } catch { return {}; }
}

// Shared left-nav sidebar: project name, project type, step list.
// Used by both the flag designer (flags.html / flags-variations.html /
// flags-gallery.html) and the hole sign designer (hole-signs.html).
export function renderSidebar(container, { projectType, activeStep, steps, customerSection = false, projectId }) {
  const cachedName = projectId ? readNameCache()[projectId] : null;
  container.innerHTML = `
    <div style="padding:1.25rem 1.5rem 0">
      <div id="projectNameDisplay" style="font-size:15px;font-weight:500;color:var(--black);line-height:1.3">${esc(cachedName || '—')}</div>
      <div style="font-size:11px;color:var(--gray-400);margin-top:3px">${esc(projectType)}</div>
    </div>
    <div class="sdivider" style="margin:.75rem 1.5rem"></div>
    <div class="steps-nav">
      ${steps.map((s, i) => {
        const n = i + 1;
        const state = n === activeStep ? ' active' : (n < activeStep ? ' done' : '');
        return `
        <div class="step-item${state}" id="${s.id}">
          <div class="step-num"><span>${n}</span></div>
          <div><div class="step-label">${esc(s.label)}</div><div class="step-desc">${esc(s.desc)}</div></div>
        </div>`;
      }).join('')}
    </div>
    ${customerSection ? '<div id="customerSection" style="display:none"></div>' : ''}
  `;
  steps.forEach(s => {
    if (s.onClick) container.querySelector('#' + s.id)?.addEventListener('click', s.onClick);
  });
}

export function setSidebarProjectName(name, projectId) {
  const el = document.getElementById('projectNameDisplay');
  if (el) el.textContent = name || '—';
  if (!projectId) return;
  try {
    const cache = readNameCache();
    cache[projectId] = name || '';
    sessionStorage.setItem(NAME_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}
