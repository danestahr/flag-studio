import '../style.css';
import '../icons.js';
import { requireAuth, isStaffOrAdmin } from '../auth.js';

const session = await requireAuth();

import { S, setDragLogoId, addCustomColor, allSwatches, navigateTo, mergeLibraries } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, applyColors, renderInto, showGsTagVariant, makeSvg, resolveColors, preloadLogoAspects, withMasterText } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  loadProject, saveFlagConfig, loadFlagConfig,
  loadLogosForProject, deleteLogo,
  uploadUserLogo, listUserLogos, deleteUserLogo, adoptFeedbackLogo,
  getFeedback, resolveFeedback, deleteFeedbackForVariation, supabase, loadOrderIntake,
} from '../supabase.js';
import { initDropZones, renderDropZones, hideZoneToolbar, triggerAdd } from './drop-zones.js';
import { renderFlagTextOverlays, addFlagTextLayer, clearFlagTextOverlays, renderFlagTextOverlaysStatic } from './text-layers.js';
import { eyedropperBtn, pickEyedropperColor } from '../eyedropper.js';
import { esc } from '../dom-utils.js';
import { renderSidebar, renderLogosTileShell, setSidebarProjectName } from '../sidebar.js';
import { renderEditRequestsPanel } from '../edit-requests-panel.js';
import { renderLogoTray } from '../logo-tray.js';
import { renderVariationList, refreshVariationThumbs } from '../variation-list.js';
import { renderCanvasPanel } from '../canvas-panel.js';
import { refreshImageBoxClips } from '../image-box.js';

let isDirty = false;
let activeFace = 'front';
let editingVarId = null;
let veExpandedZones = new Set();

// The customer's originally-ordered flag count (order_intakes.flag_qty) —
// null for admin-created projects, which skip order.html entirely and so
// have no intake row. Kept fixed for the life of the project; whenever the
// variation count changes, existing quantities are re-split evenly across
// it rather than left to add up to something else (see redistributeQty).
let orderFlagQty = null;

// Evenly re-splits orderFlagQty across all current variations (remainder
// going to the first ones) — called whenever the variation count changes
// (setupVariations' initial variation, addVariation, dupVar, delVar) so
// quantities always sum back to what the customer ordered instead of
// drifting after an add/duplicate/delete. A no-op for admin-created
// projects (no intake, orderFlagQty stays null) or an empty list.
function redistributeQty() {
  if (!orderFlagQty || !S.variations.length) return;
  const n = S.variations.length;
  const base = Math.floor(orderFlagQty / n);
  let remainder = orderFlagQty % n;
  S.variations.forEach(v => {
    v.qty = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
  });
}

// Whether a *new* variation should start with an independently-editable back
// — true (mirrored) unless the customer told order.html they wanted
// different front/back designs (see the project-load block). Each variation
// then carries its own sameLogoOnBothSides from there on (see toggleSameSides
// / sameSidesOf) — this only seeds the initial value for a variation that
// doesn't exist yet.
let defaultSameSides = true;

// "Same Front & Back Design" is a per-variation setting (see
// toggleSameSides) — this is the one place that reads it, so every other
// call site stays agnostic about the ?? true fallback (older variations
// saved before this was per-variation — see the flagCfg migration below).
function sameSidesOf(v) {
  return v?.sameLogoOnBothSides ?? true;
}

window.veEyedropper = async function (zoneId) {
  const hex = await pickEyedropperColor();
  if (hex) vePickColor(zoneId, hex);
};

function markDirty() {
  isDirty = true;
  document.getElementById('saveDesignsBtn')?.classList.add('dirty');
}
function markClean() {
  isDirty = false;
  document.getElementById('saveDesignsBtn')?.classList.remove('dirty');
}

initDropZones({
  ensureProject: async () => {},
  markDirty,
  onLibraryUpdated: () => { renderVarStrip(); },
});

// ── Per-variation flag/color helpers ──────────────────────

function getVarFlag(v) {
  if (!v) return getFlag();
  const id = v.flagId || S.flagId;
  return FLAGS.find(f => f.id === id) || getFlag();
}

function getVarColors(v) {
  return (v && v.colors) ? v.colors : S.colors;
}

function getVarGsTagOpts(v) {
  if (!v || (v.gsTag === undefined && v.gsTagMode === undefined)) return null;
  return { enabled: v.gsTag ?? S.gsTag, mode: v.gsTagMode ?? S.gsTagMode };
}

// ── Logo library (strip) ───────────────────────────────────

function hasAnyLogoPlacement() {
  return S.variations.some(v => (v.logos?.length) || (v.backLogos?.length));
}

// Every upload becomes a shared logo (user_logos), reusable across all of
// this user's projects — one flat "Logos" section, not a project-only vs.
// shared split. Logos already on the project from before this change
// (project_logos rows, loaded alongside the shared ones in mergeLibraries())
// keep showing here too and stay deletable via deleteLogo — only a newly
// uploaded logo is tagged `shared: true`.
async function handleFlagLogoUpload(files) {
  for (const file of files) {
    const localSrc = await new Promise(res => {
      const r = new FileReader();
      r.onload = ev => res(ev.target.result);
      r.readAsDataURL(file);
    });
    const tempId = 'tmp-' + Date.now();
    S.library.push({ id: tempId, name: file.name.replace(/\.[^.]+$/, ''), src: localSrc, uploading: true });
    renderVarStrip();
    try {
      const logo = await uploadUserLogo(file);
      logo.shared = true;
      const idx = S.library.findIndex(l => l.id === tempId);
      if (idx !== -1) S.library[idx] = logo;
      // First logo in the project — place it straight onto the active
      // variation instead of making the customer drag it from the strip.
      // Only fires for the very first upload (not every subsequent one),
      // and only onto a variation with nothing placed yet, so it never
      // clobbers a placement someone already made. Checked against actual
      // placements rather than S.library.length, since the library can
      // already hold logos carried over from this user's other projects
      // (see mergeLibraries()).
      if (!hasAnyLogoPlacement()) {
        const v = S.variations.find(v => v.id === S.activeVarId) || S.variations[0];
        if (v && Array.isArray(v.logos) && v.logos.length === 0) {
          v.logos.push({ id: 'pl-' + Date.now(), logoId: logo.id, x: 50, y: 50, w: 75, aboveFrame: false });
          renderVarCanvas();
          refreshVarThumbs();
          markDirty();
        }
      }
    } catch (err) {
      console.error('Logo upload failed', err);
      S.library = S.library.filter(l => l.id !== tempId);
    }
    renderVarStrip();
  }
}

window.delLogo = async function (id) {
  const logo = S.library.find(l => l.id === id);
  S.library = S.library.filter(l => l.id !== id);
  // Remove from all variation logo arrays
  S.variations.forEach(v => {
    if (Array.isArray(v.logos))     v.logos     = v.logos.filter(l => l.logoId !== id);
    if (Array.isArray(v.backLogos)) v.backLogos = v.backLogos.filter(l => l.logoId !== id);
  });
  hideZoneToolbar();
  renderVarStrip();
  renderVarCanvas();
  markDirty();
  if (logo?.storagePath) {
    try {
      await (logo.shared ? deleteUserLogo(logo.storagePath, logo.id) : deleteLogo(logo.storagePath, logo.id));
    } catch (err) { console.error('Storage delete failed', err); }
  }
};

