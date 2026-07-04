import '../style.css';
import { requireAuth } from '../auth.js';

await requireAuth();

import { S, setDragLogoId } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, applyColors, renderInto, showGsTagVariant, makeSvg, resolveColors } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  loadProject, saveFlagConfig, loadFlagConfig,
  uploadLogo, loadLogosForProject, deleteLogo,
  getFeedback, resolveFeedback, supabase,
} from '../supabase.js';
import { initDropZones, renderDropZones, hideZoneToolbar, triggerAdd } from './drop-zones.js';
import { renderFlagTextOverlays, addFlagTextLayer } from './text-layers.js';

let isDirty = false;
let activeFace = 'front';
let editingVarId = null;
let veExpandedZones = new Set();

const _SUPPORTS_EYEDROPPER = typeof window !== 'undefined' && 'EyeDropper' in window;
const _EYEDROPPER_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 7l6 6"/><path d="M14 4l3 3a2.121 2.121 0 0 1 0 3l-1.5 1.5-6-6L11 4a2.121 2.121 0 0 1 3 0z"/><path d="M9.5 8.5L3 15v3h3l6.5-6.5"/></svg>`;
window.runEyedropper = async function (inputId) {
  if (!('EyeDropper' in window)) return;
  try {
    const r = await new window.EyeDropper().open();
    const inp = document.getElementById(inputId);
    if (!inp) return;
    inp.value = r.sRGBHex;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  } catch { /* user canceled */ }
};
window.veEyedropper = async function (zoneId) {
  if (!('EyeDropper' in window)) return;
  try {
    const r = await new window.EyeDropper().open();
    vePickColor(zoneId, r.sRGBHex);
  } catch { /* user canceled */ }
};

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

function getVarGsTagOpts(v) {
  if (!v || (v.gsTag === undefined && v.gsTagMode === undefined)) return null;
  return { enabled: v.gsTag ?? S.gsTag, mode: v.gsTagMode ?? S.gsTagMode };
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

async function removeBgFromFlagLogo(logo, onProgress) {
  onProgress?.('loading');
  const { removeBackground } = await import('@imgly/background-removal');
  const blob = await removeBackground(logo.src);
  const file = new File([blob], logo.name.replace(/\.[^.]+$/, '') + ' (no bg).png', { type: 'image/png' });
  onProgress?.('uploading');
  return uploadLogo(S.projectId, file);
}

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
    el.id = 'li-' + l.id;
    el.title = l.name;
    el.addEventListener('dragstart', e => { setDragLogoId(l.id); e.dataTransfer.effectAllowed = 'copy'; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); });
    const img = document.createElement('img');
    img.src = l.src;
    img.alt = l.name;
    el.appendChild(img);
    if (!l.uploading) {
      const delBtn = document.createElement('button');
      delBtn.className = 'var-lib-del';
      delBtn.title = 'Delete';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', e => { e.stopPropagation(); delLogo(l.id); });
      el.appendChild(delBtn);

      const bgremBtn = document.createElement('button');
      bgremBtn.className = 'var-lib-bgrem';
      bgremBtn.title = 'Remove background';
      bgremBtn.textContent = '✦';
      bgremBtn.addEventListener('click', async e => {
        e.stopPropagation();
        bgremBtn.textContent = '…';
        bgremBtn.disabled = true;
        try {
          const newLogo = await removeBgFromFlagLogo(l, s => { bgremBtn.textContent = s === 'uploading' ? '↑' : '…'; });
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
        } catch (err) {
          console.error('Background removal failed', err);
          bgremBtn.textContent = '✦';
          bgremBtn.disabled = false;
        }
      });
      el.appendChild(bgremBtn);
    }
    strip.appendChild(el);
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

