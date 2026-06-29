import '../style.css';
import { requireAuth } from '../auth.js';

await requireAuth();

import { S, setDragLogoId } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, applyColors, renderInto } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import { loadGsTag } from '../gsTag.js';
import {
  loadProject, saveFlagConfig, loadFlagConfig,
  uploadLogo, loadLogosForProject, deleteLogo,
  getFeedback, resolveFeedback, supabase,
} from '../supabase.js';
import { initDropZones, renderDropZones, hideZoneToolbar } from './drop-zones.js';
import { renderFlagTextOverlays, addFlagTextLayer } from './text-layers.js';

let isDirty = false;
let activeFace = 'front';
let editingVarId = null;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

// ── Logo library (strip) ───────────────────────────────────

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
};

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

window.dragStart = function (e, id) {
  setDragLogoId(id);
  e.dataTransfer.effectAllowed = 'copy';
  document.getElementById('li-' + id)?.classList.add('dragging');
};
window.dragEnd = function (id) { document.getElementById('li-' + id)?.classList.remove('dragging'); };

function renderVarStrip() {
  const strip = document.getElementById('varStrip');
  if (!strip) return;
  const uploadBtn = strip.querySelector('.var-upload-btn');
  const fileInput = strip.querySelector('#varFile');
  strip.innerHTML = '';
  if (uploadBtn) strip.appendChild(uploadBtn);
  if (fileInput) strip.appendChild(fileInput);
  S.library.forEach(l => {
    const el = document.createElement('div');
    el.className = `var-lib-item${l.uploading ? ' uploading' : ''}`;
    el.draggable = !l.uploading;
    el.title = l.name;
    el.setAttribute('ondragstart', `dragStart(event,'${l.id}')`);
    el.setAttribute('ondragend', `dragEnd('${l.id}')`);
    el.innerHTML = `<img src="${l.src}" alt="${l.name}">${l.uploading ? '' : `<button class="var-lib-del" title="Delete" onclick="event.stopPropagation();delLogo('${l.id}')">×</button>`}`;
    strip.appendChild(el);
  });
}

// ── Variations ─────────────────────────────────────────────

function updateFaceTabs() {
  document.getElementById('singleCanvas').style.display = S.sameLogoOnBothSides ? '' : 'none';
  document.getElementById('dualCanvas').style.display   = S.sameLogoOnBothSides ? 'none' : '';
}

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