async function removeBgFromFlagLogo(logo, onProgress) {
  onProgress?.('loading');
  const { removeBackground } = await import('@imgly/background-removal');
  const blob = await removeBackground(logo.src);
  const file = new File([blob], logo.name.replace(/\.[^.]+$/, '') + ' (no bg).png', { type: 'image/png' });
  onProgress?.('uploading');
  const newLogo = await uploadUserLogo(file);
  newLogo.shared = true;
  return newLogo;
}

function renderVarStrip() {
  renderLogoTray(document.getElementById('varStrip'), {
    library: S.library,
    fileInputId: 'varFile',
    accept: 'image/*,.pdf,.ai,.eps',
    onUpload: handleFlagLogoUpload,
    onDragStart: l => setDragLogoId(l.id),
    onDelete: l => delLogo(l.id),
    onRemoveBg: async (l, onProgress) => {
      const newLogo = await removeBgFromFlagLogo(l, onProgress);
      const origIdx = S.library.indexOf(l);
      if (origIdx >= 0) S.library.splice(origIdx, 1, newLogo);
      else S.library.push(newLogo);
      S.variations.forEach(v => {
        if (Array.isArray(v.logos)) v.logos.forEach(pl => { if (pl.logoId === l.id) pl.logoId = newLogo.id; });
        if (Array.isArray(v.backLogos)) v.backLogos.forEach(pl => { if (pl.logoId === l.id) pl.logoId = newLogo.id; });
      });
      renderVarStrip();
      renderVarCanvas();
      refreshVarThumbs();
      markDirty();
    },
  });
}

// ── Variations ─────────────────────────────────────────────

// The zone outline is just a placement suggestion now, and front/back are
// always both reachable from a single canvas via the Front/Back tabs — only
// the "Same Front & Back Design" toggle (shown while viewing Back) decides
// whether the back is a derived read-only mirror of the front or independently
// editable, matching how it's exported (see makeSvg's `mirrorX`).
function updateFaceUI() {
  const frontBtn = document.getElementById('faceTabFront');
  const backBtn  = document.getElementById('faceTabBack');
  if (frontBtn) frontBtn.classList.toggle('active', activeFace === 'front');
  if (backBtn)  backBtn.classList.toggle('active', activeFace === 'back');
  const sameRow = document.getElementById('sameSidesRow');
  if (sameRow) sameRow.style.display = activeFace === 'back' ? '' : 'none';
  const sameCheck = document.getElementById('sameSidesCheck');
  if (sameCheck) sameCheck.checked = sameSidesOf(S.variations.find(v => v.id === S.activeVarId));
}

window.setActiveFace = function (face) {
  if (face === activeFace) return;
  activeFace = face;
  renderVarCanvas();
};

// Per-variation — only ever flips the currently active variation's own
// back-design mode, never any other variation's (see sameSidesOf). Flipping
// either direction starts the back from a blank slate: turning "Same Front &
// Back" on makes the back a derived, read-only mirror of the front (nothing
// independent left to keep), and turning it off hands the user an empty back
// canvas to design from scratch rather than pre-filling it with whatever the
// front happened to look like at that moment.
window.toggleSameSides = function (checked) {
  const v = S.variations.find(v => v.id === S.activeVarId);
  if (!v) return;
  v.sameLogoOnBothSides = checked;
  v.backLogos = [];
  v.backTextLayers = [];
  renderVarCanvas();
  renderVarList();
  markDirty();
};

function syncLogoLayoutToggle() {
  const flag = getFlag();
  const row = document.getElementById('logoLayoutRow');
  if (!row) return;
  const hasOptions = !!(flag?.logoZoneSets);
  row.style.display = hasOptions ? '' : 'none';
  if (hasOptions) {
    const layout = S.logoLayout || 'single';
    flag.logoZones = flag.logoZoneSets[layout] || flag.logoZones;
    document.getElementById('layoutBtnSingle')?.classList.toggle('active', layout === 'single');
    document.getElementById('layoutBtnMulti')?.classList.toggle('active', layout === 'multi');
  }
}

window.setLogoLayout = function (layout) {
  const flag = getFlag();
  if (!flag?.logoZoneSets) return;
  S.logoLayout = layout;
  flag.logoZones = flag.logoZoneSets[layout] || flag.logoZones;
  document.getElementById('layoutBtnSingle')?.classList.toggle('active', layout === 'single');
  document.getElementById('layoutBtnMulti')?.classList.toggle('active', layout === 'multi');
  renderVarCanvas();
  refreshVarThumbs();
  markDirty();
};

let _flagZoom = 75;

const flagCanvas = renderCanvasPanel(document.getElementById('flagCanvasPanel'), {
  panelId: 'flagCanvasPanel',
  scrollId: 'flagCanvasScroll',
  wrapId: 'flagZoomWrap',
  zoomValueId: 'flagZoomValue',
  zoomResetId: 'flagZoomReset',
  aspect: 7519 / 4669,
  getZoom: () => _flagZoom,
  setZoom: v => { _flagZoom = v; },
  onAdd: e => window.openVarAddMenu(e),
  addBtnId: 'varAddBtn',
  // Global, not scoped to whichever variation is active — the right-hand
  // "All variations" list is where a specific variation's own request lives
  // now (its "View edits" link, see variation-list.js), so this banner is
  // just the project-wide entry point into that same sub-view.
  noteHtml: `
    <div id="varEditNote" class="var-edit-note" style="display:none">
      <div class="var-edit-note-row">
        <div class="var-edit-note-body">
          <span class="var-edit-note-label">Edit requested:</span>
          <span id="varEditNoteText"></span>
        </div>
        <button class="var-edit-viewall-btn" onclick="openFlagEditRequests()">View all edits</button>
      </div>
    </div>`,
  faceToggleHidden: false,
  faceTabFrontId: 'faceTabFront',
  faceTabBackId: 'faceTabBack',
  onFaceChange: face => window.setActiveFace(face),
  sameSidesRowId: 'sameSidesRow',
  sameSidesCheckId: 'sameSidesCheck',
  onToggleSameSides: checked => window.toggleSameSides(checked),
  onApply: () => {
    const wrap = document.getElementById('varWrap');
    if (wrap) refreshImageBoxClips(wrap);
  },
  canvasContentHtml: `
    <div class="flag-wrap" id="varWrap">
      <svg class="bsvg" id="varSvg" viewBox="0 0 1000 750" preserveAspectRatio="xMidYMid meet"></svg>
    </div>`,
  description: "Drag from library into a zone. Logos placed in the grey bleed margin will be trimmed off and won't appear on the printed flag.",
});

const varThumbId = v => 'vt-' + v.id;
const paintVarThumb = (el, v) => renderInto(el, v.logos || [], 'front', false, getVarFlag(v), getVarColors(v), withMasterText(v), getVarGsTagOpts(v), S.imageLayers || []);

// Independent-back preview for the tile — only shown (see showBackThumb
// below) for a variation whose own sameSidesOf(v) is off, so mirrorX is
// always false here: an on back is just a reflection of the front thumb
// already shown, nothing new to see, same reasoning as gallery.js's own
// backMirror branch.
const varBackThumbId = v => 'vtb-' + v.id;
const paintVarBackThumb = (el, v) => renderInto(el, v.backLogos || [], 'back', false, getVarFlag(v), getVarColors(v), v.backTextLayers || [], getVarGsTagOpts(v));

