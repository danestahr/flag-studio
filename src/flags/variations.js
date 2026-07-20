import '../style.css';
import '../icons.js';
import { requireAuth } from '../auth.js';

await requireAuth();

import { S, setDragLogoId } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, applyColors, renderInto, showGsTagVariant, makeSvg, resolveColors, preloadLogoAspects } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  loadProject, saveFlagConfig, loadFlagConfig,
  uploadLogo, loadLogosForProject, deleteLogo,
  getFeedback, resolveFeedback, supabase,
} from '../supabase.js';
import { initDropZones, renderDropZones, hideZoneToolbar, triggerAdd } from './drop-zones.js';
import { renderFlagTextOverlays, addFlagTextLayer, clearFlagTextOverlays, renderFlagTextOverlaysStatic } from './text-layers.js';
import { eyedropperBtn, pickEyedropperColor } from '../eyedropper.js';
import { esc } from '../dom-utils.js';
import { renderSidebar, setSidebarProjectName } from '../sidebar.js';
import { renderLogoTray } from '../logo-tray.js';
import { renderVariationList, refreshVariationThumbs } from '../variation-list.js';
import { renderCanvasPanel } from '../canvas-panel.js';

let isDirty = false;
let activeFace = 'front';
let editingVarId = null;
let veExpandedZones = new Set();

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
      const logo = await uploadLogo(S.projectId, file);
      const idx = S.library.findIndex(l => l.id === tempId);
      if (idx !== -1) S.library[idx] = logo;
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
    try { await deleteLogo(logo.storagePath, logo.id); } catch (err) { console.error('Storage delete failed', err); }
  }
};

async function removeBgFromFlagLogo(logo, onProgress) {
  onProgress?.('loading');
  const { removeBackground } = await import('@imgly/background-removal');
  const blob = await removeBackground(logo.src);
  const file = new File([blob], logo.name.replace(/\.[^.]+$/, '') + ' (no bg).png', { type: 'image/png' });
  onProgress?.('uploading');
  return uploadLogo(S.projectId, file);
}

