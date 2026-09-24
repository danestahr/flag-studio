import '../style.css';
import '../icons.js';
import { requireAuth, isStaffOrAdmin } from '../auth.js';

const session = await requireAuth();

import { S, setDragLogoId, DEFAULT_COLORS, addCustomColor, allSwatches, navigateTo, mergeLibraries } from '../state.js';
import { FLAGS } from '../data.js';
import { getFlag, applyColors, showGsTagVariant, resolveColors } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  createProject, updateProject, loadProject,
  saveFlagConfig, loadFlagConfig,
  loadLogosForProject, deleteLogo,
  uploadUserLogo, listUserLogos, deleteUserLogo,
  loadOrderIntake,
} from '../supabase.js';
import { initDropZones, renderDropZones, hideZoneToolbar } from './drop-zones.js';
import { addFlagTextLayer, renderFlagTextOverlays } from './text-layers.js';
import { addFlagImageLayer, renderFlagImageOverlays } from './image-layers.js';
import { eyedropperBtn, pickEyedropperColor } from '../eyedropper.js';
import { esc } from '../dom-utils.js';
import { logoThumbHtml, downloadLogo } from '../media-utils.js';
import { renderSidebar, setSidebarProjectName, paintCachedProjectName } from '../sidebar.js';
import { renderCanvasPanel } from '../canvas-panel.js';
import { refreshImageBoxClips } from '../image-box.js';

let isDirty = false;
let _baseZoom = 100;
let _flagExpZoom = 75;
function safeHex(h) { return /^#[0-9A-Fa-f]{3,6}$/.test(h) ? h : '#cccccc'; }

// Which Design-step submenu is drilled into — null shows the row list
// (Style & Colors / Hole Numbers / Text / Images), mirroring hs/design.js's
// UI.hsMenu pattern. Purely ephemeral UI state, not persisted.
let p1Menu = null;

renderCanvasPanel(document.getElementById('flagExpCanvasPanel'), {
  panelId: 'flagExpCanvasPanel',
  scrollId: 'flagExpScroll',
  wrapId: 'flagExpZoomWrap',
  zoomValueId: 'flagExpZoomValue',
  zoomResetId: 'flagExpZoomReset',
  aspect: 7519 / 4669,
  getZoom: () => _flagExpZoom,
  setZoom: v => { _flagExpZoom = v; },
  canvasContentHtml: '<div class="flag-exp-preview" id="flagExpPreview"><div class="flag-exp-placeholder">Select a style →</div></div>',
});

async function ensureProject() {
  if (S.projectId) return;
  S.projectId = await createProject(S.projectName);
  history.replaceState(null, '', '?project=' + S.projectId);
}

function markDirty() {
  isDirty = true;
  document.getElementById('saveDraftBtn')?.classList.add('dirty');
  ensureProject().catch(console.error);
}
function markClean() {
  isDirty = false;
  document.getElementById('saveDraftBtn')?.classList.remove('dirty');
}

initDropZones({
  ensureProject,
  markDirty,
  onLibraryUpdated: () => { renderLib(); },
});

// ── Internal step nav (steps 1–3 within this page) ────────

function goStep(n) {
  // No visible Save Draft button — every step change persists instead.
  if (S.projectId) window.saveDraft?.().catch(() => {});
  document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('visible', i === n - 1));
  document.querySelectorAll('.step-item').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i === n - 1) s.classList.add('active');
    else if (i < n - 1) s.classList.add('done');
  });
  if (n === 1) renderFlagP1Controls();
  if (n === 2) setupColors();
  if (n === 3) setupLibrary();
  window.scrollTo(0, 0);
}
window.goStep = goStep;
window.tryGoStep = (n) => goStep(n);

// ── Step 1: Design style ───────────────────────────────────

function renderFlagGrid() {
  document.getElementById('flagGrid').innerHTML = FLAGS.map(f => `
    <div class="flag-card" id="fc-${f.id}" onclick="pickFlag('${f.id}')">
      <div class="flag-card-preview"><svg viewBox="${f.viewBox || '0 0 7519 4669'}" preserveAspectRatio="xMidYMid meet">${f.svgContent}</svg></div>
      <div class="flag-card-name">${f.name}</div>
    </div>`).join('');
}