// Clicking a variation's card just makes it the active one on the canvas —
// a lightweight preview/select, not the full per-variation editor (that's
// what the card's own pencil icon, onEdit below, is for). Mirrors hs/
// variations.js's own selectVariation.
function selectVariation(varId) {
  S.activeVarId = varId;
  renderVarList();
  renderVarCanvas();
}

function renderVarList() {
  renderVariationList(document.getElementById('varList'), S.variations, {
    activeId: S.activeVarId,
    thumbId: varThumbId,
    renderThumb: paintVarThumb,
    showBackThumb: v => !sameSidesOf(v),
    backThumbId: varBackThumbId,
    renderBackThumb: paintVarBackThumb,
    feedbackFor: v => S.feedback?.find(f => f.variation_id === v.id),
    onSelect: v => selectVariation(v.id),
    onRename: (v, name) => renameVar(v.id, name),
    onEdit: v => openVarEdit(v.id),
    onDuplicate: v => dupVar(v.id),
    onDelete: v => delVar(v.id),
    onQtyChange: (v, qty) => { v.qty = qty; markDirty(); },
    onViewEdits: v => window.openFlagEditRequests(v.id),
  });
}

function refreshVarThumbs() {
  refreshVariationThumbs(S.variations, varThumbId, paintVarThumb);
  refreshVariationThumbs(S.variations.filter(v => !sameSidesOf(v)), varBackThumbId, paintVarBackThumb);
}

function renderVarFlagRow(v) {
  const el = document.getElementById('varEditPanelBody');
  if (!el) return;

  const varFlag = getVarFlag(v);
  const varColors = getVarColors(v);
  const hasFlag = !!v.flagId;
  const hasColors = !!v.colors;
  const veGsTagEnabled = v.gsTag ?? S.gsTag;
  const veGsTagMode = v.gsTagMode ?? S.gsTagMode;
  const hasGsTagOverride = v.gsTag !== undefined || v.gsTagMode !== undefined;
  const colorZones = varFlag?.colorZones || [];

  // Custom-hex-input row + swatch grid — shared by normal zones and the
  // border zone's independent (toggle-off) state.
  function zonePickerFields(z, hex) {
    return `<div class="ve-custom-row">
        <input type="color" id="veCN-${z.id}" value="${hex || '#1A4A2E'}" oninput="veCSync('${z.id}',this.value)" onchange="veCApply('${z.id}')">
        <input type="text" class="hexin" id="veCH-${z.id}" value="${hex || '#1A4A2E'}" maxlength="7" placeholder="#000000" oninput="veCSyncN('${z.id}',this.value)">
        ${eyedropperBtn(`veEyedropper('${z.id}')`)}
        <button class="cpop-apply" onclick="veCApply('${z.id}')">Apply</button>
      </div>
      <div class="swatch-grid" id="veSg-${z.id}">
        ${allSwatches().map(c => `
          <div class="swatch${c.hex === '#FFFFFF' ? ' ws' : ''}${hex === c.hex ? ' sel' : ''}"
            style="background:${c.hex}" data-hex="${c.hex}" title="${c.name}"
            onclick="vePickColor('${z.id}','${c.hex}')"></div>`).join('')}
      </div>`;
  }

  function zoneChipHtml(z, hex) {
    const namedColor = COLORS.find(c => c.hex === hex);
    return `<div class="color-chip-picked">
      <span class="chip-dot" style="background:${hex};${hex === '#FFFFFF' ? 'border:1px solid var(--gray-200)' : ''}"></span>
      <div class="chip-info">
        <span class="chip-name">${namedColor?.name || hex}</span>
        ${namedColor ? `<span class="chip-hex">${hex}</span>` : ''}
      </div>
      <button class="chip-clear" onclick="veEditZone('${z.id}')">×</button>
    </div>`;
  }

  function renderColorZone(z) {
    if (z.id === 'zone-border') return renderBorderZone(z);

    const hex = varColors[z.id];
    const isExpanded = veExpandedZones.has(z.id);
    if (!isExpanded && hex) {
      return `<div class="color-zone"><div class="zlabel">${z.label}</div>${zoneChipHtml(z, hex)}</div>`;
    }
    return `<div class="color-zone">
      <div class="color-zone-hdr">
        <div class="zlabel">${z.label}</div>
        ${isExpanded && hex ? `<button class="btn-link-small" onclick="veCollapseZone('${z.id}')">Cancel</button>` : ''}
      </div>
      ${zonePickerFields(z, hex)}
    </div>`;
  }

  function renderBorderZone(z) {
    const matches = !('zone-border' in varColors);
    const matchLabel = colorZones.some(zz => zz.id === 'zone-secondary') ? 'Secondary Color' : 'Primary Color';
    const toggle = `<label class="gs-tag-label" style="margin-bottom:8px">
      <input type="checkbox" class="gs-toggle-input" ${matches ? 'checked' : ''} onchange="veToggleBorderMatch(this.checked)">
      <span class="gs-toggle-switch"></span>
      <span class="gs-toggle-text">Match ${matchLabel}</span>
    </label>`;

    if (matches) {
      return `<div class="color-zone"><div class="zlabel">${z.label}</div>${toggle}</div>`;
    }

    const hex = varColors['zone-border'];
    const isExpanded = veExpandedZones.has(z.id);
    if (!isExpanded && hex) {
      return `<div class="color-zone"><div class="zlabel">${z.label}</div>${toggle}${zoneChipHtml(z, hex)}</div>`;
    }
    return `<div class="color-zone">
      <div class="color-zone-hdr">
        <div class="zlabel">${z.label}</div>
        ${isExpanded && hex ? `<button class="btn-link-small" onclick="veCollapseZone('${z.id}')">Cancel</button>` : ''}
      </div>
      ${toggle}
      ${zonePickerFields(z, hex)}
    </div>`;
  }

  el.innerHTML = `
    <div class="ve-editor">
      <div class="ve-section">
        <div class="ve-section-title"><span>Quantity</span></div>
        <div class="qty-stepper">
          <button class="qty-btn" type="button" onclick="veQtyChange(-1)" aria-label="Decrease quantity"><i class="fa-solid fa-minus" aria-hidden="true"></i></button>
          <input class="var-qty-input" type="number" min="1" step="1" id="veQtyInput" value="${v.qty ?? 1}" onchange="veQtySet(this.value)">
          <button class="qty-btn" type="button" onclick="veQtyChange(1)" aria-label="Increase quantity"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
        </div>
      </div>

      ${colorZones.length ? `
      <div class="ve-section">
        <div class="ve-section-title">
          <span>Colors</span>
          ${hasColors ? `<button class="ve-override-badge" onclick="veClearAllColors()">Reset</button>` : ''}
        </div>
        ${colorZones.map(renderColorZone).join('')}
      </div>` : ''}

      <div class="ve-section">
        <div class="ve-section-title">
          <span>GolfStatus tag</span>
          ${hasGsTagOverride ? `<button class="ve-override-badge" onclick="veClearGsTagOverride()">Reset</button>` : ''}
        </div>
        <div class="gs-tag-row">
          <label class="gs-tag-label">
            <input type="checkbox" class="gs-toggle-input" id="veGsTagCheck"
              ${veGsTagEnabled ? 'checked' : ''} onchange="veSetGsTag(this.checked)">
            <span class="gs-toggle-switch"></span>
            <span class="gs-toggle-text">Show GolfStatus tag</span>
          </label>
          <div class="gs-mode-wrap" id="veGsModeWrap"${veGsTagEnabled ? '' : ' style="display:none"'}>
            <button class="gs-mode-btn${veGsTagMode === 'auto' ? ' active' : ''}" id="veGsMode-auto" onclick="veSetGsTagMode('auto')">Auto</button>
            <button class="gs-mode-btn${veGsTagMode === 'dark' ? ' active' : ''}" id="veGsMode-dark" onclick="veSetGsTagMode('dark')">Black</button>
            <button class="gs-mode-btn${veGsTagMode === 'light' ? ' active' : ''}" id="veGsMode-light" onclick="veSetGsTagMode('light')">White</button>
          </div>
        </div>
      </div>

      <div class="ve-section">
        <div class="ve-section-title">
          <span>Flag style</span>
          ${hasFlag ? `<button class="ve-override-badge" onclick="veClearFlag()">Reset</button>` : ''}
        </div>
        <div class="flag-grid ve-flag-grid" id="veFlagGrid">
          ${FLAGS.map(f => `
            <div class="flag-card${varFlag?.id === f.id ? ' selected' : ''}" onclick="vePickFlag('${f.id}')">
              <div class="flag-card-preview">
                <svg viewBox="${f.viewBox || '0 0 7519 4669'}" preserveAspectRatio="xMidYMid meet">${f.svgContent}</svg>
              </div>
              <div class="flag-card-name">${f.name}</div>
            </div>`).join('')}
        </div>
      </div>

      <div class="ve-section" style="border-top:none">
        <button class="ve-reset-link" onclick="resetVarToDefaults()"><i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i> Reset all to project defaults</button>
      </div>
    </div>`;

  refreshVeFlagCards(v);
}

