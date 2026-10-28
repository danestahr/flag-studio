import '../style.css';
import '../icons.js';
import { requireAuth, isStaffOrAdmin } from '../auth.js';

const session = await requireAuth();

import { S, isFaceLocked, _dragLogoId, loadTemplateBack, setDragLogoId, DEFAULT_COLORS, addCustomColor, allSwatches, navigateTo, normalizeLocks } from '../state.js';
import { newProjectPrintSpec, usesV2Print } from './print-spec.js';
import { FLAGS, LISTED_FLAGS, baseFlagId } from '../data.js';
import { getFlag, applyColors, showGsTagVariant, resolveColors, flagFaceSource, canvasAspect, makeSvg, printOpts, syncWrapPole, paintFlagCardV2, tagKeyZoneOf } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  createProject, updateProject, loadProject,
  saveFlagConfig, loadFlagConfig,
  loadLogosForProject, deleteLogo, uploadLogo,
  loadOrderIntake,
} from '../supabase.js';
import { initDropZones, renderDropZones, hideZoneToolbar } from './drop-zones.js';
import { addFlagTextLayer, renderFlagTextOverlays, clearFlagTextOverlays } from './text-layers.js';
import { renderFlagImageOverlays, clearFlagImageOverlays } from './image-layers.js';
import './layer-clipboard.js';
import { eyedropperBtn, pickEyedropperColor } from '../eyedropper.js';
import { esc } from '../dom-utils.js';
import { logoThumbHtml, downloadLogo } from '../media-utils.js';
import { renderSidebar, renderLogosTileShell, setSidebarProjectName, paintCachedProjectName } from '../sidebar.js';
import { renderLogoTray } from '../logo-tray.js';
import { renderCanvasPanel } from '../canvas-panel.js';
import { refreshImageBoxClips } from '../image-box.js';

