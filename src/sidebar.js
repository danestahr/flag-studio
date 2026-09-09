import { esc } from './dom-utils.js';

// Each wizard step is its own HTML page, so the project name would otherwise
// flash "—" on every click while it re-fetches from Supabase. Cache it per
// project so a step switch can paint the last-known name immediately.
const NAME_CACHE_KEY = 'gs_sidebar_project_names';

// Collapse state is a UI preference, not per-project data, and each wizard
// step is a separate page load — persist across page/tab so it stays put
// while navigating steps.
const COLLAPSE_KEY = 'gs_sidebar_collapsed';

function readNameCache() {
  try { return JSON.parse(sessionStorage.getItem(NAME_CACHE_KEY) || '{}'); } catch { return {}; }
}

function readCollapsed() {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
}

function applyCollapsed(container, collapsed) {
  container.classList.toggle('collapsed', collapsed);
  document.documentElement.style.setProperty('--sidebar-w', collapsed ? '68px' : '240px');
  const icon = container.querySelector('#sidebarCollapseBtn i');
  if (icon) icon.className = collapsed ? 'fa-solid fa-angles-right' : 'fa-solid fa-angles-left';
  const btn = container.querySelector('#sidebarCollapseBtn');
  if (btn) btn.title = collapsed ? 'Expand menu' : 'Collapse menu';
  // The canvas panels (canvas-panel.js) only re-fit on a window 'resize'
  // event — a sidebar-width change doesn't fire one on its own, so the
  // freed-up width would sit unused until the user manually resized the
  // window. Nudge them: once now (layout may still be mid CSS transition)
  // and once after it settles.
  window.dispatchEvent(new Event('resize'));
  setTimeout(() => window.dispatchEvent(new Event('resize')), 200);
}

// Shared left-nav sidebar: project name, project type, step list.
// Used by both the flag designer (flags.html / flags-variations.html /
// flags-gallery.html) and the hole sign designer (hole-signs.html).
// Collapsible to a numbers-only rail (see .sidebar.collapsed in style.css)
// to free up canvas real estate — state persists across the wizard's pages.
export function renderSidebar(container, { projectType, activeStep, steps, customerSection = false, projectId }) {
  const cachedName = projectId ? readNameCache()[projectId] : null;
  container.innerHTML = `
    <a href="/" class="sidebar-back-link"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Projects</a>
    <div class="sidebar-header">
      <button class="sidebar-collapse-btn" id="sidebarCollapseBtn" title="Collapse menu" aria-label="Collapse menu">
        <i class="fa-solid fa-angles-left" aria-hidden="true"></i>
      </button>
      <div class="sidebar-id" style="padding:1.25rem 68px 0 1.5rem">
        <div id="projectNameDisplay" style="font-size:15px;font-weight:500;color:var(--black);line-height:1.3">${esc(cachedName || '—')}</div>
        <div style="font-size:11px;color:var(--gray-400);margin-top:3px">${esc(projectType)}</div>
      </div>
    </div>
    <div class="sdivider" style="margin:.75rem 1.5rem"></div>
    <div class="steps-nav">
      ${steps.map((s, i) => {
        const n = i + 1;
        const state = n === activeStep ? ' active' : (n < activeStep ? ' done' : '');
        return `
        <div class="step-item${state}" id="${s.id}" title="${esc(s.label)}">
          <div class="step-num"><span>${n}</span></div>
          <div class="step-text"><div class="step-label">${esc(s.label)}</div><div class="step-desc">${esc(s.desc)}</div></div>
        </div>`;
      }).join('')}
    </div>
    ${customerSection ? '<div id="customerSection" style="display:none"></div>' : ''}
  `;
  steps.forEach(s => {
    if (s.onClick) container.querySelector('#' + s.id)?.addEventListener('click', s.onClick);
  });
  container.querySelector('#sidebarCollapseBtn')?.addEventListener('click', () => {
    const next = !container.classList.contains('collapsed');
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch {}
    applyCollapsed(container, next);
  });
  applyCollapsed(container, readCollapsed());
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