function refreshVeFlagCards(v) {
  const varColors = getVarColors(v);
  const gst = getVarGsTagOpts(v) ?? { enabled: S.gsTag, mode: S.gsTagMode };
  document.querySelectorAll('#veFlagGrid .flag-card').forEach((card, i) => {
    const f = FLAGS[i];
    const svg = card.querySelector('svg');
    if (!svg) return;
    applyColors(svg, varColors, f.noColors, f);
    if (gst.enabled) {
      const keyZone = f.tagKeyZone || 'zone-primary';
      showGsTagVariant(svg, 'front', gst.mode, resolveColors(varColors, f)[keyZone]);
    }
  });
}

window.vePickFlag = function (flagId) {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  v.flagId = flagId;
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

window.veClearFlag = function () {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  delete v.flagId;
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

window.veEditZone = function (zoneId) {
  veExpandedZones.add(zoneId);
  refreshEditPanel();
};

window.veCollapseZone = function (zoneId) {
  const h = document.getElementById('veCH-' + zoneId)?.value || '';
  const c = h.startsWith('#') ? h : '#' + h;
  if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
    vePickColor(zoneId, c);
    return;
  }
  veExpandedZones.delete(zoneId);
  refreshEditPanel();
};

window.vePickColor = function (zoneId, hex) {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  if (!v.colors) v.colors = { ...S.colors };
  v.colors[zoneId] = hex;
  addCustomColor(hex);
  veExpandedZones.delete(zoneId);
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

// ── Apply a customer's requested quick-pick change (see review.js's
// Request-edits quick-picks and the variation_feedback.requested_* columns)
// straight onto a variation. Each one reuses the exact mutation an in-house
// designer override already goes through — flagId/colors assignment as-is.
// Operate on an arbitrary variation (not just whichever one is open in the
// editor) so the edit-requests panel (openFlagEditRequests below) can apply a
// request without first opening that variation's editor panel.
function applyRequestedFlagTo(v, fb) {
  if (!fb?.requested_flag_id) return false;
  v.flagId = fb.requested_flag_id;
  return true;
}

// One zone's requested color, applied on its own — the Colors section
// registers one of these per zone (see zoneColorFields below) rather than a
// single "apply everything" field, so staff can accept e.g. just the primary
// color without also taking the border.
function applyRequestedColorZoneTo(v, fb, zoneId) {
  const hex = fb?.requested_colors?.[zoneId];
  if (!hex) return false;
  if (!v.colors) v.colors = { ...S.colors };
  v.colors[zoneId] = hex;
  addCustomColor(hex);
  return true;
}

// The reviewer's uploaded file already lives in the flag-logos bucket (see
// uploadFeedbackLogo in review.js) but, unlike a staff-uploaded logo, has no
// project_logos row yet — adopt it into the real library (adoptFeedbackLogo)
// so it shows up in the Logos tray for reuse and survives a reload, instead
// of a client-only entry that would otherwise vanish the moment S.library is
// re-fetched from project_logos. Dedupe on storage path so re-applying (or
// "Apply all") doesn't insert a second row for the same file; also drops the
// preview-only placeholder previewVariation may have pushed (see below) so
// the Logos tray doesn't end up with two tiles for the same image. Shared by
// both the plain apply() (below) and the interactive swap picker, since both
// need the exact same adopted entry.
async function ensureRequestedLogoEntry(fb) {
  let entry = S.library.find(l => l.storagePath && l.storagePath === fb.requested_logo_path);
  if (!entry) {
    entry = fb.requested_logo_path
      ? await adoptFeedbackLogo(S.projectId, 'Requested logo', fb.requested_logo_url, fb.requested_logo_path)
      : { id: 'fb-' + fb.id, name: 'Requested logo', src: fb.requested_logo_url };
    S.library = S.library.filter(l => l.id !== 'fb-' + fb.id);
    S.library.push(entry);
    renderVarStrip();
  }
  await preloadLogoAspects([entry]);
  return entry;
}

// Used by both "Apply all" paths (row-wide and panel-wide), which can't stop
// to ask anything — a variation with 0 or 1 logos placed just gets the
// requested one at the usual default placement (unchanged from before); one
// with several gets the FIRST slot's image swapped in place (keeping its
// existing x/y/w) rather than silently collapsing every other placement down
// to just this one. The section's own button instead goes through
// interactiveApply (below) so staff can pick which slot when there's more
// than one — this is only the non-interactive fallback.
async function applyRequestedLogoTo(v, fb) {
  if (!fb?.requested_logo_url) return false;
  const entry = await ensureRequestedLogoEntry(fb);
  if (!Array.isArray(v.logos) || v.logos.length <= 1) {
    v.logos = [{ id: 'pl-' + Date.now(), logoId: entry.id, x: 50, y: 50, w: 75 }];
  } else {
    v.logos[0] = { ...v.logos[0], logoId: entry.id };
  }
  return true;
}

// Sub-view shown in place of the edit-requests list (same container, same
// back-button chrome) when a variation carries more than one placed logo —
// asks which one the requested logo should replace instead of guessing.
// Picking a slot swaps only its logoId, keeping that slot's x/y/w; the back
// button leaves the variation untouched. Either way, control returns to
// openFlagEditRequests so the list re-renders from current state.
function renderLogoSwapPicker(container, v, fb, entry) {
  container.innerHTML = `
    <div class="hs-menu-section-header">
      <button class="hs-menu-back" id="lspBack"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back</button>
      <span class="hs-menu-section-title">Replace which logo?</span>
    </div>
    <div class="erm-sub">"${esc(v.name || 'Variation')}" has more than one logo placed — pick the one the requested logo should replace.</div>
    <div class="erm-list" id="lspList"></div>`;
  container.querySelector('#lspBack').addEventListener('click', () => window.openFlagEditRequests(v.id));
  const list = container.querySelector('#lspList');
  v.logos.forEach((logo, idx) => {
    const row = document.createElement('div');
    row.className = 'erm-row';
    row.innerHTML = `
      <div class="erm-thumb" id="lsp-thumb-${idx}"></div>
      <div class="erm-row-actions"><button type="button" class="erm-apply-all-btn" data-idx="${idx}">Replace this logo</button></div>`;
    list.appendChild(row);
    paintVarThumb(row.querySelector(`#lsp-thumb-${idx}`), { ...v, logos: [logo] });
  });
  list.querySelectorAll('[data-idx]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      v.logos[idx] = { ...v.logos[idx], logoId: entry.id };
      markDirty();
      refreshVarThumbs();
      if (v.id === S.activeVarId) renderVarCanvas();
      await window.saveDraft();
      await resolveFeedback(S.projectId, 'flags', v.id);
      fb.resolved = true;
      updateEditRequestsBanner();
      window.openFlagEditRequests(v.id);
    });
  });
}