window.toggleSameSides = function (checked) {
  S.sameLogoOnBothSides = checked;
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
      <div class="var-card-top">
        <input class="vname" value="${esc(v.name)}" onclick="event.stopPropagation()"
          onchange="renameVar('${v.id}',this.value)">
        <div class="var-btns">
          <button class="vbtn" title="Edit style &amp; colors" onclick="event.stopPropagation();openVarEdit('${v.id}')">✎</button>
          <button class="vbtn" title="Duplicate" onclick="event.stopPropagation();dupVar('${v.id}')">⧉</button>
          <button class="vbtn" title="Delete" onclick="event.stopPropagation();delVar('${v.id}')">✕</button>
        </div>
      </div>
      <div class="var-card-bottom">
        <div class="vthumb" id="vt-${v.id}"></div>
        <div class="var-card-meta">
          ${statusTile}
          <div class="var-qty-row" onclick="event.stopPropagation()">
            <div class="qty-stepper">
              <button class="qty-btn" onclick="event.stopPropagation();adjustVarQty('${v.id}',-1)">−</button>
              <input class="var-qty-input" id="vqty-${v.id}" type="number" min="1" step="1" value="${qty}"
                onchange="setVarQty('${v.id}',this.value)">
              <button class="qty-btn" onclick="event.stopPropagation();adjustVarQty('${v.id}',1)">+</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
  refreshVarThumbs();
}

function refreshVarThumbs() {
  S.variations.forEach(v => {
    const el = document.getElementById('vt-' + v.id);
    if (!el) return;
    renderInto(el, v.logos || [], 'front', false, getVarFlag(v), getVarColors(v), v.textLayers || [], getVarGsTagOpts(v));
  });
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
        <input type="color" id="veCN-${z.id}" value="${hex || '#1A4A2E'}" oninput="veCSync('${z.id}',this.value)">
        <input type="text" class="hexin" id="veCH-${z.id}" value="${hex || '#1A4A2E'}" maxlength="7" placeholder="#000000" oninput="veCSyncN('${z.id}',this.value)">
        ${_SUPPORTS_EYEDROPPER ? `<button type="button" class="eyedropper-btn" onclick="veEyedropper('${z.id}')" title="Pick color from screen">${_EYEDROPPER_SVG}</button>` : ''}
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
        <button class="ve-reset-link" onclick="resetVarToDefaults()">↺ Reset all to project defaults</button>
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
function renderBackMirrorPreview(v, varFlag, varColors, gsTagOpts) {
  const wrap = document.getElementById('varWrap');
  if (!wrap) return;
  // Stale drop-zone context (from the last editable render) would otherwise
  // still accept drags onto this read-only mirror — block it explicitly.
  wrap._dzReadonly = true;
  wrap.querySelectorAll('.dzone, .dz-badge').forEach(d => d.remove());
  const [vbW, vbH] = (varFlag.viewBox || '0 0 7519 4669').split(' ').slice(2).map(Number);
  wrap.style.aspectRatio = vbW + ' / ' + vbH;
  const svg = makeSvg(v.logos, '100%', '100%', 'back', true, varFlag, varColors, v.textLayers || [], gsTagOpts);
  const old = document.getElementById('varSvg');
  if (!svg) { if (old) old.remove(); return; }
  svg.id = 'varSvg';
  svg.classList.add('bsvg');
  svg.style.cssText = 'display:block;width:100%;height:100%';
  if (old) old.replaceWith(svg); else wrap.appendChild(svg);
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
  const varColors = getVarColors(v);
  const gsTagOpts = getVarGsTagOpts(v);
  const onChange = () => { refreshVarThumbs(); markDirty(); };

  if (!Array.isArray(v.textLayers)) v.textLayers = [];

  if (activeFace === 'back' && S.sameLogoOnBothSides) {
    // Derived, read-only mirror of the front — matches what export produces
    // (makeSvg's `mirrorX`), so there's nothing here to drag/select.
    renderBackMirrorPreview(v, varFlag, varColors, gsTagOpts);
  } else if (activeFace === 'front') {
    ensureVarSvg();
    renderDropZones('varWrap', 'varSvg', v.logos, 'front', onChange, varFlag, varColors, gsTagOpts);
    renderFlagTextOverlays('varWrap', v.textLayers, onChange);
  } else {
    ensureVarSvg();
    renderDropZones('varWrap', 'varSvg', v.backLogos, 'back', onChange, varFlag, varColors, gsTagOpts);
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
  // Text only ever lives on the front — jump there so the new layer is visible.
  if (activeFace === 'back') window.setActiveFace('front');
  addFlagTextLayer(v.textLayers, 'varWrap', () => { refreshVarThumbs(); markDirty(); });
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

window.adjustVarQty = function (id, delta) {
  const v = S.variations.find(v => v.id === id);
  if (!v) return;
  v.qty = Math.max(1, (v.qty ?? 1) + delta);
  const input = document.getElementById('vqty-' + id);
  if (input) input.value = v.qty;
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