function showFlagExpanded(id) {
  const flag = FLAGS.find(f => f.id === id);
  if (!flag) return;
  document.querySelectorAll('.flag-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('fc-' + id)?.classList.add('selected');
  refreshFlagExpanded();
}

function refreshFlagExpanded() {
  const preview = document.getElementById('flagExpPreview');
  if (!preview) return;
  const flag = getFlag();
  if (!flag) {
    preview.innerHTML = '<div class="flag-exp-placeholder">Select a style →</div>';
    return;
  }
  preview.innerHTML = `<svg viewBox="${flag.viewBox || '0 0 7519 4669'}" width="100%" height="100%">${flag.svgContent}</svg>`;
  const svg = preview.querySelector('svg');
  applyColors(svg, S.colors, flag.noColors, flag);
  if (S.gsTag) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    showGsTagVariant(svg, 'front', S.gsTagMode, resolveColors(S.colors, flag)[keyZone]);
  }
  // Template-level Text/Images layers (Step 1's own rows — see the submenu
  // below) — rebuilt on top of the fresh SVG every time it's replaced above,
  // same as any other Step-1 canvas overlay in this app.
  renderFlagTextOverlays('flagExpPreview', S.textLayers, onFlagLayersChange);
  renderFlagImageOverlays('flagExpPreview', S.imageLayers, onFlagLayersChange);
}

function onFlagLayersChange() { markDirty(); }

window.pickFlag = function (id) {
  if (S.flagId === id) return;
  S.flagId = id;
  S.logoLayout = 'single';
  showFlagExpanded(id);
  renderP1Colors();
  checkStep1();
  syncSidebar();
  markDirty();
};

// ── Step 1 submenu (Style & Colors / Hole Numbers / Text / Images) ─────────
// Mirrors the row-list + drill-in section pattern in hs/design.js
// (renderDesignMenuList/renderDesignSection), reimplemented locally rather
// than imported since the two designers' sections have no shared logic —
// only the row-list markup/CSS classes are shared.

const FLAG_P1_MENU_TITLES = {
  colors: 'Style & Colors',
  holeNumbers: 'Hole Numbers',
};

function flagP1MenuRow(key, label, hint, icon) {
  const iconHtml = icon ? `<i class="fa-solid ${icon} hs-menu-row-icon" aria-hidden="true"></i>` : '';
  return `
    <button class="hs-menu-row" onclick="openFlagP1Menu('${key}')">
      ${iconHtml}<span class="hs-menu-row-label">${label}</span>
      <span class="hs-menu-row-hint">${hint}</span>
      <span class="hs-menu-row-chev"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span>
    </button>`;
}

// An "add new" row — matches hs/design.js's addRow tile style (dashed,
// accent-colored, no chevron/hint) instead of menuRow's drill-in look, since
// Text/Images perform the add immediately on click rather than opening a
// section. `onclick` is invoked directly, same as hs's Text/Images rows.
function flagP1AddRow(label, onclick, icon) {
  const iconHtml = icon ? `<i class="fa-solid ${icon} hs-menu-row-icon" aria-hidden="true"></i>` : '';
  return `
    <button class="hs-menu-row hs-menu-row-add" onclick="${onclick}">
      ${iconHtml}<span class="hs-menu-row-label">${label}</span>
    </button>`;
}

function flagP1SectionHeader(key) {
  return `
    <div class="hs-menu-section-header">
      <button class="hs-menu-back" onclick="closeFlagP1Menu()"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back</button>
      <span class="hs-menu-section-title">${FLAG_P1_MENU_TITLES[key] || ''}</span>
    </div>`;
}

function renderFlagP1MenuList() {
  const flag = getFlag();
  const colorHint = flag && !flag.noColors
    ? `<span class="hs-menu-swatch" style="background:${safeHex(S.colors['zone-primary'] || '#FFFFFF')}"></span><span class="hs-menu-swatch" style="background:${safeHex(S.colors['zone-secondary'] || '#111110')}"></span>`
    : '';
  const rows = [
    flagP1MenuRow('colors', 'Style & Colors', colorHint, 'fa-palette'),
    flagP1MenuRow('holeNumbers', 'Hole Numbers', 'Coming soon', 'fa-hashtag'),
    flagP1AddRow('Text', 'addFlagP1Text()', 'fa-font'),
    flagP1AddRow('Images', 'addFlagP1Image()', 'fa-image'),
  ];
  return `<div class="hs-menu-list">${rows.join('')}</div>`;
}

// Text/Images add straight to the canvas (S.textLayers/S.imageLayers) and
// stay on the row list — unlike "Style & Colors"/"Hole Numbers" there's no
// section to drill into; the new layer's own on-canvas toolbar/handles
// (flags/text-layers.js, flags/image-layers.js) are what gets edited next,
// same as hs/design.js's addTextLayer()/addTplImage().
window.addFlagP1Text = function () {
  addFlagTextLayer(S.textLayers, 'flagExpPreview', onFlagLayersChange);
};
window.addFlagP1Image = function () {
  addFlagImageLayer(S.imageLayers, 'flagExpPreview', onFlagLayersChange);
};