// The Logo section's own button goes through this instead of plain apply()
// so it can ask which slot to replace when there's more than one — see
// renderLogoSwapPicker above. With 0 or 1 logos there's nothing to ask, so
// it applies immediately (still through ensureRequestedLogoEntry, so both
// paths adopt the exact same library entry) and refreshes the panel itself,
// same as the picker's own choice does.
async function applyRequestedLogoInteractive(v, fb) {
  if (!fb?.requested_logo_url) return;
  const entry = await ensureRequestedLogoEntry(fb);
  if (!Array.isArray(v.logos) || v.logos.length <= 1) {
    v.logos = [{ id: 'pl-' + Date.now(), logoId: entry.id, x: 50, y: 50, w: 75 }];
    markDirty();
    refreshVarThumbs();
    if (v.id === S.activeVarId) renderVarCanvas();
    await window.saveDraft();
    await resolveFeedback(S.projectId, 'flags', v.id);
    fb.resolved = true;
    updateEditRequestsBanner();
    window.openFlagEditRequests(v.id);
    return;
  }
  const container = document.getElementById('varEditRequestsPanel');
  if (!container) return;
  renderLogoSwapPicker(container, v, fb, entry);
}

// A placeholder-only library entry so the combined preview below can resolve
// a requested logo's image (findLogo/render.js needs an S.library entry, not
// a raw src) before staff have actually applied anything — never persisted;
// applyRequestedLogoTo drops it once a real, adopted entry exists.
function previewLogoEntry(fb) {
  const id = 'fb-' + fb.id;
  let entry = S.library.find(l => l.id === id);
  if (!entry) {
    entry = { id, name: 'Requested logo', src: fb.requested_logo_url };
    S.library.push(entry);
  }
  return entry;
}

// A throwaway copy of `v` with every present requested_* field merged on
// top — never mutates the real variation — so the row's combined preview
// shows what it would look like with everything applied together, not just
// its current (unmodified) state.
function previewVariation(v, fb) {
  const preview = { ...v };
  if (fb?.requested_flag_id) preview.flagId = fb.requested_flag_id;
  if (fb?.requested_colors) preview.colors = { ...(v.colors || S.colors), ...fb.requested_colors };
  if (fb?.requested_logo_url) {
    const entry = previewLogoEntry(fb);
    preview.logos = [{ id: 'preview-logo', logoId: entry.id, x: 50, y: 50, w: 75 }];
  }
  return preview;
}

// Every zone id any flag template defines, mapped to its label ("zone-primary"
// → "Primary Color") — a flat lookup across ALL of FLAGS rather than just the
// current style, since a customer's requested colors were keyed against
// whichever flag was active when they left feedback, which may not be this
// variation's flag style right now. Zone ids/labels are consistent across
// templates in practice (see data.js), so one global map covers every case.
const ZONE_LABELS = {};
FLAGS.forEach(f => (f.colorZones || []).forEach(z => { ZONE_LABELS[z.id] = z.label; }));

// One .erm-section per zone actually present in ANY pending request in this
// panel (not just this row) — Colors stops being a single lumped-together
// field so staff can accept, say, just the primary color without also
// taking the border (see applyRequestedColorZoneTo above).
function zoneColorFields() {
  const zoneIds = new Set();
  (S.feedback || []).forEach(fb => {
    if (fb.status === 'needs_edits') Object.keys(fb.requested_colors || {}).forEach(id => zoneIds.add(id));
  });
  return [...zoneIds].map(zoneId => ({
    key: 'color-' + zoneId,
    sectionLabel: ZONE_LABELS[zoneId] || zoneId,
    has: fb => !!fb.requested_colors?.[zoneId],
    apply: (v, fb) => applyRequestedColorZoneTo(v, fb, zoneId),
    preview: (el, fb) => {
      const hex = fb.requested_colors?.[zoneId];
      const safe = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : '#cccccc';
      el.innerHTML = `
        <div class="erm-color-editor">
          <div class="erm-color-dot" style="background:${safe}"></div>
          <input type="text" class="hexin" value="${esc(hex || '')}" readonly>
        </div>`;
    },
  }));
}

// ── "View edits" — reachable two ways, both opening the same in-panel
// sub-view (edit-requests-panel.js) in place of the right-hand "All
// variations" list: a specific variation's own "View edits" link (its card,
// via variation-list.js's onViewEdits) passes that variation's id to show
// just its request; the canvas banner's "View all edits" (project-global —
// see updateEditRequestsBanner) omits it to show every open request.
window.openFlagEditRequests = function (variationId) {
  const container = document.getElementById('varEditRequestsPanel');
  if (!container) return;
  document.getElementById('varListView').style.display = 'none';
  document.getElementById('varEditPanel').style.display = 'none';
  container.style.display = '';
  renderEditRequestsPanel(container, {
    variations: S.variations,
    feedback: S.feedback || [],
    renderThumb: (el, v, fb) => paintVarThumb(el, previewVariation(v, fb)),
    filterVariationId: variationId,
    fields: [
      {
        key: 'flag', sectionLabel: 'Flag', has: fb => !!fb.requested_flag_id, apply: (v, fb) => applyRequestedFlagTo(v, fb),
        preview: (el, fb) => {
          const f = FLAGS.find(x => x.id === fb.requested_flag_id);
          if (!f) return;
          el.innerHTML = `<div class="erm-style-preview"><svg viewBox="${f.viewBox || '0 0 7519 4669'}" preserveAspectRatio="xMidYMid meet">${f.svgContent}</svg></div>`;
          const svg = el.querySelector('svg');
          if (svg) applyColors(svg, { ...S.colors, ...(fb.requested_colors || {}) }, f.noColors, f);
        },
      },
      ...zoneColorFields(),
      {
        key: 'logo', sectionLabel: 'Logos', has: fb => !!fb.requested_logo_url, apply: (v, fb) => applyRequestedLogoTo(v, fb),
        interactiveApply: (v, fb) => applyRequestedLogoInteractive(v, fb),
        preview: (el, fb) => { el.innerHTML = `<img src="${esc(fb.requested_logo_url)}" alt="">`; },
      },
    ],
    resolve: vid => resolveFeedback(S.projectId, 'flags', vid),
    onApplied: v => {
      markDirty();
      refreshVarThumbs();
      if (v.id === S.activeVarId) renderVarCanvas();
      updateEditRequestsBanner();
    },
    persist: () => window.saveDraft(),
    onBack: window.closeFlagEditRequests,
  });
};