window.toggleDiffSides = function (checked) {
  S.sameLogoOnBothSides = !checked;
  activeFace = 'front';
  updateFaceTabs();
  renderVarCanvas();
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

// Fit canvas-scroll to remaining viewport height and, at 100% zoom, cap the
// flag width so its height fills that space rather than the panel width.
function resizeCanvasToViewport() {
  const scroll = document.getElementById('flagCanvasScroll');
  const wrap   = document.getElementById('flagZoomWrap');
  if (!scroll || !wrap) return;
  const top   = scroll.getBoundingClientRect().top;
  const avail = Math.max(150, window.innerHeight - top - 24);
  scroll.style.maxHeight = avail + 'px';
  if (_flagZoom === 100) {
    // Cap wrap width so flag height = avail (flag aspect ≈ 7519:4669 = 1.610)
    wrap.style.maxWidth = Math.floor(avail * 7519 / 4669) + 'px';
  }
}

function applyFlagZoom(pct) {
  _flagZoom = pct;
  const wrap = document.getElementById('flagZoomWrap');
  const label = document.getElementById('flagZoomValue');
  const reset = document.getElementById('flagZoomReset');
  if (wrap) {
    wrap.style.width = pct + '%';
    wrap.style.maxWidth = pct === 100 ? '' : 'none';
  }
  if (pct === 100) resizeCanvasToViewport();
  if (label) label.textContent = pct + '%';
  if (reset) reset.style.display = pct === 100 ? 'none' : '';
}

window.setFlagZoom = function (val) {
  applyFlagZoom(Math.max(40, Math.min(400, parseInt(val, 10) || 100)));
};

(function wireFlagCanvasZoom() {
  const setup = () => {
    const scroll = document.getElementById('flagCanvasScroll');
    if (!scroll || scroll.__zoomWired) return;
    scroll.__zoomWired = true;
    scroll.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const wrap = document.getElementById('flagZoomWrap');
      if (!wrap) return;
      const before = wrap.getBoundingClientRect();
      if (!before.width || !before.height) return;
      const fracX = (e.clientX - before.left) / before.width;
      const fracY = (e.clientY - before.top)  / before.height;
      const oldZoom = _flagZoom;
      const factor = 1 + Math.max(-0.25, Math.min(0.25, -e.deltaY * 0.005));
      const newZoom = Math.max(40, Math.min(400, Math.round(oldZoom * factor)));
      if (newZoom === oldZoom) return;
      applyFlagZoom(newZoom);
      const after = wrap.getBoundingClientRect();
      scroll.scrollLeft += (after.left + fracX * after.width) - e.clientX;
      scroll.scrollTop  += (after.top  + fracY * after.height) - e.clientY;
    }, { passive: false });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();

function renderVarList() {
  const el = document.getElementById('varList');
  if (!el) return;
  el.innerHTML = S.variations.map(v => {
    const fb = S.feedback?.find(f => f.variation_id === v.id);
    const fbClass = fb?.status === 'needs_edits' && !fb?.resolved ? ' needs-edits' : fb?.status === 'approved' ? ' approved' : '';
    const statusTile = fb?.status === 'approved'
      ? '<span class="var-status-tile approved">✓ Approved</span>'
      : (fb?.status === 'needs_edits' && !fb?.resolved)
        ? '<span class="var-status-tile needs-edits">Needs edits</span>'
        : '<span class="var-status-tile not-reviewed">Not reviewed</span>';
    const qty = v.qty ?? 1;
    return `
    <div class="var-card${v.id === S.activeVarId ? ' active' : ''}${fbClass}" onclick="selectVar('${v.id}')">
      <div class="var-card-left">
        <div class="vthumb" id="vt-${v.id}"></div>
        <div style="display:flex;flex-direction:column;gap:3px;min-width:0;flex:1">
          <input class="vname" value="${esc(v.name)}" onclick="event.stopPropagation()"
            onchange="renameVar('${v.id}',this.value)">
          ${statusTile}
          <div class="var-qty-row" onclick="event.stopPropagation()">
            <label class="var-qty-label">Qty</label>
            <input class="var-qty-input" type="number" min="1" step="1" value="${qty}"
              onchange="setVarQty('${v.id}', this.value)">
          </div>
        </div>
      </div>
      <div class="var-btns">
        <button class="vbtn" title="Edit style &amp; colors" onclick="event.stopPropagation();openVarEdit('${v.id}')">✎</button>
        <button class="vbtn" title="Duplicate" onclick="event.stopPropagation();dupVar('${v.id}')">⧉</button>
        <button class="vbtn" title="Delete" onclick="event.stopPropagation();delVar('${v.id}')">✕</button>
      </div>
    </div>`;
  }).join('');
  refreshVarThumbs();
}

function refreshVarThumbs() {
  S.variations.forEach(v => {
    const el = document.getElementById('vt-' + v.id);
    if (!el) return;
    renderInto(el, v.logos || [], 'front', false, getVarFlag(v), getVarColors(v), v.textLayers || []);
  });
}

function renderVarFlagRow(v) {
  const el = document.getElementById('varEditPanelBody');
  if (!el) return;
  const varFlag = getVarFlag(v);
  const varColors = getVarColors(v);
  const hasFlag = !!v.flagId;
  const hasColors = !!v.colors;

  const primaryHex = varColors['zone-primary'];
  const secondaryHex = varColors['zone-secondary'];
  const primaryName = COLORS.find(c => c.hex === primaryHex)?.name || primaryHex || '—';
  const secondaryName = COLORS.find(c => c.hex === secondaryHex)?.name || secondaryHex || '';
  const hasPrimaryOverride = hasColors && !!v.colors?.['zone-primary'];
  const hasSecondaryOverride = hasColors && !!v.colors?.['zone-secondary'];

  el.innerHTML = `
    <div class="var-flag-row">
      <div class="var-flag-chip-wrap" id="vfStyleWrap">
        <span class="var-flag-label">Style</span>
        <button class="var-flag-chip${hasFlag ? ' override' : ''}" onclick="openVarFlagPicker('${v.id}',event)">
          ${varFlag?.name || 'None'}
          ${hasFlag ? `<button class="chip-clear" onclick="event.stopPropagation();clearVarFlag('${v.id}')">×</button>` : ''}
        </button>
        <div id="varFlagPickerPanel" class="var-flag-picker-panel" style="display:none"></div>
      </div>
      ${varFlag && !varFlag.noColors ? `
      <div class="var-flag-chip-wrap" id="vfPrimaryWrap">
        <span class="var-flag-label">Primary</span>
        <button class="var-flag-chip${hasPrimaryOverride ? ' override' : ''}" onclick="openVarColorPicker('${v.id}','zone-primary',event)">
          ${primaryHex ? `<span class="chip-dot" style="background:${primaryHex};${primaryHex === '#FFFFFF' ? 'border:1px solid #ccc' : ''}"></span>${primaryName}` : '—'}
          ${hasPrimaryOverride ? `<button class="chip-clear" onclick="event.stopPropagation();clearVarColor('${v.id}','zone-primary')">×</button>` : ''}
        </button>
        <div id="varColorPickerPanelPrimary" class="var-color-picker-panel" style="display:none"></div>
      </div>
      ${varFlag.colorZones?.length > 1 ? `
      <div class="var-flag-chip-wrap" id="vfSecondaryWrap">
        <span class="var-flag-label">Secondary</span>
        <button class="var-flag-chip${hasSecondaryOverride ? ' override' : ''}" onclick="openVarColorPicker('${v.id}','zone-secondary',event)">
          ${secondaryHex ? `<span class="chip-dot" style="background:${secondaryHex};${secondaryHex === '#FFFFFF' ? 'border:1px solid #ccc' : ''}"></span>${secondaryName}` : '—'}
          ${hasSecondaryOverride ? `<button class="chip-clear" onclick="event.stopPropagation();clearVarColor('${v.id}','zone-secondary')">×</button>` : ''}
        </button>
        <div id="varColorPickerPanelSecondary" class="var-color-picker-panel" style="display:none"></div>
      </div>` : ''}` : ''}
    </div>`;
}

window.openVarFlagPicker = function (varId, e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('varFlagPickerPanel');
  if (!panel) return;
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  closeVarPickers();
  const v = S.variations.find(v => v.id === varId);
  const varColors = getVarColors(v);
  panel.innerHTML = `<div class="var-mini-flag-grid">${FLAGS.map(f => `
    <div class="var-mini-flag-card${v?.flagId === f.id ? ' selected' : ''}" onclick="setVarFlagId('${varId}','${f.id}')">
      <svg viewBox="${f.viewBox || '0 0 7519 4669'}" preserveAspectRatio="xMidYMid meet">${f.svgContent}</svg>
      <div class="var-mini-flag-name">${f.name}</div>
    </div>`).join('')}</div>`;
  panel.style.display = 'block';
  panel.querySelectorAll('.var-mini-flag-card').forEach((card, i) => {
    const f = FLAGS[i];
    const svg = card.querySelector('svg');
    if (svg) applyColors(svg, varColors, f.noColors);
  });
};

window.setVarFlagId = function (varId, flagId) {
  const v = S.variations.find(v => v.id === varId);
  if (!v) return;
  v.flagId = flagId;
  closeVarPickers();
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

window.clearVarFlag = function (varId) {
  const v = S.variations.find(v => v.id === varId);
  if (!v) return;
  delete v.flagId;
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

window.openVarColorPicker = function (varId, zoneId, e) {
  if (e) e.stopPropagation();
  const panelId = zoneId === 'zone-primary' ? 'varColorPickerPanelPrimary' : 'varColorPickerPanelSecondary';
  const panel = document.getElementById(panelId);
  if (!panel) return;
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  closeVarPickers();
  const v = S.variations.find(v => v.id === varId);
  const currentHex = getVarColors(v)[zoneId];
  panel.innerHTML = `<div class="swatch-grid">${COLORS.map(c => `
    <div class="swatch${c.hex === '#FFFFFF' ? ' ws' : ''}${currentHex === c.hex ? ' sel' : ''}"
      style="background:${c.hex}" title="${c.name}"
      onclick="setVarColor('${varId}','${zoneId}','${c.hex}')"></div>`).join('')}</div>`;
  panel.style.display = 'block';
};

window.setVarColor = function (varId, zoneId, hex) {
  const v = S.variations.find(v => v.id === varId);
  if (!v) return;
  if (!v.colors) v.colors = { ...S.colors };
  v.colors[zoneId] = hex;
  closeVarPickers();
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

window.clearVarColor = function (varId, zoneId) {
  const v = S.variations.find(v => v.id === varId);
  if (!v || !v.colors) return;
  delete v.colors[zoneId];
  if (Object.keys(v.colors).length === 0) delete v.colors;
  renderVarCanvas();
  refreshVarThumbs();
  refreshEditPanel();
  markDirty();
};

function closeVarPickers() {
  ['varFlagPickerPanel', 'varColorPickerPanelPrimary', 'varColorPickerPanelSecondary'].forEach(id => {
    const p = document.getElementById(id);
    if (p) p.style.display = 'none';
  });
}

function refreshEditPanel() {
  if (!editingVarId) return;
  const v = S.variations.find(v => v.id === editingVarId);
  if (v) renderVarFlagRow(v);
}

window.openVarEdit = function (varId) {
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
};

window.closeVarEdit = function () {
  editingVarId = null;
  closeVarPickers();
  document.getElementById('varListView').style.display = '';
  document.getElementById('varEditPanel').style.display = 'none';
};

function renderVarCanvas() {
  const v = S.variations.find(v => v.id === S.activeVarId);
  const nameEl = document.getElementById('activeVarName');
  if (!v) { if (nameEl) nameEl.textContent = '—'; return; }
  if (nameEl) nameEl.textContent = v.name;

  const varFlag = getVarFlag(v);
  if (!varFlag) return;

  if (!v.backAssignment) v.backAssignment = {};
  updateFaceTabs();

  if (!Array.isArray(v.logos))     v.logos     = [];
  if (!Array.isArray(v.backLogos)) v.backLogos = [];
  const varColors = getVarColors(v);
  const onChange = () => { refreshVarThumbs(); markDirty(); };

  if (!Array.isArray(v.textLayers)) v.textLayers = [];

  if (S.sameLogoOnBothSides) {
    renderDropZones('varWrap', 'varSvg', v.logos, 'front', onChange, varFlag, varColors);
    renderFlagTextOverlays('varWrap', v.textLayers, onChange);
  } else {
    renderDropZones('varWrapFront', 'varSvgFront', v.logos, 'front', onChange, varFlag, varColors);
    renderFlagTextOverlays('varWrapFront', v.textLayers, onChange);
    renderDropZones('varWrapBack',  'varSvgBack',  v.backLogos, 'back', onChange, varFlag, varColors);
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
  const cb = document.getElementById('diffSidesCheck');
  if (cb) cb.checked = !S.sameLogoOnBothSides;
  syncLogoLayoutToggle();
  updateFaceTabs();
  renderVarList();
  renderVarCanvas();
  renderVarStrip();
  document.getElementById('saveDesignsBtn')?.classList.toggle('dirty', isDirty);
  if (S.projectId) {
    getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderVarList(); renderVarCanvas(); }).catch(() => {});
  }
}

window.toggleVarAddMenu = function (e) {
  e.stopPropagation();
  const menu = document.getElementById('varAddMenu');
  if (!menu) return;
  menu.style.display = menu.style.display === 'none' ? '' : 'none';
};

window.closeVarAddMenu = function () {
  const menu = document.getElementById('varAddMenu');
  if (menu) menu.style.display = 'none';
};

window.addLogoToCanvas = function () {
  const wrapId = S.sameLogoOnBothSides ? 'varWrap' : 'varWrapFront';
  const dzBtn = document.querySelector('#' + wrapId + ' .dz-add-btn');
  if (dzBtn) { dzBtn.click(); return; }
  if (!S.library.length) document.getElementById('varFile').click();
};

window.addFlagText = function () {
  const v = S.variations.find(v => v.id === S.activeVarId);
  if (!v) return;
  if (!Array.isArray(v.textLayers)) v.textLayers = [];
  const wrapId = S.sameLogoOnBothSides ? 'varWrap' : 'varWrapFront';
  addFlagTextLayer(v.textLayers, wrapId, () => { refreshVarThumbs(); markDirty(); });
};

window.addVariation = function () {
  const nv = { id: 'v' + Date.now(), name: 'Variation ' + (S.variations.length + 1), logos: [], backLogos: [], textLayers: [] };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  renderVarList();
  renderVarCanvas();
  markDirty();
};

window.dupVar = function (id) {
  const src = S.variations.find(v => v.id === id);
  if (!src) return;
  const nv = {
    id: 'v' + Date.now(), name: src.name + ' copy',
    logos: src.logos.map(l => ({ ...l, id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2) })),
    backLogos: (src.backLogos || []).map(l => ({ ...l, id: 'pl-' + Date.now() + '-' + Math.random().toString(36).slice(2) })),
    textLayers: (src.textLayers || []).map(l => ({ ...l, id: 'ftl-' + Date.now() + '-' + Math.random().toString(36).slice(2) })),
  };
  if (src.flagId) nv.flagId = src.flagId;
  if (src.colors) nv.colors = { ...src.colors };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  renderVarList();
  renderVarCanvas();
  markDirty();
};

window.delVar = function (id) {
  S.variations = S.variations.filter(v => v.id !== id);
  if (S.activeVarId === id) S.activeVarId = S.variations[0]?.id || null;
  renderVarList();
  renderVarCanvas();
  markDirty();
};

window.selectVar = function (id) { S.activeVarId = id; renderVarList(); renderVarCanvas(); };

window.renameVar = function (id, name) {
  const v = S.variations.find(v => v.id === id);
  if (v) v.name = name;
  const nameEl = document.getElementById('activeVarName');
  if (S.activeVarId === id && nameEl) nameEl.textContent = name;
  if (editingVarId === id) {
    const titleEl = document.getElementById('varEditPanelTitle');
    if (titleEl) titleEl.textContent = name;
  }
  markDirty();
};

window.setVarQty = function (id, val) {
  const v = S.variations.find(v => v.id === id);
  if (!v) return;
  v.qty = Math.max(1, parseInt(val, 10) || 1);
  markDirty();
};

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
      btn.innerHTML = '<span class="save-check">✓</span>';
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

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (!_urlProject) { window.location.href = '/'; }

await Promise.all([loadAllFlags(FLAGS), loadGsTag()]);

try {
  const [project, logos, flagCfg] = await Promise.all([
    loadProject(_urlProject),
    loadLogosForProject(_urlProject),
    loadFlagConfig(_urlProject).catch(() => null),
  ]);
  S.projectId = project.id;
  S.projectName = project.name || '';
  S.library = logos;
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
  const nameDisplay = document.getElementById('projectNameDisplay');
  if (nameDisplay) nameDisplay.textContent = S.projectName || '—';

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
  requestAnimationFrame(resizeCanvasToViewport);
} catch (err) {
  console.error('Could not load project', err);
}

window.addEventListener('resize', resizeCanvasToViewport);

document.addEventListener('click', e => {
  if (!e.target.closest('#varEditPanelBody')) closeVarPickers();
  if (!e.target.closest('#varAddBtn') && !e.target.closest('#varAddMenu')) closeVarAddMenu();
});