function buildColorsSection() {
  return `
    ${flagP1SectionHeader('colors')}
    <div class="p1zones p1-section" id="p1colorZones"></div>
    <div id="gsTagSection" class="p1-section p1-section-divided">
      <div class="zlabel">GolfStatus Tag</div>
      <div class="gs-tag-row">
        <label class="gs-tag-label">
          <input type="checkbox" id="gsTagCheck" onchange="toggleGsTag(this.checked)" class="gs-toggle-input">
          <span class="gs-toggle-switch"></span>
          <span class="gs-toggle-text" id="gsTagToggleText">Off</span>
        </label>
        <div class="gs-mode-wrap" id="gsTagModeWrap" style="display:none">
          <button class="gs-mode-btn active" id="gsMode-auto" onclick="setGsTagMode('auto')">Auto</button>
          <button class="gs-mode-btn" id="gsMode-dark" onclick="setGsTagMode('dark')">Black</button>
          <button class="gs-mode-btn" id="gsMode-light" onclick="setGsTagMode('light')">White</button>
        </div>
      </div>
    </div>
    <div id="flagStylesSection" class="p1-section">
      <div class="zlabel">Flag Styles</div>
      <div class="flag-grid" id="flagGrid"></div>
    </div>`;
}

// Placeholder body for a submenu row whose functionality isn't built yet
// (Hole Numbers awaits more requirements — see the CLAUDE.md note on the
// planned per-hole workflow).
function buildComingSoonSection(key, note) {
  return `
    ${flagP1SectionHeader(key)}
    <div class="p1-section">
      <div style="font-size:13px;color:var(--gray-400)">${note}</div>
    </div>`;
}

function renderFlagP1Controls() {
  const body = document.getElementById('flagP1ControlsBody');
  if (!body) return;
  if (p1Menu === 'colors') body.innerHTML = buildColorsSection();
  else if (p1Menu === 'holeNumbers') body.innerHTML = buildComingSoonSection('holeNumbers', 'Per-hole number options are coming soon.');
  else body.innerHTML = renderFlagP1MenuList();
  body.classList.remove('hs-controls-enter');
  void body.offsetWidth;
  body.classList.add('hs-controls-enter');
  if (p1Menu === 'colors') {
    renderFlagGrid();
    renderP1Colors();
    syncGsTagUI();
    refreshFlagPreviews();
    checkStep1();
  }
}

window.openFlagP1Menu = function (key) { p1Menu = key; renderFlagP1Controls(); };
window.closeFlagP1Menu = function () { p1Menu = null; renderFlagP1Controls(); };

// Custom-hex row (always visible, not a popover) + preset swatch grid for a
// Step-1 zone. The leading swatch is a real <input type=color> once a color
// is set (click it to reopen the native picker); before that it's a
// decorative rainbow/plus circle that opens a hidden color input.
function p1ZonePickerHtml(zid, hex) {
  const swatch = hex
    ? `<input type="color" id="p1cn-${zid}" value="${hex}" oninput="p1CSync('${zid}',this.value)" onchange="p1CApply('${zid}')">`
    : `<div class="csw">
       <input type="color" id="p1cn-${zid}" value="#1A4A2E" oninput="p1CSync('${zid}',this.value)" onchange="p1CApply('${zid}')" style="position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:none;padding:0">
     </div>`;
  return `<div class="ve-custom-row">
      ${swatch}
      <input type="text" class="hexin" id="p1ch-${zid}" value="${hex || ''}" maxlength="7" placeholder="#000000" oninput="p1CSyncN('${zid}',this.value)" onkeydown="if(event.key==='Enter')p1CApply('${zid}')">
      ${eyedropperBtn(`p1Eyedrop('${zid}')`)}
    </div>
    <div class="swatch-grid" id="p1sg-${zid}">
      ${allSwatches().map(c => `<div class="swatch ${c.hex === '#FFFFFF' ? 'ws' : ''} ${hex === c.hex ? 'sel' : ''}"
        style="background:${c.hex}" title="${c.name}"
        onclick="pickColor('${zid}','${c.hex}')"></div>`).join('')}
    </div>`;
}

function borderMatchLabel(flag) {
  return flag.colorZones.some(z => z.id === 'zone-secondary') ? 'Secondary Color' : 'Primary Color';
}