window.closeFlagEditRequests = function () {
  const container = document.getElementById('varEditRequestsPanel');
  if (container) container.style.display = 'none';
  document.getElementById('varListView').style.display = '';
  renderVarList();
};

// Global (project-wide, not scoped to the active variation) banner shown
// above the canvas whenever ANY variation has an open edit request — the
// entry point into the unfiltered edit-requests panel regardless of which
// variation happens to be selected. A specific variation's own request is
// reachable from its card instead (see the "View edits" link wired in
// renderVarList above).
function updateEditRequestsBanner() {
  const noteEl = document.getElementById('varEditNote');
  const noteTextEl = document.getElementById('varEditNoteText');
  if (!noteEl || !noteTextEl) return;
  const pending = (S.feedback || []).filter(f => f.status === 'needs_edits' && !f.resolved && S.variations.some(v => v.id === f.variation_id)).length;
  noteEl.style.display = pending ? '' : 'none';
  if (pending) noteTextEl.textContent = `${pending} variation${pending === 1 ? '' : 's'} need${pending === 1 ? 's' : ''} edits`;
}

window.veToggleBorderMatch = function (matches) {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  if (matches) {
    if (v.colors) delete v.colors['zone-border'];
  } else {
    if (!v.colors) v.colors = { ...S.colors };
    if (!('zone-border' in v.colors)) v.colors['zone-border'] = null; // independent — nothing chosen yet
  }
  veExpandedZones.delete('zone-border');
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

function commitVeQty(next) {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  v.qty = Math.max(1, next);
  const input = document.getElementById('veQtyInput');
  if (input) input.value = v.qty;
  renderVarList();
  markDirty();
}

window.veQtyChange = function (delta) {
  const base = parseInt(document.getElementById('veQtyInput')?.value, 10) || 1;
  commitVeQty(base + delta);
};

window.veQtySet = function (val) {
  commitVeQty(parseInt(val, 10) || 1);
};

window.veClearAllColors = function () {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  delete v.colors;
  veExpandedZones.clear();
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

window.veCSync = function (zoneId, h) {
  const ch = document.getElementById('veCH-' + zoneId);
  if (ch) ch.value = h;
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  if (!v.colors) v.colors = { ...S.colors };
  v.colors[zoneId] = h;
  renderVarCanvas();
  refreshVarThumbs();
  markDirty();
};

window.veCSyncN = function (zoneId, h) {
  const c = h.startsWith('#') ? h : '#' + h;
  if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
    const cn = document.getElementById('veCN-' + zoneId);
    if (cn) cn.value = c;
  }
};

window.veCApply = function (zoneId) {
  const h = document.getElementById('veCH-' + zoneId)?.value || '';
  const c = h.startsWith('#') ? h : '#' + h;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  vePickColor(zoneId, c);
};

window.veSetGsTag = function (enabled) {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  v.gsTag = enabled;
  const modeWrap = document.getElementById('veGsModeWrap');
  if (modeWrap) modeWrap.style.display = enabled ? '' : 'none';
  renderVarCanvas();
  refreshVarThumbs();
  refreshVeFlagCards(v);
  markDirty();
};

window.veSetGsTagMode = function (mode) {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  v.gsTagMode = mode;
  ['auto', 'dark', 'light'].forEach(m => {
    document.getElementById('veGsMode-' + m)?.classList.toggle('active', m === mode);
  });
  renderVarCanvas();
  refreshVarThumbs();
  refreshVeFlagCards(v);
  markDirty();
};

window.veClearGsTagOverride = function () {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  delete v.gsTag;
  delete v.gsTagMode;
  delete v.gsTagColor;
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

window.resetVarToDefaults = function () {
  const v = S.variations.find(v => v.id === editingVarId);
  if (!v) return;
  delete v.flagId;
  delete v.colors;
  delete v.gsTag;
  delete v.gsTagMode;
  delete v.gsTagColor;
  veExpandedZones.clear();
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

function refreshEditPanel() {
  if (!editingVarId) return;
  const v = S.variations.find(v => v.id === editingVarId);
  if (v) renderVarFlagRow(v);
}

function openVarEdit(varId) {
  editingVarId = varId;
  S.activeVarId = varId;
  renderVarList();
  renderVarCanvas();
  document.getElementById('varListView').style.display = 'none';
  document.getElementById('varEditPanel').style.display = '';
  const v = S.variations.find(v => v.id === varId);
  const titleEl = document.getElementById('varEditPanelTitle');
  if (titleEl) titleEl.textContent = v?.name || 'Edit Variation';
  renderVarFlagRow(v);
}

window.closeVarEdit = function () {
  editingVarId = null;
  veExpandedZones.clear();
  document.getElementById('varListView').style.display = '';
  document.getElementById('varEditPanel').style.display = 'none';
  if (isDirty) window.saveDraft();
};

// renderBackMirrorPreview() swaps in a plain <svg> (via makeSvg) with no id,
// so restore the persistent #varSvg element before renderDropZones needs it
// again — renderDropZones bails out silently if its svgId isn't found.
function ensureVarSvg() {
  const wrap = document.getElementById('varWrap');
  if (wrap && !document.getElementById('varSvg')) {
    wrap.innerHTML = '<svg class="bsvg" id="varSvg" viewBox="0 0 1000 750" preserveAspectRatio="xMidYMid meet"></svg>';
  }
}

// Static, non-interactive mirror of the front — same math export uses
// (makeSvg with mirrorX=true), so the preview always matches the print output.
// Text is deliberately NOT baked into this SVG (unlike logos) — it's drawn as
// an HTML overlay instead (via renderFlagTextOverlaysStatic), using the exact
// same markup as the interactive editor, so it doesn't visibly shift/resize
// the moment "Same Front & Back Design" gets toggled off and this same text
// becomes the live, draggable overlay.
function renderBackMirrorPreview(v, varFlag, varColors, gsTagOpts) {
  const wrap = document.getElementById('varWrap');
  if (!wrap) return;
  // Stale drop-zone context (from the last editable render) would otherwise
  // still accept drags onto this read-only mirror — block it explicitly.
  // .dz-frame-overlay is renderDropZones' separate <svg> holding the front's
  // border + GS tag (unmirrored, at the front's position) — left in place,
  // it stays layered on top of this mirrored back render.
  wrap._dzReadonly = true;
  wrap.querySelectorAll('.dzone, .dz-badge, .dz-frame-overlay').forEach(d => d.remove());
  const [vbW, vbH] = (varFlag.viewBox || '0 0 7519 4669').split(' ').slice(2).map(Number);
  wrap.style.aspectRatio = vbW + ' / ' + vbH;
  // Only S.textLayers (template-level) bakes into the SVG here — v.textLayers
  // is drawn separately below via renderFlagTextOverlaysStatic. Passing
  // withMasterText(v) (which also includes v.textLayers) would bake the
  // variation's own text into the SVG *and* draw it again as the overlay,
  // showing it twice, offset (SVG baseline metrics vs. HTML line-height).
  const svg = makeSvg(v.logos, '100%', '100%', 'back', true, varFlag, varColors, S.textLayers || [], gsTagOpts, S.imageLayers || []);
  const old = document.getElementById('varSvg');
  if (!svg) { if (old) old.remove(); return; }
  svg.id = 'varSvg';
  svg.classList.add('bsvg');
  svg.style.cssText = 'display:block;width:100%;height:100%';
  if (old) old.replaceWith(svg); else wrap.appendChild(svg);
  // makeSvg's own showGsTagVariant call ran on this <svg> before it was
  // attached above, so the tag's mirror-center lookup (getBBox()) couldn't
  // measure real geometry and fell back to an approximation — visibly
  // shifting the tag versus the same call made on the (already-attached)
  // independent-back canvas. Re-run it now that the SVG is in the document.
  const gst = gsTagOpts ?? { enabled: S.gsTag, mode: S.gsTagMode };
  if (gst.enabled) {
    const keyZone = varFlag.tagKeyZone || 'zone-primary';
    showGsTagVariant(svg, 'back', gst.mode, resolveColors(varColors, varFlag)[keyZone]);
  }
  renderFlagTextOverlaysStatic('varWrap', v.textLayers || [], true);
}

function renderVarCanvas() {
  const v = S.variations.find(v => v.id === S.activeVarId);
  const emptyEl = document.getElementById('varCanvasEmpty');
  const zoomWrap = document.getElementById('flagZoomWrap');
  if (!v) {
    if (emptyEl) emptyEl.style.display = '';
    if (zoomWrap) zoomWrap.style.display = 'none';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  if (zoomWrap) zoomWrap.style.display = '';

  const varFlag = getVarFlag(v);
  if (!varFlag) return;

  if (!v.backAssignment) v.backAssignment = {};
  updateFaceUI();

  if (!Array.isArray(v.logos))     v.logos     = [];
  if (!Array.isArray(v.backLogos)) v.backLogos = [];
  if (!Array.isArray(v.textLayers)) v.textLayers = [];
  if (!Array.isArray(v.backTextLayers)) v.backTextLayers = [];
  const varColors = getVarColors(v);
  const gsTagOpts = getVarGsTagOpts(v);
  const onChange = () => { refreshVarThumbs(); markDirty(); };

  if (activeFace === 'back' && sameSidesOf(v)) {
    // Derived, read-only mirror of the front — matches what export produces
    // (makeSvg's `mirrorX`), so there's nothing here to drag/select.
    // clearFlagTextOverlays drops the front's selection/toolbar state before
    // renderBackMirrorPreview draws its own static (non-interactive) text.
    clearFlagTextOverlays('varWrap');
    renderBackMirrorPreview(v, varFlag, varColors, gsTagOpts);
  } else if (activeFace === 'front') {
    ensureVarSvg();
    renderDropZones('varWrap', 'varSvg', v.logos, 'front', onChange, varFlag, varColors, gsTagOpts);
    renderFlagTextOverlays('varWrap', v.textLayers, onChange);
  } else {
    // Independent back — starts blank when "Same Front & Back Design" is
    // switched off, then holds only whatever the user places here directly;
    // it never tracks the front once independent.
    ensureVarSvg();
    renderDropZones('varWrap', 'varSvg', v.backLogos, 'back', onChange, varFlag, varColors, gsTagOpts);
    renderFlagTextOverlays('varWrap', v.backTextLayers, onChange);
  }

}

function setupVariations() {
  // Migrate old assignment-based variations to the new logos array format
  S.variations.forEach(v => {
    if (!Array.isArray(v.logos)) {
      v.logos = v.assignment
        ? Object.values(v.assignment).flatMap(data => {
            const ld = typeof data === 'string' ? { id: data, x: 50, y: 50, w: 80 } : data;
            return ld?.id ? [{ id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2), logoId: ld.id, x: ld.x ?? 50, y: ld.y ?? 50, w: ld.w ?? 80 }] : [];
          })
        : [];
      delete v.assignment;
    }
    if (!Array.isArray(v.backLogos)) {
      v.backLogos = v.backAssignment
        ? Object.values(v.backAssignment).flatMap(data => {
            const ld = typeof data === 'string' ? { id: data, x: 50, y: 50, w: 80 } : data;
            return ld?.id ? [{ id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2), logoId: ld.id, x: ld.x ?? 50, y: ld.y ?? 50, w: ld.w ?? 80 }] : [];
          })
        : [];
      delete v.backAssignment;
    }
  });
  if (!S.variations.length) {
    S.variations.push({ id: crypto.randomUUID(), name: 'Variation 1', logos: [], backLogos: [], sameLogoOnBothSides: defaultSameSides });
    redistributeQty();
  }
  if (!S.activeVarId) S.activeVarId = S.variations[0].id;
  // Project already has exactly one logo of its own (e.g. synced straight
  // from the order intake / GolfStatus event) but no one has placed anything
  // yet — place it for them instead of leaving the canvas empty until they
  // drag it from the strip. Only fires while the active variation is
  // untouched, so it never overwrites a placement someone already made.
  // Checked against the project's own (non-shared) logos specifically, since
  // S.library also carries this user's logos from other projects (see
  // mergeLibraries()).
  const ownLogos = S.library.filter(l => !l.shared);
  if (ownLogos.length === 1) {
    const v = S.variations.find(v => v.id === S.activeVarId);
    if (v && Array.isArray(v.logos) && v.logos.length === 0) {
      v.logos.push({ id: 'pl-' + Date.now(), logoId: ownLogos[0].id, x: 50, y: 50, w: 75, aboveFrame: false });
      markDirty();
    }
  }
  activeFace = 'front';
  syncLogoLayoutToggle();
  updateFaceUI();
  renderVarList();
  renderVarCanvas();
  renderVarStrip();
  document.getElementById('saveDesignsBtn')?.classList.toggle('dirty', isDirty);
  updateEditRequestsBanner();
  if (S.projectId) {
    getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderVarList(); renderVarCanvas(); updateEditRequestsBanner(); }).catch(() => {});
  }
}