let isDirty = false;
let _baseZoom = 100;
let _flagExpZoom = 75;
function safeHex(h) { return /^#[0-9A-Fa-f]{3,6}$/.test(h) ? h : '#cccccc'; }

// Which Design-step submenu is drilled into — null shows the row list
// (Style & Colors / Hole Numbers / Text), mirroring hs/design.js's
// UI.hsMenu pattern. Purely ephemeral UI state, not persisted.
let p1Menu = null;

const flagExpCanvas = renderCanvasPanel(document.getElementById('flagExpCanvasPanel'), {
  panelId: 'flagExpCanvasPanel',
  scrollId: 'flagExpScroll',
  wrapId: 'flagExpZoomWrap',
  zoomValueId: 'flagExpZoomValue',
  zoomResetId: 'flagExpZoomReset',
  aspect: () => canvasAspect(getFlag()),
  getZoom: () => _flagExpZoom,
  setZoom: v => { _flagExpZoom = v; },
  // Front/Back tabs + "Same Front & Back Design" toggle — same controls as the
  // Variations editor, but for the template: off = one standard back that
  // every variation inherits (see state.js's separateBack).
  faceToggleHidden: false,
  onFaceChange: face => window.setP1Face(face),
  onToggleSameSides: checked => window.toggleSeparateBack(!checked),
  sameSidesLabel: 'Same Front & Back Template',
  extraBtn: { id: 'flagLockBtn', label: 'Lock template', icon: 'fa-lock-open', visible: true, onClick: () => window.toggleFaceLock() },
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
  document.getElementById('flagGrid').innerHTML = LISTED_FLAGS.map(f => `
    <div class="flag-card" id="fc-${f.id}" onclick="pickFlag('${f.id}')">
      <div class="flag-card-preview"><svg viewBox="${f.viewBox || '0 0 7519 4669'}" preserveAspectRatio="xMidYMid meet">${f.svgContent}</svg></div>
      <div class="flag-card-name">${f.name}</div>
    </div>`).join('');
}

function showFlagExpanded(id) {
  const flag = FLAGS.find(f => f.id === id);
  if (!flag) return;
  document.querySelectorAll('.flag-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('fc-' + baseFlagId(id))?.classList.add('selected');
  renderFlagLayoutRow();
  refreshFlagPreviews();
  refreshFlagExpanded();
}

// Which face of the template Step 1's canvas shows. Ephemeral UI state.
let p1Face = 'front';

window.setP1Face = function (face) {
  if (face === p1Face) return;
  p1Face = face;
  refreshFlagExpanded();
};

// Off (the default, "Same Front & Back Design" checked) the back is a
// read-only reflection of the front. On, the back is its own standard design,
// starting blank — turning it off again discards it, same as a variation's
// own toggleSameSides.
window.toggleSeparateBack = function (separate) {
  if (!separate && (S.backLogos.length || S.backTextLayers.length || S.backImageLayers.length)
      && !confirm('Remove the template back design? Variations will go back to mirroring their front.')) {
    refreshFlagExpanded();
    return;
  }
  S.separateBack = separate;
  normalizeLocks();
  S.backLogos = [];
  S.backTextLayers = [];
  S.backImageLayers = [];
  refreshFlagExpanded();
  markDirty();
};

// Locks/unlocks the face being viewed — see state.js's frontLocked/backLocked.
window.toggleFaceLock = function () {
  const key = p1Face === 'back' ? 'backLocked' : 'frontLocked';
  if (p1Face === 'back' && !S.separateBack) return; // back is the front's reflection — nothing of its own to lock
  S[key] = !S[key];
  // Locking one side releases the other — only one can be locked at a time.
  if (S[key]) S[p1Face === 'back' ? 'frontLocked' : 'backLocked'] = false;
  syncP1FaceUI();
  markDirty();
};

function syncP1FaceUI() {
  const locked = isFaceLocked(p1Face);
  const lockBtn = document.getElementById('flagLockBtn');
  if (lockBtn) {
    const name = p1Face === 'back' ? 'back' : 'front';
    lockBtn.classList.toggle('active', locked);
    lockBtn.title = locked ? `Unlock ${name} — variations can alter it and add logos to it again` : `Lock ${name} — variations can't alter it or add logos to it${p1Face === 'back' ? ' (their own logos stop mirroring onto the back)' : ''}`;
    const mirroredBack = p1Face === 'back' && !S.separateBack;
    if (mirroredBack) lockBtn.title = 'The back is the same template as the front — turn off "Same Front & Back Design" to give it its own template, or lock the front';
    lockBtn.disabled = mirroredBack;
    lockBtn.setAttribute('aria-label', lockBtn.title);
    lockBtn.innerHTML = `<i class="fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}" aria-hidden="true"></i>`;
  }
  [['Front', 'front'], ['Back', 'back']].forEach(([label, face]) => {
    const tab = document.getElementById('flagExpCanvasPanelFace' + label);
    if (tab) tab.innerHTML = label + (isFaceLocked(face) ? ' <i class="fa-solid fa-lock" aria-hidden="true"></i>' : '');
  });
  document.getElementById('flagExpCanvasPanelFaceFront')?.classList.toggle('active', p1Face === 'front');
  document.getElementById('flagExpCanvasPanelFaceBack')?.classList.toggle('active', p1Face === 'back');
  const row = document.getElementById('flagExpCanvasPanelSidesRow');
  if (row) row.style.display = p1Face === 'back' ? '' : 'none';
  const check = document.getElementById('flagExpCanvasPanelSidesCheck');
  if (check) check.checked = !S.separateBack;
}

function refreshFlagExpanded() {
  const preview = document.getElementById('flagExpPreview');
  if (!preview) return;
  syncP1FaceUI();
  const flag = getFlag();
  syncWrapPole(document.getElementById('flagExpZoomWrap'), flag, p1Face, S.colors);
  if (!flag) {
    preview.innerHTML = '<div class="flag-exp-placeholder">Select a style →</div>';
    return;
  }
  const face = p1Face;
  const src = flagFaceSource(flag, face);
  preview.style.aspectRatio = src.v2 ? '6000 / 4050' : '';
  requestAnimationFrame(flagExpCanvas.refit); // the panel's shape follows the flag (20:13.5 for v2)

  if (face === 'back' && !S.separateBack) {
    // Read-only reflection of the front through the canonical renderer, so it
    // matches what variations/export produce — nothing here to edit.
    clearFlagTextOverlays('flagExpPreview');
    clearFlagImageOverlays('flagExpPreview');
    preview.innerHTML = '';
    const mirror = makeSvg([], '100%', '100%', 'back', true, flag, S.colors, S.textLayers || [], null, S.imageLayers || [], printOpts(flag));
    if (mirror) {
      preview.appendChild(mirror);
      if (S.gsTag) {
        const keyZone = tagKeyZoneOf(flag);
        showGsTagVariant(mirror, 'back', S.gsTagMode, resolveColors(S.colors, flag)[keyZone], src.v2);
      }
    }
    return;
  }

  // Legacy templates have one artboard, mirrored for the back; v2 print
  // frames carry a dedicated back artboard (flagFaceSource) with no mirror.
  const content = (face === 'back' && !src.v2)
    ? `<g transform="translate(${src.viewBox.split(' ')[2]},0) scale(-1,1)">${src.svgContent}</g>`
    : src.svgContent;
  preview.innerHTML = `<svg viewBox="${src.viewBox}" width="100%" height="100%">${content}</svg>`;
  const svg = preview.querySelector('svg');
  applyColors(svg, S.colors, flag.noColors, flag);
  if (S.gsTag) {
    const keyZone = tagKeyZoneOf(flag);
    showGsTagVariant(svg, face, S.gsTagMode, resolveColors(S.colors, flag)[keyZone], src.v2);
  }
  if (face === 'back') {
    renderFlagTextOverlays('flagExpPreview', S.backTextLayers, onFlagLayersChange);
    renderFlagImageOverlays('flagExpPreview', S.backImageLayers, onFlagLayersChange);
    return;
  }
  // Template-level Text/Images layers (Step 1's own rows — see the submenu
  // below) — rebuilt on top of the fresh SVG every time it's replaced above,
  // same as any other Step-1 canvas overlay in this app.
  renderFlagTextOverlays('flagExpPreview', S.textLayers, onFlagLayersChange);
  renderFlagImageOverlays('flagExpPreview', S.imageLayers, onFlagLayersChange);
}

function onFlagLayersChange() { markDirty(); }

// Dropping a library logo from the sidebar tile onto the step-1 canvas adds
// it as an image layer on the face being edited.
{
  const panel = document.getElementById('flagExpCanvasPanel');
  panel?.addEventListener('dragover', e => {
    if (_dragLogoId) e.preventDefault();
  });
  panel?.addEventListener('drop', e => {
    const logo = _dragLogoId && S.library.find(l => l.id === _dragLogoId);
    if (!logo || logo.uploading) return;
    e.preventDefault();
    setDragLogoId(null);
    const preview = document.getElementById('flagExpPreview');
    const r = preview?.getBoundingClientRect();
    const pct = (v, lo, size) => r && size ? Math.min(100, Math.max(0, ((v - lo) / size) * 100)) : 50;
    p1EditableLayers().images.push({
      id: 'fil-' + Date.now(), src: logo.src, storagePath: logo.storagePath,
      x: pct(e.clientX, r?.left, r?.width), y: pct(e.clientY, r?.top, r?.height), w: 30,
    });
    renderFlagImageOverlays('flagExpPreview', p1EditableLayers().images, onFlagLayersChange);
    markDirty();
  });
}

// Layout choice for a style that ships several vendor print layouts (see
// flags/print-manifest.js). Only offered to projects on the v2 print spec -
// legacy projects have one artboard per style. A layout is its own flag id, so
// switching just swaps S.flagId (colors/logos carry over; zones the new layout
// lacks simply stop being drawn).
function renderFlagLayoutRow() {
  const host = document.getElementById('flagLayoutSection');
  if (!host) return;
  const flag = getFlag();
  const layouts = flag?.layouts;
  if (!layouts || layouts.length < 2 || !usesV2Print({ print_spec: S.printSpec }, flag)) {
    host.style.display = 'none';
    return;
  }
  host.style.display = '';
  host.querySelector('.gs-mode-wrap').innerHTML = layouts.map(l =>
    `<button class="gs-mode-btn${l.flagId === S.flagId ? ' active' : ''}" onclick="pickFlagLayout('${l.flagId}')">${l.label}</button>`).join('');
}

// A vendor layout with a border starts with a black one (the "Black" swatch)
// rather than matching the primary - a border that blends into the field would
// hide the very thing the layout adds. Only applies while the border is still
// on its untouched "match" default (no zone-border key), so a color the user
// already picked is never overridden. Also run once on load (see loadProject).
function defaultLayoutBorder(flag) {
  if (!flag?.printStyle && !flag?.layoutOf) return;
  if ((flag.layouts?.length || 0) < 2) return; // a single-layout style's border is part of its design, not a layout choice
  if (!usesV2Print({ print_spec: S.printSpec }, flag)) return;
  if (!flag.colorZones?.some(z => z.id === 'zone-border')) return;
  if ('zone-border' in S.colors) return;
  S.colors['zone-border'] = '#111110';
}

window.pickFlagLayout = function (flagId) {
  if (S.flagId === flagId) return;
  S.flagId = flagId;
  defaultLayoutBorder(getFlag());
  renderFlagLayoutRow();
  refreshFlagPreviews();
  refreshFlagExpanded();
  renderP1Colors();
  checkStep1();
  syncSidebar();
  markDirty();
};

window.pickFlag = function (id) {
  if (baseFlagId(S.flagId) === id) return;
  S.flagId = id;
  defaultLayoutBorder(getFlag());
  S.logoLayout = 'single';
  showFlagExpanded(id);
  renderP1Colors();
  checkStep1();
  syncSidebar();
  markDirty();
};

// ── Step 1 submenu (Style & Colors / Hole Numbers / Text) ─────────
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
  ];
  return `<div class="hs-menu-list">${rows.join('')}</div>`;
}

// Text/Images add straight to the canvas (S.textLayers/S.imageLayers) and
// stay on the row list — unlike "Style & Colors"/"Hole Numbers" there's no
// section to drill into; the new layer's own on-canvas toolbar/handles
// (flags/text-layers.js, flags/image-layers.js) are what gets edited next,
// same as hs/design.js's addTextLayer()/addTplImage().
window.addFlagP1Text = function () {
  addFlagTextLayer(p1EditableLayers().text, 'flagExpPreview', onFlagLayersChange);
};

// The layer lists the canvas is currently editing. The mirrored back is a
// read-only view, so adding there drops back to the front (same as the
// Variations editor's add menu).
function p1EditableLayers() {
  if (p1Face === 'back' && !S.separateBack) window.setP1Face('front');
  return p1Face === 'back'
    ? { text: S.backTextLayers, images: S.backImageLayers }
    : { text: S.textLayers, images: S.imageLayers };
}

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
    <div id="flagLayoutSection" class="p1-section p1-section-divided" style="display:none">
      <div class="zlabel">Layout</div>
      <div class="gs-mode-wrap" style="display:flex;flex-wrap:wrap"></div>
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
    renderFlagLayoutRow();
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
  LISTED_FLAGS.forEach(f => {
    const card = document.getElementById('fc-' + f.id);
    if (!card) return;
    const host = card.querySelector('.flag-card-preview');
    // v2 projects show the new front view (with pole); the selected style's card
    // follows the chosen layout, the others show their default.
    const cardFlag = baseFlagId(S.flagId) === f.id ? (getFlag() || f) : f;
    if (host && paintFlagCardV2(host, cardFlag, S.colors)) return;
    if (host?.classList.contains('v2')) {
      host.classList.remove('v2');
      host.innerHTML = `<svg viewBox="${f.viewBox || '0 0 7519 4669'}" preserveAspectRatio="xMidYMid meet">${f.svgContent}</svg>`;
    }
    const svg = card.querySelector('svg');
    if (!svg) return;
    applyColors(svg, S.colors, f.noColors, f);
    if (S.gsTag) {
      const keyZone = tagKeyZoneOf(f);
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
  const src = flagFaceSource(flag, 'front');
  box.innerHTML = `<svg viewBox="${src.viewBox}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${src.svgContent}</svg>`;
  const svg = box.querySelector('svg');
  applyColors(svg, S.colors, flag.noColors, flag);
  if (S.gsTag) {
    const keyZone = tagKeyZoneOf(flag);
    showGsTagVariant(svg, 'front', S.gsTagMode, resolveColors(S.colors, flag)[keyZone], src.v2);
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
      const logo = await uploadLogo(S.projectId, file);
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
  if (g) {
    if (!S.library.length) g.innerHTML = '<div class="lib-empty">No logos yet</div>';
    else g.innerHTML = S.library.map(l => `
    <div class="lib-item ${l.uploading ? 'uploading' : ''}" id="li-${l.id}" draggable="${!l.uploading}"
      ondragstart="dragStart(event,'${l.id}')" ondragend="dragEnd('${l.id}')">
      ${logoThumbHtml(l.src, l.name)}
      <div class="lib-item-name">${l.uploading ? '<i class="fa-solid fa-upload" aria-hidden="true"></i> uploading…' : l.name}</div>
      ${l.uploading ? '' : `<button class="lib-dl" onclick="downloadLibItem('${l.id}')"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`}
      ${l.uploading ? '' : `<button class="lib-del" onclick="delLogo('${l.id}')"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`}
    </div>`).join('');
  }
  renderLogosTile();
}

// Step 1's sidebar logos tile — same tray as the Variations step. Hidden
// until at least one logo has been uploaded.
function renderLogosTile() {
  const tile = document.getElementById('sidebarLogosTile');
  if (!tile) return;
  if (!S.library.length) { tile.style.display = 'none'; tile.innerHTML = ''; return; }
  renderLogosTileShell('Logos', 'designLogoStrip', S.projectId);
  renderLogoTray(document.getElementById('designLogoStrip'), {
    library: S.library,
    fileInputId: 'designLogoFile',
    accept: 'image/*,.pdf,.ai,.eps',
    onUpload: files => window.handleUpload({ target: { files, value: '' } }),
    onDragStart: l => setDragLogoId(l.id),
    onDelete: l => window.delLogo(l.id),
  });
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
  S.backLogos = (S.backLogos || []).filter(l => l.logoId !== id);
  if (S.separateBack) renderDropZones('baseWrap', 'baseSvg', S.backLogos, 'back', markDirty, null, null, null, { text: S.backTextLayers, images: S.backImageLayers });
  else renderDropZones('baseWrap', 'baseSvg', S.baseAssignment);
  syncSidebar();
  if (logo?.storagePath) {
    try {
      await deleteLogo(logo.storagePath, logo.id);
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
    aspect: () => canvasAspect(getFlag()),
    getZoom: () => _baseZoom,
    setZoom: v => { _baseZoom = v; },
    headerName: S.separateBack ? 'Template back' : 'Base assignment',
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
  if (S.separateBack) {
    // The template back's logos are placed here — this is the step with the
    // logo library. Front logos stay per-variation (Variations step).
    renderDropZones('baseWrap', 'baseSvg', S.backLogos, 'back', markDirty, null, null, null, { text: S.backTextLayers, images: S.backImageLayers });
  } else {
    renderDropZones('baseWrap', 'baseSvg', [], 'front', () => {});
  }
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
  logosTile: true,
  projectId: new URLSearchParams(window.location.search).get('project'),
  steps: [
    { id: 'navDesign', label: 'Template', desc: 'Style, colors & logos' },
    {
      id: 'navVariations', label: 'Flags', desc: 'Build combinations',
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
      <div class="ptitle">Template</div>
      <div class="psub">Pick your colors, then select a flag style.</div>
    </div>
    <div class="p1-header-actions">
      <span class="s1hint-text" id="s1hint">Pick colors and select a style</span>
      <button class="btn primary" id="s1next" disabled onclick="goToVariations()">Next: Flags <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
      <button class="btn sm save-draft-btn" id="saveDraftBtn" onclick="saveDraft()" title="Save draft" style="display:none">Save draft</button>
    </div>
  </div>`;

await loadAllFlags(FLAGS);
renderFlagP1Controls();

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (_urlProject) {
  try {
    const project = await loadProject(_urlProject);
    const [logos, flagCfg, intake] = await Promise.all([
      loadLogosForProject(_urlProject),
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
    S.library = logos;
    renderLib();
    S.printSpec = flagCfg ? (flagCfg.variations?.printSpec ?? 'legacy') : newProjectPrintSpec(); // pinned per project; no row yet = brand-new project
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
      loadTemplateBack(varData);
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
    // Projects saved before layouts defaulted to a black border (or brand-new
    // ones) get it here; it's in memory only until the next save.
    defaultLayoutBorder(getFlag());
    showFlagExpanded(S.flagId);
    renderFlagP1Controls();
    checkStep1();
    syncSidebar();
  } catch (err) {
    console.error('Could not load project', err);
  }
}