function renderVarStrip() {
  renderLogoTray(document.getElementById('varStrip'), {
    library: S.library,
    fileInputId: 'varFile',
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
  if (sameCheck) sameCheck.checked = S.sameLogoOnBothSides;
}

window.setActiveFace = function (face) {
  if (face === activeFace) return;
  activeFace = face;
  renderVarCanvas();
};

window.resolveEdit = async function () {
  const v = S.variations.find(v => v.id === S.activeVarId);
  if (!v || !S.projectId) return;
  try {
    await resolveFeedback(S.projectId, 'flags', v.id);
    const fb = S.feedback?.find(f => f.variation_id === v.id);
    if (fb) fb.resolved = true;
    renderVarList();
    renderVarCanvas();
  } catch (err) { console.error('Could not resolve feedback:', err); }
};

// Mirror a front logo's center-fraction x into the back's independent copy —
// matches makeSvg's mirrorX math (`1 - layer.x/100`) so the logo doesn't jump
// when the toggle flips it from a baked mirror to an editable copy. `srcId`
// ties this back copy to the front layer it was seeded from, so syncBackLogos
// can tell "already has an independent copy" from "front added this since".
function mirrorLogoLayer(l) {
  return { ...l, x: 100 - l.x, id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2), srcId: l.id };
}

// Mirror a front text layer's box (left edge `x` + width `w`) and flip its
// alignment — matches makeSvg's mirrored text-anchor math, so the seeded back
// copy renders at the exact spot the read-only mirror preview showed it at.
function mirrorTextLayer(l) {
  const align = l.align === 'left' ? 'right' : l.align === 'right' ? 'left' : l.align;
  return { ...l, x: 100 - l.x - l.w, align, id: 'ftl-' + Date.now() + '-' + Math.random().toString(36).slice(2), srcId: l.id };
}

// Keeps the independent back's item *set* in lockstep with the front — every
// front logo/text layer gets a mirrored back counterpart the moment it
// exists, and counterparts for since-removed front items are dropped. Each
// counterpart's position stays wherever it was independently dragged to;
// only the set of items (not their placement) tracks the front. Called on
// every render while independent, so logos/text added to the front *after*
// the toggle was switched off still show up on the back, instead of only
// whatever existed at the moment of the toggle.
//
// Back items with no `srcId` are either genuinely back-only (added directly
// on the independent canvas's own "+" menu) or pre-date this front/back
// linkage — for those, adopt one into the first still-unlinked front logo
// using the same underlying image instead of creating a duplicate, so
// whatever position it already had (mirrored or manually placed) survives
// the upgrade instead of getting a second, redundant copy.
function syncBackLogos(v) {
  if (!Array.isArray(v.logos)) v.logos = [];
  if (!Array.isArray(v.backLogos)) v.backLogos = [];
  v.backLogos = v.backLogos.filter(bl => !bl.srcId || v.logos.some(l => l.id === bl.srcId));
  const unlinked = v.backLogos.filter(bl => !bl.srcId);
  v.logos.forEach(l => {
    if (v.backLogos.some(bl => bl.srcId === l.id)) return;
    const idx = unlinked.findIndex(bl => bl.logoId === l.logoId);
    if (idx >= 0) { unlinked[idx].srcId = l.id; unlinked.splice(idx, 1); }
    else v.backLogos.push(mirrorLogoLayer(l));
  });
}
window.toggleSameSides = function (checked) {
  const v = S.variations.find(v => v.id === S.activeVarId);
  S.sameLogoOnBothSides = checked;
  if (v) {
    if (checked) {
      // Back goes back to being a derived mirror of the front — drop whatever
      // was independently placed on the back so it doesn't reappear (stale)
      // the next time this is toggled off. (Logos re-seed themselves via
      // syncBackLogos on the next render; text is seeded explicitly below,
      // once, the next time this is switched off.)
      v.backLogos = [];
      v.backTextLayers = [];
    } else {
      // Text is a one-time seed, not a running sync like logos — unlike
      // logos (which usually should stay identical on both sides, just
      // independently positioned), front/back text is often meant to read
      // differently, so text typed on the front *after* this point should
      // NOT keep pushing onto the back.
      v.backTextLayers = (v.textLayers || []).map(mirrorTextLayer);
    }
  }
  renderVarCanvas();
  refreshVarThumbs();
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

let _flagZoom = 100;

const flagCanvas = renderCanvasPanel(document.getElementById('flagCanvasPanel'), {
  panelId: 'flagCanvasPanel',
  scrollId: 'flagCanvasScroll',
  wrapId: 'flagZoomWrap',
  zoomValueId: 'flagZoomValue',
  zoomResetId: 'flagZoomReset',
  aspect: 7519 / 4669,
  getZoom: () => _flagZoom,
  setZoom: v => { _flagZoom = v; },
  headerName: 'Variation 1',
  headerNameId: 'activeVarName',
  onAdd: e => window.openVarAddMenu(e),
  addBtnId: 'varAddBtn',
  noteHtml: `
    <div id="varEditNote" class="var-edit-note" style="display:none">
      <div class="var-edit-note-body">
        <span class="var-edit-note-label">Edit requested:</span>
        <span id="varEditNoteText"></span>
      </div>
      <button class="var-edit-resolve-btn" id="varEditResolveBtn" onclick="resolveEdit()">Mark as resolved</button>
      <span class="var-edit-resolved-tag" id="varEditResolvedTag" style="display:none">Resolved</span>
    </div>`,
  faceToggleHidden: false,
  faceTabFrontId: 'faceTabFront',
  faceTabBackId: 'faceTabBack',
  onFaceChange: face => window.setActiveFace(face),
  sameSidesRowId: 'sameSidesRow',
  sameSidesCheckId: 'sameSidesCheck',
  onToggleSameSides: checked => window.toggleSameSides(checked),
  canvasContentHtml: `
    <div class="flag-wrap" id="varWrap">
      <svg class="bsvg" id="varSvg" viewBox="0 0 1000 750" preserveAspectRatio="xMidYMid meet"></svg>
    </div>`,
  description: "Logos placed in the grey bleed margin will be trimmed off and won't appear on the printed flag.",
});

const varThumbId = v => 'vt-' + v.id;
const paintVarThumb = (el, v) => renderInto(el, v.logos || [], 'front', false, getVarFlag(v), getVarColors(v), v.textLayers || [], getVarGsTagOpts(v));

function renderVarList() {
  renderVariationList(document.getElementById('varList'), S.variations, {
    activeId: S.activeVarId,
    thumbId: varThumbId,
    renderThumb: paintVarThumb,
    feedbackFor: v => S.feedback?.find(f => f.variation_id === v.id),
    onSelect: v => selectVar(v.id),
    onRename: (v, name) => renameVar(v.id, name),
    onEdit: v => openVarEdit(v.id),
    onDuplicate: v => dupVar(v.id),
    onDelete: v => delVar(v.id),
    onQtyChange: (v, qty) => { v.qty = qty; markDirty(); },
  });
}

function refreshVarThumbs() {
  refreshVariationThumbs(S.variations, varThumbId, paintVarThumb);
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
        ${COLORS.map(c => `
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
  veExpandedZones.delete(zoneId);
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

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
  wrap._dzReadonly = true;
  wrap.querySelectorAll('.dzone, .dz-badge').forEach(d => d.remove());
  const [vbW, vbH] = (varFlag.viewBox || '0 0 7519 4669').split(' ').slice(2).map(Number);
  wrap.style.aspectRatio = vbW + ' / ' + vbH;
  const svg = makeSvg(v.logos, '100%', '100%', 'back', true, varFlag, varColors, [], gsTagOpts);
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
  const nameEl = document.getElementById('activeVarName');
  const emptyEl = document.getElementById('varCanvasEmpty');
  const zoomWrap = document.getElementById('flagZoomWrap');
  if (!v) {
    if (nameEl) nameEl.textContent = '—';
    if (emptyEl) emptyEl.style.display = '';
    if (zoomWrap) zoomWrap.style.display = 'none';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  if (zoomWrap) zoomWrap.style.display = '';
  if (nameEl) nameEl.textContent = v.name;

  const varFlag = getVarFlag(v);
  if (!varFlag) return;

  if (!v.backAssignment) v.backAssignment = {};
  updateFaceUI();

  if (!Array.isArray(v.logos))     v.logos     = [];
  if (!Array.isArray(v.backLogos)) v.backLogos = [];
  if (!Array.isArray(v.textLayers)) v.textLayers = [];
  if (!Array.isArray(v.backTextLayers)) v.backTextLayers = [];
  // Independent back: reconcile the *logo* set against the front on every
  // render, so logos added to (or removed from) the front after the toggle
  // was switched off still show up (or disappear) on the back. Text is
  // deliberately NOT synced this way — see toggleSameSides.
  if (!S.sameLogoOnBothSides) {
    syncBackLogos(v);
  }
  const varColors = getVarColors(v);
  const gsTagOpts = getVarGsTagOpts(v);
  const onChange = () => { refreshVarThumbs(); markDirty(); };

  if (activeFace === 'back' && S.sameLogoOnBothSides) {
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
    // Independent back — its own text layers, seeded from the front when the
    // "Same Front & Back Design" toggle was switched off, editable here just
    // like the front's.
    ensureVarSvg();
    renderDropZones('varWrap', 'varSvg', v.backLogos, 'back', onChange, varFlag, varColors, gsTagOpts);
    renderFlagTextOverlays('varWrap', v.backTextLayers, onChange);
  }

  const fb = S.feedback?.find(f => f.variation_id === v.id);
  const noteEl = document.getElementById('varEditNote');
  const noteTextEl = document.getElementById('varEditNoteText');
  const resolveBtn = document.getElementById('varEditResolveBtn');
  const resolvedTag = document.getElementById('varEditResolvedTag');
  if (noteEl && noteTextEl) {
    if (fb?.status === 'needs_edits') {
      noteTextEl.textContent = fb.note || 'Client requested edits for this variation.';
      noteEl.style.display = '';
      noteEl.classList.toggle('resolved', !!fb.resolved);
      if (resolveBtn) resolveBtn.style.display = fb.resolved ? 'none' : '';
      if (resolvedTag) resolvedTag.style.display = fb.resolved ? '' : 'none';
    } else {
      noteEl.style.display = 'none';
    }
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
    S.variations.push({ id: 'v' + Date.now(), name: 'Variation 1', logos: [], backLogos: [] });
  }
  if (!S.activeVarId) S.activeVarId = S.variations[0].id;
  activeFace = 'front';
  syncLogoLayoutToggle();
  updateFaceUI();
  renderVarList();
  renderVarCanvas();
  renderVarStrip();
  document.getElementById('saveDesignsBtn')?.classList.toggle('dirty', isDirty);
  if (S.projectId) {
    getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderVarList(); renderVarCanvas(); }).catch(() => {});
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
  if (activeFace === 'back' && S.sameLogoOnBothSides) window.setActiveFace('front');
  const target = activeFace === 'back' ? v.backTextLayers : v.textLayers;
  addFlagTextLayer(target, 'varWrap', () => { refreshVarThumbs(); markDirty(); });
};

// Header "+" button — there's no in-canvas add affordance anymore, so this is
// the only entry point for adding text or a logo to the active variation.
window.openVarAddMenu = function (e) {
  e.stopPropagation();
  // The mirrored back view is read-only (nothing to add to) — fall back to front.
  if (activeFace === 'back' && S.sameLogoOnBothSides) window.setActiveFace('front');
  triggerAdd(e.currentTarget);
};

window.addVariation = function () {
  const nv = { id: 'v' + Date.now(), name: 'Variation ' + (S.variations.length + 1), logos: [], backLogos: [], textLayers: [], backTextLayers: [] };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  renderVarList();
  renderVarCanvas();
  markDirty();
};

function dupVar(id) {
  const src = S.variations.find(v => v.id === id);
  if (!src) return;
  // Map each cloned front item's old id -> new id, so backLogos/backTextLayers
  // (linked to the front by srcId) can be remapped to still point at their
  // counterpart instead of looking orphaned and getting re-seeded from scratch.
  const logoIdMap = new Map();
  const newLogos = src.logos.map(l => {
    const nid = 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    logoIdMap.set(l.id, nid);
    return { ...l, id: nid };
  });
  const textIdMap = new Map();
  const newTextLayers = src.textLayers.map(l => {
    const nid = 'ftl-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    textIdMap.set(l.id, nid);
    return { ...l, id: nid };
  });
  // Back items with no srcId were added directly on the back (no front
  // counterpart) — carry them over as-is instead of dropping them.
  const nv = {
    id: 'v' + Date.now(), name: src.name + ' copy',
    logos: newLogos,
    backLogos: (src.backLogos || []).map(l => {
      const clone = { ...l, id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2) };
      if (l.srcId) clone.srcId = logoIdMap.get(l.srcId);
      return clone;
    }),
    textLayers: newTextLayers,
    backTextLayers: (src.backTextLayers || []).map(l => {
      const clone = { ...l, id: 'ftl-' + Date.now() + '-' + Math.random().toString(36).slice(2) };
      if (l.srcId) clone.srcId = textIdMap.get(l.srcId);
      return clone;
    }),
  };
  if (src.flagId) nv.flagId = src.flagId;
  if (src.colors) nv.colors = { ...src.colors };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  renderVarList();
  renderVarCanvas();
  markDirty();
}

function delVar(id) {
  S.variations = S.variations.filter(v => v.id !== id);
  if (S.activeVarId === id) S.activeVarId = S.variations[0]?.id || null;
  renderVarList();
  renderVarCanvas();
  markDirty();
}

function selectVar(id) { S.activeVarId = id; renderVarList(); renderVarCanvas(); }

function renameVar(id, name) {
  const v = S.variations.find(v => v.id === id);
  if (v) v.name = name;
  const nameEl = document.getElementById('activeVarName');
  if (S.activeVarId === id && nameEl) nameEl.textContent = name;
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
  if (S.projectId) window.location.href = 'flags-gallery.html?project=' + S.projectId;
};

// ── Init ──────────────────────────────────────────────────

renderSidebar(document.getElementById('sidebar'), {
  projectType: 'Tournament Flags',
  activeStep: 2,
  projectId: new URLSearchParams(window.location.search).get('project'),
  steps: [
    {
      id: 'navDesign', label: 'Design', desc: 'Style, colors & logos',
      onClick: async () => {
        const p = new URLSearchParams(window.location.search).get('project');
        await window.saveDraft?.();
        window.location.href = 'flags.html' + (p ? '?project=' + p : '');
      },
    },
    { id: 'navVariations', label: 'Variations', desc: 'Build combinations' },
    {
      id: 'navGallery', label: 'Gallery', desc: 'Review & export',
      onClick: async () => {
        const p = new URLSearchParams(window.location.search).get('project');
        if (!p) return;
        await window.saveDraft?.();
        window.location.href = 'flags-gallery.html?project=' + p;
      },
    },
  ],
});

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (!_urlProject) { window.location.href = '/'; }

await loadAllFlags(FLAGS);

try {
  const [project, logos, flagCfg] = await Promise.all([
    loadProject(_urlProject),
    loadLogosForProject(_urlProject),
    loadFlagConfig(_urlProject).catch(() => null),
  ]);
  S.projectId = project.id;
  S.projectName = project.name || '';
  S.library = logos;
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
    S.sameLogoOnBothSides = flagCfg.same_logo_on_both_sides ?? true;
    S.activeVarId = S.variations[0]?.id || null;
  }
  setSidebarProjectName(S.projectName, S.projectId);

  // Subscribe to feedback updates
  S.feedback = await getFeedback(S.projectId, 'flags').catch(() => []);
  supabase
    .channel('fb-var-' + S.projectId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_feedback', filter: `project_id=eq.${S.projectId}` },
      () => getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderVarList(); renderVarCanvas(); }).catch(() => {}))
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

