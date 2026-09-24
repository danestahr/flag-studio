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

// Collapsed, .sidebar sizes itself to fit-content in CSS (hugs the
// icon-only rail) rather than a guessed pixel value — measure the real
// rendered width here and mirror it into --sidebar-w, since other layout
// (canvas-scroll-inner's padding-left, etc.) still needs it as a number.
function syncSidebarWidthVar(container, collapsed) {
  const w = collapsed ? container.getBoundingClientRect().width : 420;
  document.documentElement.style.setProperty('--sidebar-w', w + 'px');
}

function applyCollapsed(container, collapsed) {
  container.classList.toggle('collapsed', collapsed);
  syncSidebarWidthVar(container, collapsed);
  const icon = container.querySelector('#sidebarCollapseBtn i');
  if (icon) icon.className = collapsed ? 'fa-solid fa-angles-right' : 'fa-solid fa-angles-left';
  const btn = container.querySelector('#sidebarCollapseBtn');
  if (btn) btn.title = collapsed ? 'Expand menu' : 'Collapse menu';
  // The canvas panels (canvas-panel.js) only re-fit on a window 'resize'
  // event — a sidebar-width change doesn't fire one on its own, so the
  // freed-up width would sit unused until the user manually resized the
  // window. Nudge them: once now (layout may still be mid CSS transition,
  // so the fit-content measurement above isn't the final value yet either)
  // and once after it settles.
  window.dispatchEvent(new Event('resize'));
  setTimeout(() => {
    syncSidebarWidthVar(container, collapsed);
    window.dispatchEvent(new Event('resize'));
  }, 200);
}

// Shared left-nav sidebar: a frosted-glass tile that floats over the canvas
// at the top-left corner. .sidebar (position:absolute, offset by margin so
// the canvas stays visible in the gap around it) is just a positioning
// shell, laid out as a flex column so it can stack more than one card;
// .sidebar-tile inside it is the actual visible card (semi-transparent +
// backdrop-filter blur, border-radius, overflow:hidden — see style.css for
// why overflow:hidden is required alongside the radius here). When
// logosTile is on, a second .sidebar-tile (#sidebarLogosTile) renders below
// the primary one as its own separate card, not nested inside it — see
// renderLogosTileShell below. The collapse button is a sibling of both
// tiles, not nested inside either, so it can sit outside their rounded/
// clipped right edge without itself being clipped. Both tiles collapse in
// tandem off the same .sidebar.collapsed state (see style.css) — there's
// only ever one collapse control for the whole sidebar, never one per tile.
// Layout inside the tile: a vertical column of step-number circles with
// labels stacked underneath (.sidebar-top > .steps-nav), spaced out with a
// gap rather than connected by a line — sits to the LEFT of the active
// step's title/subtitle/actions (.sidebar-top > #sidebarPanelHeader),
// rather than above it.
// Project name/type render at the top of each wizard's own
// .hs-design-controls panel (design.js / hs/design.js) via
// paintCachedProjectName() + setSidebarProjectName(); the active step's
// title/subtitle/actions (formerly .p1-header.hs-panel-header in the right
// panel) get written into #sidebarPanelHeader below by each step's own
// render function (design.js/variations.js/gallery.js, hs/design.js,
// hs/variations.js, hs/export.js) — not built here, since content differs
// per step and changes whenever that step re-renders.
// Used by both the flag designer (flags.html / flags-variations.html /
// flags-gallery.html) and the hole sign designer (hole-signs.html).
// Collapsible to an icon-only rail (see .sidebar.collapsed in style.css) —
// state persists across the wizard's pages.
export function renderSidebar(container, { activeStep, steps, customerSection = false, logosTile = false, completedSteps = [] }) {
  container.innerHTML = `
    <div class="sidebar-tile">
      <div class="sidebar-top">
        <div class="steps-nav">
          ${steps.map((s, i) => {
            const n = i + 1;
            const done = n < activeStep || completedSteps.includes(n);
            let state = n === activeStep ? ' active' : '';
            if (done) state += ' done';
            return `
            <div class="step-item${state}" id="${s.id}" title="${esc(s.label)}">
              <div class="step-num"><span>${n}</span></div>
              <div class="step-label">${esc(s.label)}</div>
            </div>`;
          }).join('')}
          <button class="step-forward-btn" id="stepsForwardBtn" title="Next step" aria-label="Next step">
            <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
          </button>
        </div>
        <div id="sidebarPanelHeader"></div>
      </div>
      ${customerSection ? '<div id="customerSection" style="display:none"></div>' : ''}
    </div>
    ${logosTile ? '<div class="sidebar-tile" id="sidebarLogosTile"></div>' : ''}
    <button class="sidebar-collapse-btn" id="sidebarCollapseBtn" title="Collapse menu" aria-label="Collapse menu">
      <i class="fa-solid fa-angles-left" aria-hidden="true"></i>
    </button>
  `;
  steps.forEach(s => {
    if (s.onClick) container.querySelector('#' + s.id)?.addEventListener('click', s.onClick);
  });
  // Only shown once the sidebar is collapsed (see .step-forward-btn in
  // style.css) — reads which .step-item is active at click time rather than
  // capturing an index, since goStep() moves the active/done classes around
  // directly instead of re-rendering this component.
  container.querySelector('#stepsForwardBtn')?.addEventListener('click', () => {
    const items = [...container.querySelectorAll('.step-item')];
    const activeIdx = items.findIndex(el => el.classList.contains('active'));
    steps[activeIdx + 1]?.onClick?.();
  });
  container.querySelector('#sidebarCollapseBtn')?.addEventListener('click', () => {
    const next = !container.classList.contains('collapsed');
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch {}
    applyCollapsed(container, next);
  });
  applyCollapsed(container, readCollapsed());
}

// Fills #sidebarLogosTile (see the logosTile option above — a standalone
// .sidebar-tile card in its own right, not a section within the primary
// one) and returns the empty .hslt-items container to fill in — shared by
// Design's template-logo slots and Variations' sponsor logo library so both
// collapse the same way (grid ↔ single-column scroll list). This is a
// separate toggle from the whole-sidebar collapse above: that one hides or
// shows this tile entirely in tandem with the primary tile; this one only
// changes the density of what's already showing. itemsId lets a caller keep
// an existing id (e.g. hsLibStrip) that other code already targets directly.
export function renderLogosTileShell(title, itemsId) {
  const el = document.getElementById('sidebarLogosTile');
  if (!el) return null;
  // Undo the Gallery step's own display:none on this tile (see hs/export.js)
  // — Design/Variations always want it visible, whatever the last step left
  // it as.
  el.style.display = '';
  el.innerHTML = `
    <div class="hslt-header" onclick="this.nextElementSibling.classList.toggle('collapsed')">
      <span class="hslt-title">${esc(title)}</span>
    </div>
    <div class="hslt-items"${itemsId ? ` id="${itemsId}"` : ''}></div>`;
  return el.querySelector('.hslt-items');
}

// Paints the last-known name from cache immediately (before the async
// project fetch resolves) into whichever page currently has a
// #projectNameDisplay element — avoids a "—" flash on every step switch,
// same reasoning as the cache itself (see NAME_CACHE_KEY above).
export function paintCachedProjectName(projectId) {
  const el = document.getElementById('projectNameDisplay');
  if (!el || !projectId) return;
  const cached = readNameCache()[projectId];
  if (cached) el.textContent = cached;
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