function borderToggleHtml(flag) {
  const matches = !('zone-border' in S.colors);
  return `<label class="gs-tag-label" style="margin-bottom:8px">
    <input type="checkbox" class="gs-toggle-input" ${matches ? 'checked' : ''} onchange="toggleBorderMatch(this.checked)">
    <span class="gs-toggle-switch"></span>
    <span class="gs-toggle-text">Match ${borderMatchLabel(flag)}</span>
  </label>`;
}

function renderP1Colors() {
  const container = document.getElementById('p1colorZones');
  if (!container) return;
  const flag = getFlag();

  if (flag?.noColors) {
    container.innerHTML = '<div class="p1zone"><div class="zlabel" style="color:var(--gray-400);font-style:italic">Colors are fixed for this template</div></div>';
    return;
  }

  // Always show pickers — use flag's zones when available, else generic defaults
  const zones = flag?.colorZones || [
    { id: 'zone-primary', label: 'Primary Color' },
    { id: 'zone-secondary', label: 'Secondary Color' },
  ];

  container.innerHTML = zones.map(z => {
    const label = z.label || (z.id === 'zone-primary' ? 'Primary Color' : 'Color');
    if (z.id === 'zone-border') {
      const matches = !('zone-border' in S.colors);
      const body = matches ? '' : p1ZonePickerHtml('zone-border', S.colors['zone-border']);
      return `<div class="p1zone"><div class="zlabel">${label}</div>${borderToggleHtml(flag)}${body}</div>`;
    }
    return `<div class="p1zone"><div class="zlabel">${label}</div>${p1ZonePickerHtml(z.id, S.colors[z.id])}</div>`;
  }).join('');
}

window.toggleGsTag = function (checked) {
  S.gsTag = checked;
  document.getElementById('gsTagModeWrap').style.display = checked ? 'flex' : 'none';
  const text = document.getElementById('gsTagToggleText');
  if (text) text.textContent = checked ? 'On' : 'Off';
  refreshFlagPreviews();
  refreshColorPrev();
  markDirty();
};

window.setGsTagMode = function (mode) {
  S.gsTagMode = mode;
  document.querySelectorAll('.gs-mode-btn').forEach(b => b.classList.toggle('active', b.id === 'gsMode-' + mode));
  refreshFlagPreviews();
  refreshColorPrev();
  markDirty();
};

function syncGsTagUI() {
  const check = document.getElementById('gsTagCheck');
  if (check) check.checked = S.gsTag;
  const text = document.getElementById('gsTagToggleText');
  if (text) text.textContent = S.gsTag ? 'On' : 'Off';
  const wrap = document.getElementById('gsTagModeWrap');
  if (wrap) wrap.style.display = S.gsTag ? 'flex' : 'none';
  document.querySelectorAll('.gs-mode-btn').forEach(b => b.classList.toggle('active', b.id === 'gsMode-' + (S.gsTagMode || 'auto')));
}

function refreshFlagPreviews() {
  FLAGS.forEach(f => {
    const card = document.getElementById('fc-' + f.id);
    if (!card) return;
    const svg = card.querySelector('svg');
    if (!svg) return;
    applyColors(svg, S.colors, f.noColors, f);
    if (S.gsTag) {
      const keyZone = f.tagKeyZone || 'zone-primary';
      showGsTagVariant(svg, 'front', S.gsTagMode, resolveColors(S.colors, f)[keyZone]);
    }
  });
}

function checkStep1() {
  // Colors are optional — resolveColors() fills unpicked zones with defaults,
  // so only a style selection is required to continue.
  const flag = getFlag();
  const btn = document.getElementById('s1next');
  if (btn) btn.disabled = !flag;
  const hint = document.getElementById('s1hint');
  if (hint) hint.textContent = flag ? '' : 'Pick a style';
  const gsTagSection = document.getElementById('gsTagSection');
  if (gsTagSection) gsTagSection.style.display = flag?.noGsTag ? 'none' : '';
}