window.addFlagText = function () {
  const v = S.variations.find(v => v.id === S.activeVarId);
  if (!v) return;
  if (!Array.isArray(v.textLayers)) v.textLayers = [];
  if (!Array.isArray(v.backTextLayers)) v.backTextLayers = [];
  // The mirrored back view is read-only — nothing to add to there, so fall
  // back to front (matches openVarAddMenu's logo behavior below). Independent
  // back editing gets its own text layers, same as it gets its own logos.
  if (activeFace === 'back' && sameSidesOf(v)) window.setActiveFace('front');
  const target = activeFace === 'back' ? v.backTextLayers : v.textLayers;
  addFlagTextLayer(target, 'varWrap', () => { refreshVarThumbs(); markDirty(); });
};

// Header "+" button — there's no in-canvas add affordance anymore, so this is
// the only entry point for adding text or a logo to the active variation.
window.openVarAddMenu = function (e) {
  e.stopPropagation();
  // The mirrored back view is read-only (nothing to add to) — fall back to front.
  const v = S.variations.find(v => v.id === S.activeVarId);
  if (activeFace === 'back' && sameSidesOf(v)) window.setActiveFace('front');
  triggerAdd(e.currentTarget);
};

window.addVariation = function () {
  const nv = { id: crypto.randomUUID(), name: 'Variation ' + (S.variations.length + 1), logos: [], backLogos: [], textLayers: [], backTextLayers: [], sameLogoOnBothSides: defaultSameSides };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  redistributeQty();
  renderVarList();
  renderVarCanvas();
  markDirty();
};