window.p1CSync  = (zid, h) => { const inp = document.getElementById('p1ch-' + zid); if (inp) inp.value = h; };
window.p1CSyncN = (zid, h) => { const c = h.startsWith('#') ? h : '#' + h; if (/^#[0-9A-Fa-f]{6}$/.test(c)) { const inp = document.getElementById('p1cn-' + zid); if (inp) inp.value = c; } };
window.p1CApply = function (zid) {
  const h = document.getElementById('p1ch-' + zid).value;
  const c = h.startsWith('#') ? h : '#' + h;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  pickColor(zid, c);
};
window.p1Eyedrop = async function (zid) {
  const hex = await pickEyedropperColor();
  if (hex) pickColor(zid, hex);
};

// ── Step 2: Colors ─────────────────────────────────────────

function s2ZonePickerHtml(zid) {
  const hex = S.colors[zid];
  const swatch = hex
    ? `<input type="color" id="cn-${zid}" value="${hex}" oninput="cSync('${zid}',this.value)" onchange="cApply('${zid}')">`
    : `<div class="csw">
       <input type="color" id="cn-${zid}" value="#1A4A2E" oninput="cSync('${zid}',this.value)" onchange="cApply('${zid}')" style="position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:none;padding:0">
     </div>`;
  return `<div class="ve-custom-row">
      ${swatch}
      <input type="text" class="hexin" id="ch-${zid}" value="${hex || ''}" maxlength="7" placeholder="#000000" oninput="cSyncN('${zid}',this.value)" onkeydown="if(event.key==='Enter')cApply('${zid}')">
      ${eyedropperBtn(`cEyedrop('${zid}')`)}
    </div>
    <div class="swatch-grid" id="sg-${zid}">
      ${allSwatches().map(c => `<div class="swatch ${c.hex === '#FFFFFF' ? 'ws' : ''} ${hex === c.hex ? 'sel' : ''}"
        style="background:${c.hex}" data-hex="${c.hex}" title="${c.name}"
        onclick="pickColor('${zid}','${c.hex}')"></div>`).join('')}
    </div>`;
}

window.toggleBorderMatch = function (matches) {
  if (matches) {
    delete S.colors['zone-border'];
  } else if (!('zone-border' in S.colors)) {
    S.colors['zone-border'] = null; // independent mode — nothing chosen yet, show the picker
  }
  renderP1Colors();
  setupColors();
  refreshFlagPreviews();
  refreshColorPrev();
  checkStep1();
  checkColors();
  syncSidebar();
  markDirty();
};

function setupColors() {
  const flag = getFlag();
  if (!flag) return;
  if (flag.noColors) {
    document.getElementById('colorZones').innerHTML = '<div style="color:var(--gray-400);font-size:13px;padding:.5rem 0">Colors are fixed for this template — nothing to configure.</div>';
    document.getElementById('colorPrevName').textContent = flag.name;
    refreshColorPrev();
    checkColors();
    return;
  }
  document.getElementById('colorZones').innerHTML = flag.colorZones.map(z => {
    const label = z.label || (z.id === 'zone-primary' ? 'Primary Color' : 'Color');
    if (z.id === 'zone-border') {
      const matches = !('zone-border' in S.colors);
      const body = matches ? '' : s2ZonePickerHtml('zone-border');
      return `<div class="p1zone"><div class="zlabel">${label}</div>${borderToggleHtml(flag)}${body}</div>`;
    }
    return `<div class="p1zone"><div class="zlabel">${label}</div>${s2ZonePickerHtml(z.id)}</div>`;
  }).join('');
  document.getElementById('colorPrevName').textContent = flag.name;
  refreshColorPrev();
  checkColors();
}

window.pickColor = function (zid, hex) {
  S.colors[zid] = hex;
  addCustomColor(hex);
  // Full re-render (not just toggling .sel on the changed swatch) since the
  // border zone's preview can depend on whichever zone was just picked.
  renderP1Colors();
  setupColors();
  refreshFlagPreviews();
  checkStep1();
  syncSidebar();
  markDirty();
};

function refreshColorPrev() {
  const flag = getFlag();
  if (!flag) return;
  const box = document.getElementById('colorPrev');
  if (!box) return;
  box.innerHTML = `<svg viewBox="${flag.viewBox || '0 0 7519 4669'}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${flag.svgContent}</svg>`;
  const svg = box.querySelector('svg');
  applyColors(svg, S.colors, flag.noColors, flag);
  if (S.gsTag) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    showGsTagVariant(svg, 'front', S.gsTagMode, resolveColors(S.colors, flag)[keyZone]);
  }
  refreshFlagExpanded();
}

function checkColors() {
  // Colors are optional — resolveColors() fills unpicked zones with defaults.
  const flag = getFlag();
  const btn = document.getElementById('s2next');
  if (btn) btn.disabled = !flag;
}

window.cSync  = (z, h) => { const inp = document.getElementById('ch-' + z); if (inp) inp.value = h; };
window.cSyncN = (z, h) => { const c = h.startsWith('#') ? h : '#' + h; if (/^#[0-9A-Fa-f]{6}$/.test(c)) { const inp = document.getElementById('cn-' + z); if (inp) inp.value = c; } };
window.cApply = function (z) {
  const h = document.getElementById('ch-' + z).value;
  const c = h.startsWith('#') ? h : '#' + h;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  pickColor(z, c);
};
window.cEyedrop = async function (z) {
  const hex = await pickEyedropperColor();
  if (hex) pickColor(z, hex);
};

// Native <input type=color> pickers only reliably fire `change` once their
// own popover fully closes, and that's browser-dependent — so as a backstop,
// commit any hex text field that's been edited (via oninput while dragging
// in the picker) but hasn't been applied yet the moment the user clicks
// anywhere outside that zone's own picker block. Keeps the swatch/chip from
// ever silently lagging behind what's actually in the text field.
document.addEventListener('click', e => {
  document.querySelectorAll('.p1zone .hexin').forEach(input => {
    const zoneEl = input.closest('.p1zone');
    if (zoneEl?.contains(e.target)) return;
    const zid = input.id.replace(/^p1ch-|^ch-/, '');
    const h = input.value;
    const c = h.startsWith('#') ? h : '#' + h;
    if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
    if (c.toLowerCase() === (S.colors[zid] || '').toLowerCase()) return;
    if (input.id.startsWith('p1ch-')) window.p1CApply(zid); else window.cApply(zid);
  });
}, true);

// ── Step 3: Logo library ───────────────────────────────────

// Every upload here becomes a shared logo (user_logos), reusable across all
// of this user's projects — there's a single "Uploaded logos" section, not a
// separate project-only vs. shared split. Logos already on the project from
// before this change (project_logos rows, loaded alongside the shared ones
// in mergeLibraries()) keep showing here too and stay deletable via
// deleteLogo — only a newly uploaded logo is tagged `shared: true`.
window.handleUpload = async function (e) {
  const files = Array.from(e.target.files);
  e.target.value = '';
  for (const file of files) {
    const localSrc = await new Promise(res => {
      const r = new FileReader();
      r.onload = ev => res(ev.target.result);
      r.readAsDataURL(file);
    });
    const tempId = 'tmp-' + Date.now();
    S.library.push({ id: tempId, name: file.name.replace(/\.[^.]+$/, ''), src: localSrc, uploading: true });
    renderLib();
    syncSidebar();
    try {
      const logo = await uploadUserLogo(file);
      logo.shared = true;
      const idx = S.library.findIndex(l => l.id === tempId);
      if (idx !== -1) S.library[idx] = logo;
    } catch (err) {
      console.error('Logo upload failed', err);
      S.library = S.library.filter(l => l.id !== tempId);
    }
    renderLib();
    syncSidebar();
  }
};

function renderLib() {
  const g = document.getElementById('libGrid');
  if (!g) return;
  if (!S.library.length) { g.innerHTML = '<div class="lib-empty">No logos yet</div>'; return; }
  g.innerHTML = S.library.map(l => `
    <div class="lib-item ${l.uploading ? 'uploading' : ''}" id="li-${l.id}" draggable="${!l.uploading}"
      ondragstart="dragStart(event,'${l.id}')" ondragend="dragEnd('${l.id}')">
      ${logoThumbHtml(l.src, l.name)}
      <div class="lib-item-name">${l.uploading ? '<i class="fa-solid fa-upload" aria-hidden="true"></i> uploading…' : l.name}</div>
      ${l.uploading ? '' : `<button class="lib-dl" onclick="downloadLibItem('${l.id}')"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`}
      ${l.uploading ? '' : `<button class="lib-del" onclick="delLogo('${l.id}')"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`}
    </div>`).join('');
}

window.downloadLibItem = function (id) {
  const logo = S.library.find(l => l.id === id);
  if (logo) downloadLogo(logo.src, logo.name);
};

window.delLogo = async function (id) {
  const logo = S.library.find(l => l.id === id);
  S.library = S.library.filter(l => l.id !== id);
  Object.keys(S.baseAssignment).forEach(z => {
    const val = S.baseAssignment[z];
    const lid = typeof val === 'string' ? val : val?.id;
    if (lid === id) delete S.baseAssignment[z];
  });
  hideZoneToolbar();
  renderLib();
  renderDropZones('baseWrap', 'baseSvg', S.baseAssignment);
  syncSidebar();
  if (logo?.storagePath) {
    try {
      await (logo.shared ? deleteUserLogo(logo.storagePath, logo.id) : deleteLogo(logo.storagePath, logo.id));
    } catch (err) { console.error('Storage delete failed', err); }
  }
};

window.dragStart = function (e, id) {
  setDragLogoId(id);
  e.dataTransfer.effectAllowed = 'copy';
  document.getElementById('li-' + id)?.classList.add('dragging');
};
window.dragEnd = function (id) { document.getElementById('li-' + id)?.classList.remove('dragging'); };

function setupLibrary() {
  const flag = getFlag();
  if (!flag) return;
  renderCanvasPanel(document.getElementById('baseCanvasPanel'), {
    panelId: 'baseCanvasPanel',
    scrollId: 'baseCanvasScroll',
    wrapId: 'baseZoomWrap',
    zoomValueId: 'baseZoomValue',
    zoomResetId: 'baseZoomReset',
    aspect: 7519 / 4669,
    getZoom: () => _baseZoom,
    setZoom: v => { _baseZoom = v; },
    headerName: 'Base assignment',
    onApply: () => {
      const wrap = document.getElementById('baseWrap');
      if (wrap) refreshImageBoxClips(wrap);
    },
    canvasContentHtml: '<div class="flag-wrap" id="baseWrap"><svg class="bsvg" id="baseSvg" viewBox="0 0 1000 750" preserveAspectRatio="xMidYMid meet"></svg></div>',
    description: "Drag from library into a zone. Logos placed in the grey bleed margin will be trimmed off and won't appear on the printed flag.",
  });
  const svg = document.getElementById('baseSvg');
  if (!svg) return;
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  svg.innerHTML = flag.svgContent;
  applyColors(svg, S.colors, flag.noColors, flag);
  renderLib();
  renderDropZones('baseWrap', 'baseSvg', [], 'front', () => {});
}

// ── Sidebar ────────────────────────────────────────────────

function syncSidebar() {
  // Summary section removed — nothing to sync
}

window.setProjectName = function (val) {
  S.projectName = val;
  markDirty();
};

// ── Save & navigate ────────────────────────────────────────

window.saveDraft = async function () {
  const btn = document.getElementById('saveDraftBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="save-spin"></span>'; }
  try {
    if (!S.projectId) {
      S.projectId = await createProject(S.projectName);
      history.replaceState(null, '', '?project=' + S.projectId);
    } else if (S.projectName !== undefined) {
      await updateProject(S.projectId, { name: S.projectName || null });
    }
    await saveFlagConfig(S.projectId, S);
    markClean();
    if (btn) {
      btn.innerHTML = '<span class="save-check"><i class="fa-solid fa-check" aria-hidden="true"></i></span>';
      setTimeout(() => { btn.innerHTML = 'Save draft'; btn.disabled = false; }, 1500);
    }
  } catch (err) {
    console.error(err);
    if (btn) { btn.innerHTML = 'Save draft'; btn.disabled = false; }
  }
};

window.goToVariations = async function () {
  await window.saveDraft();
  if (S.projectId) navigateTo('flags-variations?project=' + S.projectId);
};

// ── Init ──────────────────────────────────────────────────

paintCachedProjectName(new URLSearchParams(window.location.search).get('project'));
renderSidebar(document.getElementById('sidebar'), {
  activeStep: 1,
  steps: [
    { id: 'navDesign', label: 'Design', desc: 'Style, colors & logos' },
    {
      id: 'navVariations', label: 'Variations', desc: 'Build combinations',
      onClick: async () => {
        const p = new URLSearchParams(window.location.search).get('project');
        if (!p) return;
        await window.saveDraft?.();
        navigateTo('flags-variations?project=' + p);
      },
    },
    {
      id: 'navGallery', label: 'Review', desc: 'Review & export',
      onClick: async () => {
        const p = new URLSearchParams(window.location.search).get('project');
        if (!p) return;
        await window.saveDraft?.();
        navigateTo('flags-gallery?project=' + p);
      },
    },
  ],
});
document.getElementById('sidebarPanelHeader').innerHTML = `
  <div class="p1-header hs-panel-header">
    <div>
      <div class="ptitle">Design style</div>
      <div class="psub">Pick your colors, then select a flag style.</div>
    </div>
    <div class="p1-header-actions">
      <span class="s1hint-text" id="s1hint">Pick colors and select a style</span>
      <button class="btn primary" id="s1next" disabled onclick="goToVariations()">Next: Variations <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
      <button class="btn sm save-draft-btn" id="saveDraftBtn" onclick="saveDraft()" title="Save draft" style="display:none">Save draft</button>
    </div>
  </div>`;

await loadAllFlags(FLAGS);
renderFlagP1Controls();

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (_urlProject) {
  try {
    const project = await loadProject(_urlProject);
    const [logos, sharedLogos, flagCfg, intake] = await Promise.all([
      loadLogosForProject(_urlProject),
      listUserLogos(project.created_by),
      loadFlagConfig(_urlProject).catch(() => null),
      loadOrderIntake(_urlProject).catch(() => null),
    ]);

    // Customers can only edit while draft/needs_changes - once this design
    // is submitted/under review/approved, send them to the read-only
    // Gallery & export view instead of the editor. Staff/admin are never
    // blocked (see CLAUDE.md's "staff edits don't reset status" rule) - RLS
    // is the real boundary either way, this is just UI-convenience so a
    // locked customer never even sees the editor load. Gated on
    // flag_config.status (this design's own status), not the whole project -
    // a brand-new flagCfg (still null, nothing saved yet) is trivially
    // editable.
    if (!(await isStaffOrAdmin(session)) && flagCfg && !['draft', 'needs_changes'].includes(flagCfg.status)) {
      navigateTo(`flags-gallery?project=${_urlProject}`);
      await new Promise(() => {});
    }

    S.projectId = project.id;
    S.projectName = project.name || '';
    S.library = mergeLibraries(logos, sharedLogos);
    if (flagCfg) {
      S.flagId = flagCfg.flag_id;
      S.colors = (flagCfg.colors && Object.keys(flagCfg.colors).length) ? flagCfg.colors : { ...DEFAULT_COLORS };
      const varData = flagCfg.variations || [];
      const varItems = Array.isArray(varData) ? varData : (varData.items || []);
      S.variations = varItems.map(v => ({ ...v, backAssignment: v.backAssignment || {} }));
      S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
      S.gsTag = Array.isArray(varData) ? true : (varData.gsTag ?? true);
      S.gsTagMode = Array.isArray(varData) ? 'auto' : (varData.gsTagMode ?? 'auto');
      S.customColors = Array.isArray(varData) ? [] : (varData.customColors || []);
      S.gsTagColor = Array.isArray(varData) ? '#ffffff' : (varData.gsTagColor ?? '#ffffff');
      S.textLayers = Array.isArray(varData) ? [] : (varData.textLayers || []);
      S.imageLayers = Array.isArray(varData) ? [] : (varData.imageLayers || []);
      S.baseAssignment = flagCfg.base_assignment || {};
      S.activeVarId = S.variations[0]?.id || null;
      const flag = getFlag();
      if (flag?.logoZoneSets) flag.logoZones = flag.logoZoneSets[S.logoLayout] || flag.logoZones;
    } else if (intake) {
      if (intake.flag_style) S.flagId = intake.flag_style;
      // flag_colors is either a legacy bare array (old orders, positional
      // primary/secondary only) or { zones: [{zone,hex,...}], gsTag, gsTagMode }
      // as written by the order intake form — zone-tagged so it doesn't
      // depend on array position, and it also carries the GS tag choice.
      const fc = intake.flag_colors;
      const colors = Array.isArray(fc) ? fc : (fc?.zones || []);
      const byZone = Object.fromEntries(colors.filter(c => c?.zone).map(c => [c.zone, c]));
      const primary = byZone['zone-primary'] || colors[0];
      const secondary = byZone['zone-secondary'] || colors[1];
      const border = byZone['zone-border'];
      if (primary?.hex) S.colors['zone-primary'] = primary.hex;
      if (secondary?.hex) S.colors['zone-secondary'] = secondary.hex;
      if (border?.hex) S.colors['zone-border'] = border.hex;
      if (fc && !Array.isArray(fc)) {
        if (typeof fc.gsTag === 'boolean') S.gsTag = fc.gsTag;
        if (fc.gsTagMode) S.gsTagMode = fc.gsTagMode;
      }
      // Whether new variations start with an independent back (the customer
      // asked for different front/back designs at intake) is decided where
      // variations are actually created — flags-variations.html's own
      // defaultSameSides — not here; this page never creates any.
    }
    setSidebarProjectName(S.projectName, S.projectId);
    if (!S.flagId) {
      // Arrived from the public template gallery / event-info step with a
      // template already chosen there (?template=<id>).
      const templateParam = new URLSearchParams(window.location.search).get('template');
      S.flagId = (templateParam && FLAGS.some(f => f.id === templateParam)) ? templateParam : 'plain';
    }
    showFlagExpanded(S.flagId);
    renderFlagP1Controls();
    checkStep1();
    syncSidebar();
  } catch (err) {
    console.error('Could not load project', err);
  }
}