function dupVar(id) {
  const src = S.variations.find(v => v.id === id);
  if (!src) return;
  const newLogos = src.logos.map(l => ({ ...l, id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2) }));
  const newTextLayers = src.textLayers.map(l => ({ ...l, id: 'ftl-' + Date.now() + '-' + Math.random().toString(36).slice(2) }));
  const nv = {
    id: crypto.randomUUID(), name: src.name + ' copy',
    logos: newLogos,
    backLogos: (src.backLogos || []).map(l => ({ ...l, id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2) })),
    textLayers: newTextLayers,
    backTextLayers: (src.backTextLayers || []).map(l => ({ ...l, id: 'ftl-' + Date.now() + '-' + Math.random().toString(36).slice(2) })),
  };
  if (src.flagId) nv.flagId = src.flagId;
  if (src.colors) nv.colors = { ...src.colors };
  nv.sameLogoOnBothSides = sameSidesOf(src);
  S.variations.push(nv);
  S.activeVarId = nv.id;
  redistributeQty();
  renderVarList();
  renderVarCanvas();
  markDirty();
}

function delVar(id) {
  S.variations = S.variations.filter(v => v.id !== id);
  if (S.activeVarId === id) S.activeVarId = S.variations[0]?.id || null;
  S.feedback = (S.feedback || []).filter(f => f.variation_id !== id);
  redistributeQty();
  renderVarList();
  renderVarCanvas();
  updateEditRequestsBanner();
  markDirty();
  deleteFeedbackForVariation(S.projectId, 'flags', id).catch(() => {});
}

function renameVar(id, name) {
  const v = S.variations.find(v => v.id === id);
  if (v) v.name = name;
  if (editingVarId === id) {
    const titleEl = document.getElementById('varEditPanelTitle');
    if (titleEl) titleEl.textContent = name;
  }
  markDirty();
}

// ── Project name ───────────────────────────────────────────

window.setProjectName = function (val) {
  S.projectName = val;
  markDirty();
};

// ── Save & navigate ────────────────────────────────────────

window.saveDraft = async function () {
  const btn = document.getElementById('saveDesignsBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="save-spin"></span>'; }
  try {
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

window.goToGallery = async function () {
  await window.saveDraft();
  if (S.projectId) navigateTo('flags-gallery?project=' + S.projectId);
};

// ── Init ──────────────────────────────────────────────────

renderSidebar(document.getElementById('sidebar'), {
  projectType: 'Tournament Flags',
  activeStep: 2,
  logosTile: true,
  projectId: new URLSearchParams(window.location.search).get('project'),
  steps: [
    {
      id: 'navDesign', label: 'Design', desc: 'Style, colors & logos',
      onClick: async () => {
        const p = new URLSearchParams(window.location.search).get('project');
        await window.saveDraft?.();
        navigateTo('flags' + (p ? '?project=' + p : ''));
      },
    },
    { id: 'navVariations', label: 'Variations', desc: 'Build combinations' },
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
      <div class="ptitle">Variations</div>
      <div class="psub">Select a variation, then drag logos into zones or use the buttons to add content.</div>
    </div>
    <div class="p1-header-actions">
      <div id="logoLayoutRow" style="display:none">
        <div class="face-toggle-row">
          <button class="face-tab active" id="layoutBtnSingle" onclick="setLogoLayout('single')">Full logo</button>
          <button class="face-tab" id="layoutBtnMulti" onclick="setLogoLayout('multi')">Multi</button>
        </div>
      </div>
      <button class="btn sm" id="backToDesignBtn" onclick="backToDesign()" style="display:none"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Design</button>
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
        <button class="btn sm" id="saveDesignsBtn" onclick="saveDraft()" style="display:none">Save draft</button>
        <div id="saveStatus" style="font-size:11px;color:var(--gray-400);text-align:center;min-height:14px"></div>
      </div>
      <button class="btn primary" onclick="goToGallery()">Review <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
    </div>
  </div>`;
renderLogosTileShell('Logos', 'varStrip');

window.backToDesign = async function () {
  const p = new URLSearchParams(window.location.search).get('project');
  await window.saveDraft?.();
  navigateTo('flags' + (p ? '?project=' + p : ''));
};

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (!_urlProject) { window.location.href = '/'; }

await loadAllFlags(FLAGS);

try {
  const project = await loadProject(_urlProject);
  const [logos, sharedLogos, flagCfg, intake] = await Promise.all([
    loadLogosForProject(_urlProject),
    listUserLogos(project.created_by),
    loadFlagConfig(_urlProject).catch(() => null),
    loadOrderIntake(_urlProject).catch(() => null),
  ]);
  orderFlagQty = intake?.flag_qty || null;
  // Applies only to a variation created from here on (setupVariations'
  // initial variation, addVariation) — never overrides one that already has
  // its own sameLogoOnBothSides. Derived unconditionally (not just for a
  // brand-new project) since design.js can itself create an empty flagCfg
  // (Save draft) before any variation exists yet, in which case flagCfg is
  // already truthy below but there's still nothing to preserve a value from.
  if (intake) defaultSameSides = intake.flag_setup !== 'different';

  // Same customer lock as design.js - see the comment there. Gated on
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
  await preloadLogoAspects(S.library);
  if (flagCfg) {
    S.flagId = flagCfg.flag_id;
    S.colors = flagCfg.colors || {};
    const varData = flagCfg.variations || [];
    const varItems = Array.isArray(varData) ? varData : (varData.items || []);
    S.variations = varItems.map(v => ({ ...v }));
    S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
    S.gsTag = Array.isArray(varData) ? true : (varData.gsTag ?? true);
    S.gsTagMode = Array.isArray(varData) ? 'auto' : (varData.gsTagMode ?? 'auto');
    S.gsTagColor = Array.isArray(varData) ? '#ffffff' : (varData.gsTagColor ?? '#ffffff');
    S.textLayers = Array.isArray(varData) ? [] : (varData.textLayers || []);
    S.imageLayers = Array.isArray(varData) ? [] : (varData.imageLayers || []);
    await preloadLogoAspects(S.imageLayers);
    // "Same Front & Back Design" used to be one project-wide flag
    // (flag_config.same_logo_on_both_sides) — now every variation carries
    // its own (see toggleSameSides). A variation saved before this migration
    // has no field of its own, so seed it from the old project-wide value
    // once, here, rather than silently defaulting to true and hiding
    // whatever independent back content it already had.
    S.variations.forEach(v => {
      if (v.sameLogoOnBothSides === undefined) v.sameLogoOnBothSides = flagCfg.same_logo_on_both_sides ?? true;
    });
    S.activeVarId = S.variations[0]?.id || null;
  }
  setSidebarProjectName(S.projectName, S.projectId);

  // Subscribe to feedback updates
  S.feedback = await getFeedback(S.projectId, 'flags').catch(() => []);
  supabase
    .channel('fb-var-' + S.projectId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_feedback', filter: `project_id=eq.${S.projectId}` },
      () => getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderVarList(); renderVarCanvas(); updateEditRequestsBanner(); }).catch(() => {}))
    .subscribe();

  const _hashId = decodeURIComponent(window.location.hash.replace(/^#var-/, ''));
  if (_hashId && S.variations.some(v => v.id === _hashId)) S.activeVarId = _hashId;

  setupVariations();
  if (_hashId) {
    requestAnimationFrame(() => {
      document.querySelector('.var-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  requestAnimationFrame(flagCanvas.refit);
} catch (err) {
  console.error('Could not load project', err);
}

