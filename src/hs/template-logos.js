import { HS, UI, eyedropperBtn } from './state.js';
import { renderStep1, updateStep1Preview } from './design.js';
import { renderEditor } from './var-editor.js';
import { renderVariationPreview } from './var-canvas.js';
import { prepareLogo } from './logo-utils.js';
import { HS_H, HS_TPL_LOGO_MAX, HS_TPL_LOGO_MIN, HS_W, emptyTemplateLogos, normalizeTplLogoSize } from '../hole-sign-data.js';
import { HS_TPL_LOGO_SAFE_FRAC, escXml, getTemplateLogoSlots, slotWidthForRatio } from '../hole-sign-render.js';
import { uploadLogo } from '../supabase.js';

// ── Template logo controls ────────────────────────────────

const IC = {
  top:    `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="1" width="12" height="2.5" rx="0.5"/><rect x="3" y="5" width="8" height="6.5" rx="0.5" opacity="0.45"/></svg>`,
  bottom: `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="3" y="2.5" width="8" height="6.5" rx="0.5" opacity="0.45"/><rect x="1" y="10.5" width="12" height="2.5" rx="0.5"/></svg>`,
  left:   `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="2" width="7.5" height="4" rx="0.5"/><rect x="1" y="8" width="5.5" height="4" rx="0.5"/></svg>`,
  center: `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2.5" y="4" width="4" height="6" rx="0.5"/><rect x="7.5" y="4" width="4" height="6" rx="0.5"/></svg>`,
  spread: `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="0.5" y="4" width="4" height="6" rx="0.5"/><rect x="9.5" y="4" width="4" height="6" rx="0.5"/></svg>`,
  right:  `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="5.5" y="2" width="7.5" height="4" rx="0.5"/><rect x="7.5" y="8" width="5.5" height="4" rx="0.5"/></svg>`,
};

function slotAssignRow(tl, i) {
  const slot = (tl.slots || [])[i];
  const src = slot?.logoSrcTight || slot?.logoSrc;
  return `
    <div class="tl-assign-row">
      <span class="tl-assign-label">Slot ${i + 1}</span>
      ${src
        ? `<img src="${escXml(src)}" class="tl-assign-thumb" alt="">`
        : `<span class="tl-assign-empty">–</span>`}
      <button class="btn sm tl-assign-btn" data-slot="${i}" onclick="openTlSlotPicker(${i})">${src ? 'Replace' : '+ Add logo'}</button>
      ${src ? `<button class="btn sm tl-assign-rm" onclick="removeTlSlot(${i})" title="Remove">✕</button>` : ''}
    </div>`;
}

export function renderTemplateLogoControls() {
  const tl = tlSource();
  const countBtns = [0,1,2,3].map(n => `<button class="hs-tog-btn${tl.count===n?' active':''}" onclick="setTplCount(${n})">${n||'Off'}</button>`).join('');
  if (!tl.count) {
    return `
      <div class="hs-section">
        <div class="hs-section-title">Template logos <span class="hs-optional">(optional)</span></div>
        <div class="hs-bg-toggle">${countBtns}</div>
      </div>`;
  }
  const sz = normalizeTplLogoSize(tl.size);
  const pct = Math.round((sz - HS_TPL_LOGO_MIN) / (HS_TPL_LOGO_MAX - HS_TPL_LOGO_MIN) * 100);
  const slotRows = Array.from({ length: tl.count }, (_, i) => slotAssignRow(tl, i)).join('');
  return `
    <div class="hs-section">
      <div class="hs-section-title">Template logos</div>
      <div class="tl-row"><div class="tl-row-label">Logos</div><div class="hs-bg-toggle">${countBtns}</div></div>
      <div class="tl-row">
        <div class="tl-row-label">Size</div>
        <div class="tl-size-slider">
          <input type="range" min="${HS_TPL_LOGO_MIN}" max="${HS_TPL_LOGO_MAX}" step="10" value="${sz}" oninput="setTplSize(this.value)">
          <span class="tl-size-value" id="tlSizeValue">${pct}%</span>
        </div>
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Position</div>
        <div class="hs-bg-toggle">
          <button class="hs-tog-btn hs-tog-icon${tl.vAlign !== 'bottom' ? ' active' : ''}" onclick="setTplVAlign('top')" title="Top">${IC.top}</button>
          <button class="hs-tog-btn hs-tog-icon${tl.vAlign === 'bottom' ? ' active' : ''}" onclick="setTplVAlign('bottom')" title="Bottom">${IC.bottom}</button>
        </div>
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Alignment</div>
        <div class="hs-bg-toggle">
          <button class="hs-tog-btn hs-tog-icon${tl.hAlign === 'left' && tl.stack !== 'horizontal' ? ' active' : ''}" onclick="setTplHAlign('left')" title="Left">${IC.left}</button>
          <button class="hs-tog-btn hs-tog-icon${tl.hAlign === 'center' && tl.stack === 'horizontal' ? ' active' : ''}" onclick="setTplHAlign('center')" title="Center">${IC.center}</button>
          <button class="hs-tog-btn hs-tog-icon${tl.hAlign === 'spread' ? ' active' : ''}" onclick="setTplHAlign('spread')" title="Spread">${IC.spread}</button>
          <button class="hs-tog-btn hs-tog-icon${tl.hAlign === 'right' && tl.stack !== 'horizontal' ? ' active' : ''}" onclick="setTplHAlign('right')" title="Right">${IC.right}</button>
        </div>
      </div>
      <div class="tl-assign-rows">${slotRows}</div>
      <div class="tl-hint">Drag slots in the preview to reposition and resize.</div>
      <button class="btn sm" style="margin-top:6px" onclick="resetTlFreePositions()">Reset to defaults</button>
    </div>`;
}

window.openTlSlotPicker = function (i) {
  const btn = document.querySelector(`.tl-assign-btn[data-slot="${i}"]`);
  openTlLibPicker(i, btn || document.body);
};

// The same template-logo controls power Step 1 (project default) and the
// per-variation editor (HS.editingDraft.templateLogos). `tlSource` returns the
// object that the active surface should mutate.
export function tlSource() {
  if (HS.editingVarId && HS.editingDraft) {
    HS.editingDraft.templateLogos = HS.editingDraft.templateLogos || emptyTemplateLogos();
    return HS.editingDraft.templateLogos;
  }
  HS.templateLogos = HS.templateLogos || emptyTemplateLogos();
  return HS.templateLogos;
}

// Applies computed default positions to all existing slots (used when vAlign/hAlign
// changes so the banner snap-drag and quick-add can reflow slot positions).
export function snapTlSlotsToDefaults(tl) {
  const defaults = getDefaultSlotRects(tl);
  (tl.slots || []).forEach((s, i) => {
    if (!s) return;
    const d = defaults[i];
    if (d) { s.freeX = d.x; s.freeY = d.y; s.freeW = d.w; s.freeH = d.h; }
  });
}

// Returns the computed default rect for each slot, ignoring any existing
// freeX/freeY. Used to pre-set positions when a logo is first assigned
// and to restore positions on "Reset to defaults".
function getDefaultSlotRects(tl) {
  const draft = HS.editingVarId && HS.editingDraft ? HS.editingDraft : null;
  const state = draft ? { ...HS, ...draft } : HS;
  const tid = (draft?.templateStyle) || HS.templateStyle || 'hole-sign-1';
  const tlCopy = { ...tl, slots: (tl.slots || []).map(() => null) };
  return getTemplateLogoSlots({ ...state, templateLogos: tlCopy }, tid);
}

// Structural redraw — count/align changes can show/hide rows or repaint
// thumbnails, so we re-render the whole controls panel in addition to the
// preview.
export function redrawTplStructural() {
  if (HS.editingVarId) {
    renderEditor();
    renderVariationPreview();
  } else {
    renderStep1();
  }
}

// Lightweight redraw for scale/color tweaks that only need the canvas refreshed.
export function redrawTplPreview() {
  if (HS.editingVarId) renderVariationPreview();
  else updateStep1Preview();
}

export function ensureTlSlots() {
  const tl = tlSource();
  if (tl.slots.length < tl.count) {
    const defaults = getDefaultSlotRects(tl);
    while (tl.slots.length < tl.count) {
      const i = tl.slots.length;
      const d = defaults[i];
      tl.slots.push(d ? { freeX: d.x, freeY: d.y, freeW: d.w, freeH: d.h } : {});
    }
  }
  if (tl.slots.length > tl.count) tl.slots.length = tl.count;
}

window.setTplCount = function (n) {
  const tl = tlSource();
  tl.count = n;
  ensureTlSlots();
  UI.tlSelectedIdx = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  redrawTplStructural();
};
window.setTplSize = function (k) {
  const tl = tlSource();
  const n = normalizeTplLogoSize(parseInt(k, 10));
  tl.size = n;
  // Reflow free-positioned slots so their stored freeW/freeH match the new size.
  snapTlSlotsToDefaults(tl);
  const lbl = document.getElementById('tlSizeValue');
  if (lbl) {
    const pct = Math.round((n - HS_TPL_LOGO_MIN) / (HS_TPL_LOGO_MAX - HS_TPL_LOGO_MIN) * 100);
    lbl.textContent = pct + '%';
  }
  redrawTplPreview();
};
window.setTplVAlign = function (k) {
  const tl = tlSource();
  tl.vAlign = k;
  delete tl.customPositions;
  const defaults = getDefaultSlotRects(tl);
  (tl.slots || []).forEach((s, i) => {
    if (!s) return;
    const d = defaults[i];
    if (d) { s.freeX = d.x; s.freeY = d.y; s.freeW = d.w; s.freeH = d.h; }
  });
  redrawTplStructural();
};
window.setTplHAlign = function (k) {
  const tl = tlSource();
  tl.hAlign = k;
  delete tl.customPositions;
  if (k === 'spread' || k === 'center') tl.stack = 'horizontal';
  else delete tl.stack;
  const defaults = getDefaultSlotRects(tl);
  (tl.slots || []).forEach((s, i) => {
    if (!s) return;
    const d = defaults[i];
    if (d) { s.freeX = d.x; s.freeY = d.y; s.freeW = d.w; s.freeH = d.h; }
  });
  redrawTplStructural();
};

window.resetTlFreePositions = function () {
  const tl = tlSource();
  delete tl.customPositions;
  const defaults = getDefaultSlotRects(tl);
  (tl.slots || []).forEach((s, i) => {
    if (!s) return;
    const d = defaults[i];
    if (d) { s.freeX = d.x; s.freeY = d.y; s.freeW = d.w; s.freeH = d.h; }
    else { delete s.freeX; delete s.freeY; delete s.freeW; delete s.freeH; }
  });
  redrawTplPreview();
};


export function applyTlSlotImgStyle(img, slot) {
  const fit = slot.fit || 'width';
  // In fit mode the slot is sized to the logo's aspect — no safe-area inset.
  const safeFrac = (slot.ratio === 'fit') ? 0 : HS_TPL_LOGO_SAFE_FRAC;
  const safe = 1 - 2 * safeFrac;
  const effScale = (slot.scale ?? 100) * safe;
  const tx = slot.tx ?? 50;
  const ty = slot.ty ?? 50;
  if (fit === 'height') {
    img.style.height = effScale + '%';
    img.style.width  = 'auto';
  } else {
    img.style.width  = effScale + '%';
    img.style.height = 'auto';
  }
  img.style.position = 'absolute';
  img.style.left = tx + '%';
  img.style.top  = ty + '%';
  img.style.transform = 'translate(-50%, -50%)';
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  img.style.pointerEvents = 'none';
}

export function wireTlSlotDragResize(overlay, img, handle, idx) {
  let mode = null, startX, startY, startTx, startTy, startScale;
  overlay.addEventListener('pointerdown', e => {
    if (e.target === handle) return;
    mode = 'move';
    overlay.setPointerCapture(e.pointerId);
    const slot = HS.templateLogos.slots[idx];
    startX = e.clientX; startY = e.clientY;
    startTx = slot.tx ?? 50; startTy = slot.ty ?? 50;
    e.preventDefault();
  });
  handle.addEventListener('pointerdown', e => {
    mode = 'resize';
    handle.setPointerCapture(e.pointerId);
    const slot = HS.templateLogos.slots[idx];
    startX = e.clientX; startY = e.clientY;
    startScale = slot.scale ?? 100;
    e.stopPropagation();
    e.preventDefault();
  });
  const SNAP_PCT = 4; // % within which to snap to center on each axis
  const onMove = e => {
    // hasPointerCapture guards against a dropped/lost pointerup leaving `mode`
    // stuck set — without it, a later hover-only pointermove would move/resize
    // the slot using the stale start point from the previous gesture.
    if (!mode) return;
    if (mode === 'move' && !overlay.hasPointerCapture(e.pointerId)) return;
    if (mode === 'resize' && !handle.hasPointerCapture(e.pointerId)) return;
    const slot = HS.templateLogos.slots[idx];
    const rect = overlay.getBoundingClientRect();
    if (mode === 'move') {
      const dx = (e.clientX - startX) / rect.width  * 100;
      const dy = (e.clientY - startY) / rect.height * 100;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) UI.tlJustDragged = true;
      let nx = startTx + dx;
      let ny = startTy + dy;
      const snapX = Math.abs(nx - 50) < SNAP_PCT;
      const snapY = Math.abs(ny - 50) < SNAP_PCT;
      if (snapX) nx = 50;
      if (snapY) ny = 50;
      overlay.classList.toggle('snap-x', snapX);
      overlay.classList.toggle('snap-y', snapY);
      slot.tx = nx;
      slot.ty = ny;
      applyTlSlotImgStyle(img, slot);
    } else if (mode === 'resize') {
      const dx = (e.clientX - startX) / rect.width * 100 * 2;
      if (Math.abs(dx) > 0.5) UI.tlJustDragged = true;
      slot.scale = Math.max(10, Math.min(400, startScale + dx));
      applyTlSlotImgStyle(img, slot);
    }
  };
  overlay.addEventListener('pointermove', onMove);
  handle.addEventListener('pointermove', onMove);
  const onUp = () => {
    mode = null;
    overlay.classList.remove('snap-x', 'snap-y');
    // Reset the drag-flag after the synthetic click would have fired.
    setTimeout(() => { UI.tlJustDragged = false; }, 0);
  };
  overlay.addEventListener('pointerup', onUp);
  handle.addEventListener('pointerup', onUp);
  overlay.addEventListener('pointercancel', onUp);
  handle.addEventListener('pointercancel', onUp);
}

// Drag and resize the slot box itself (sets per-slot freeX/freeY/freeW/freeH).
// Pointer on slot body → move; pointer on handle → resize.
// signRect is the slot's current position in sign coords at wire-time.
export function wireTlSlotFreeDrag(overlay, handle, idx, signRect, onTap) {
  let mode = null, startClientX, startClientY;
  let startSignX, startSignY, startSignW, startSignH;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';

  overlay.addEventListener('pointerdown', e => {
    if (e.target.closest('.tl-slot-handle,.tl-slot-actions')) return;
    if (e.button !== 0) return;
    mode = 'move';
    overlay.setPointerCapture(e.pointerId);
    startClientX = e.clientX; startClientY = e.clientY;
    const s = tlSource().slots[idx];
    startSignX = s?.freeX ?? signRect.x;
    startSignY = s?.freeY ?? signRect.y;
    e.preventDefault();
    e.stopPropagation();
  });

  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    mode = 'resize';
    handle.setPointerCapture(e.pointerId);
    startClientX = e.clientX; startClientY = e.clientY;
    const s = tlSource().slots[idx];
    startSignW = s?.freeW ?? signRect.w;
    startSignH = s?.freeH ?? signRect.h;
    e.stopPropagation();
    e.preventDefault();
  });

  const onMove = e => {
    // hasPointerCapture guards against a dropped/lost pointerup leaving `mode`
    // stuck set — without it, a later hover-only pointermove would move/resize
    // the slot using the stale start point from the previous gesture.
    if (!mode) return;
    if (mode === 'move' && !overlay.hasPointerCapture(e.pointerId)) return;
    if (mode === 'resize' && !handle.hasPointerCapture(e.pointerId)) return;
    const pr = overlay.parentElement?.getBoundingClientRect();
    const scaleX = pr ? pr.width / HS_W : 1;
    const scaleY = pr ? pr.height / HS_H : 1;
    const dxSign = (e.clientX - startClientX) / scaleX;
    const dySign = (e.clientY - startClientY) / scaleY;
    let s = tlSource().slots[idx];
    // Ensure we have a mutable object — empty slots are {} but could be null for
    // legacy data; create one in place so we can store the free position.
    if (s == null) { tlSource().slots[idx] = {}; s = tlSource().slots[idx]; }
    if (Math.hypot(dxSign, dySign) > 5) UI.tlJustDragged = true;
    if (mode === 'move') {
      s.freeX = startSignX + dxSign;
      s.freeY = startSignY + dySign;
      s.freeW = s.freeW ?? signRect.w;
      s.freeH = s.freeH ?? signRect.h;
      overlay.style.left = pct(s.freeX, HS_W);
      overlay.style.top  = pct(s.freeY, HS_H);
    } else {
      s.freeX = s.freeX ?? signRect.x;
      s.freeY = s.freeY ?? signRect.y;
      const ratio = startSignW / Math.max(1, startSignH);
      s.freeW = Math.max(300, startSignW + dxSign);
      s.freeH = s.freeW / ratio;
      overlay.style.width  = pct(s.freeW, HS_W);
      overlay.style.height = pct(s.freeH, HS_H);
    }
  };

  overlay.addEventListener('pointermove', onMove);
  handle.addEventListener('pointermove', onMove);

  const onUp = () => {
    if (!mode) return;
    const wasDrag = UI.tlJustDragged;
    if (wasDrag) tlSource().customPositions = true;
    mode = null;
    setTimeout(() => { UI.tlJustDragged = false; }, 0);
    // Fire onTap before redrawTplPreview so the overlay is still in the DOM
    // when the picker reads getBoundingClientRect() for positioning.
    if (!wasDrag && onTap) onTap();
    redrawTplPreview();
  };
  overlay.addEventListener('pointerup', onUp);
  handle.addEventListener('pointerup', onUp);
  overlay.addEventListener('pointercancel', onUp);
  handle.addEventListener('pointercancel', onUp);
}

export function openTlLibPicker(idx, anchorEl) {
  closeTlLibPicker();
  const picker = document.createElement('div');
  picker.className = 'tl-lib-picker';
  const libHtml = HS.library.length
    ? HS.library.map(l => `<div class="tl-lp-item" data-lid="${l.id}" title="${escXml(l.name)}"><img src="${l.src}" alt=""></div>`).join('')
    : '<div class="tl-lp-empty">No logos uploaded yet</div>';
  picker.innerHTML = `${libHtml}<div class="tl-lp-upload" id="tlLpUpload">+ Upload image</div><input type="file" id="tlLpFile" accept="image/*,.pdf,.ai,.eps" style="display:none">`;
  document.body.appendChild(picker);
  UI.tlPickerEl = picker;

  const r = anchorEl.getBoundingClientRect();
  const ph = picker.offsetHeight;
  const pw = picker.offsetWidth;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const gap = 6;
  const spaceBelow = vh - r.bottom;
  const placeAbove = spaceBelow < ph + gap && r.top > ph + gap;
  const top = placeAbove ? (r.top + window.scrollY - ph - gap) : (r.bottom + window.scrollY + gap);
  const left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + vw - pw - 8));
  picker.style.left = left + 'px';
  picker.style.top  = top + 'px';

  picker.querySelectorAll('.tl-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      const logo = HS.library.find(l => l.id === el.dataset.lid);
      if (logo) assignTlSlot(idx, logo);
      closeTlLibPicker();
    });
  });
  const fileInput = picker.querySelector('#tlLpFile');
  picker.querySelector('#tlLpUpload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const logo = await uploadLogo(HS.projectId, file);
      HS.library.push(logo);
      assignTlSlot(idx, logo);
    } catch (err) { console.error('Upload failed', err); }
    closeTlLibPicker();
  });

  setTimeout(() => {
    const close = ev => {
      if (!ev.target.closest('.tl-lib-picker')) {
        closeTlLibPicker();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

export function closeTlLibPicker() {
  if (UI.tlPickerEl) { UI.tlPickerEl.remove(); UI.tlPickerEl = null; }
}

export function openTlSlotToolbar(idx, anchorEl) {
  closeTlSlotToolbar();
  const tb = document.createElement('div');
  tb.id = 'tlSlotToolbar';
  tb.className = 'tl-slot-toolbar';
  tb.innerHTML = `
    <button class="tl-tb-btn" data-act="replace">Replace</button>
    <button class="tl-tb-btn" data-act="finetune">Fine-tune</button>
    <button class="tl-tb-btn danger" data-act="remove">Remove</button>`;
  document.body.appendChild(tb);

  tb.addEventListener('click', e => {
    const act = e.target.dataset?.act;
    if (!act) return;
    closeTlSlotToolbar();
    const liveAnchor = document.querySelector(`.tl-slot[data-idx="${idx}"]`) || anchorEl;
    if (act === 'replace')   openTlLibPicker(idx, liveAnchor);
    if (act === 'finetune')  openTlSidePanel(idx);
    if (act === 'remove')    removeTlSlot(idx);
  });

  const r = anchorEl.getBoundingClientRect();
  // Default above; flip below if there's not enough headroom.
  const th = tb.offsetHeight;
  const tw = tb.offsetWidth;
  const placeAbove = r.top > th + 12;
  const top  = placeAbove ? (r.top + window.scrollY - th - 6) : (r.bottom + window.scrollY + 6);
  const left = Math.max(8, Math.min(window.scrollX + window.innerWidth - tw - 8,
    r.left + window.scrollX + r.width / 2 - tw / 2));
  tb.style.top  = top + 'px';
  tb.style.left = left + 'px';

  setTimeout(() => {
    const close = ev => {
      if (!ev.target.closest('#tlSlotToolbar') && !ev.target.closest('.tl-slot') && !ev.target.closest('.tl-lib-picker') && !ev.target.closest('#tlSidePanel')) {
        closeTlSlotToolbar();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

export function closeTlSlotToolbar() {
  const tb = document.getElementById('tlSlotToolbar');
  if (tb) tb.remove();
}

export function assignTlSlot(idx, logo) {
  ensureTlSlots();
  const tl = tlSource();
  const existing = tl.slots[idx];
  // Prefer the slot's existing position (user may have pre-placed the empty slot)
  // otherwise fall back to the computed default.
  let freePos = {};
  if (existing?.freeX != null) {
    freePos = { freeX: existing.freeX, freeY: existing.freeY, freeW: existing.freeW, freeH: existing.freeH };
  } else {
    const dr = getDefaultSlotRects(tl)[idx];
    if (dr) freePos = { freeX: dr.x, freeY: dr.y, freeW: dr.w, freeH: dr.h };
  }
  const slot = {
    logoId: logo.id,
    logoSrc: logo.src,
    fit: 'width',
    tx: 50, ty: 50, scale: 100,
    border: { color: '#D1D5DB' },
    ...freePos,
  };
  tl.slots[idx] = slot;
  UI.tlSelectedIdx = idx;
  prepareLogo(slot, logo.src).then(() => redrawTplPreview()).catch(() => {});
  redrawTplPreview();
}

// Renders the slot visual-options body as an HTML string for use in the
// sidebar menu. Also used by openTlSidePanel for the floating panel variant.
export function renderTplSlotBody(idx) {
  const slot = tlSource().slots[idx];
  if (!slot?.logoSrc) return '<div class="hs-section" style="font-size:13px;color:var(--gray-400)">No logo assigned to this slot.</div>';
  const hasBg = !!(slot.bg && slot.bg !== 'transparent');
  const bgColor = hasBg ? slot.bg : '#FFFFFF';
  const hasBorder = !!(slot.border && slot.border.color);
  const borderColor = hasBorder ? slot.border.color : '#000000';
  const ratio = slot.ratio || '2:1';
  const ratioOpt = (val, label) => `<option value="${val}"${ratio === val ? ' selected' : ''}>${label}</option>`;
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">Ratio</div>
      <select class="tl-select" onchange="setTlSlotRatio(${idx}, this.value)">
        ${ratioOpt('fit','Fit logo')}${ratioOpt('1:1','1:1')}${ratioOpt('2:1','2:1')}${ratioOpt('3:1','3:1')}${ratioOpt('4:1','4:1')}
      </select>
    </div>
    <div class="hs-editor-section">
      <div class="hs-editor-label">Fit</div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${(slot.fit||'width')==='width'?' active':''}" onclick="setTlSlotFit(${idx},'width')">Width</button>
        <button class="hs-tog-btn${slot.fit==='height'?' active':''}" onclick="setTlSlotFit(${idx},'height')">Height</button>
      </div>
    </div>
    <div class="hs-editor-section">
      <div class="hs-editor-label">Scale</div>
      <input type="range" id="tlSpScale" min="10" max="400" value="${slot.scale ?? 100}"
        oninput="setTlSlotScale(${idx}, this.value); document.getElementById('tlSpScaleLabel').textContent=this.value+'%'">
      <div style="display:flex;justify-content:space-between">
        <span style="font-size:11px;color:var(--gray-400)">10%</span>
        <span id="tlSpScaleLabel" style="font-size:11px;color:var(--gray-600)">${slot.scale ?? 100}%</span>
        <span style="font-size:11px;color:var(--gray-400)">400%</span>
      </div>
    </div>
    <div class="hs-editor-section">
      <div class="tl-toggle-row">
        <div class="hs-editor-label" style="margin:0">Background</div>
        <label class="tl-switch">
          <input type="checkbox"${hasBg?' checked':''} onchange="setTlSlotBgMode(${idx}, this.checked?'color':'transparent')">
          <span class="tl-switch-slider"></span>
        </label>
      </div>
      ${hasBg ? `
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="tlSpBgSwatch" value="${bgColor}"
          oninput="setTlSlotBgColor(${idx}, this.value)">
        <input type="text" class="hexin" id="tlSpBgHex" style="flex:1" maxlength="7" value="${bgColor}"
          oninput="setTlSlotBgHex(${idx}, this.value)">
        ${eyedropperBtn('tlSpBgSwatch')}
      </div>` : ''}
    </div>
    ${ratio === 'fit' ? '' : `
    <div class="hs-editor-section">
      <div class="tl-toggle-row">
        <div class="hs-editor-label" style="margin:0">Border</div>
        <label class="tl-switch">
          <input type="checkbox"${hasBorder?' checked':''} onchange="setTlSlotBorderMode(${idx}, this.checked?'on':'off')">
          <span class="tl-switch-slider"></span>
        </label>
      </div>
      ${hasBorder ? `
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="tlSpBorderSwatch" value="${borderColor}"
          oninput="setTlSlotBorderColor(${idx}, this.value)">
        <input type="text" class="hexin" id="tlSpBorderHex" style="flex:1" maxlength="7" value="${borderColor}"
          oninput="setTlSlotBorderHex(${idx}, this.value)">
        ${eyedropperBtn('tlSpBorderSwatch')}
      </div>` : ''}
    </div>`}
    <div class="hs-editor-section">
      <button class="btn sm" onclick="resetTlSlot(${idx})">Reset position</button>
      <button class="btn sm" style="color:#dc2626;border-color:#fecaca;margin-top:4px" onclick="removeTlSlot(${idx})">Remove logo</button>
    </div>`;
}

export function openTlSidePanel(idx) {
  // If the slot-options level is already open in the sidebar menu, refresh in-place
  // rather than opening a competing floating panel.
  if (!HS.editingVarId && UI.hsMenu === 'tplSlot') {
    UI.hsMenuSlotIdx = idx;
    window._refreshDesignTplSlot?.();
    return;
  }
  if (HS.editingVarId && UI.hsVarMenu === 'tplSlot') {
    UI.hsVarMenuSlotIdx = idx;
    window._refreshVarTplSlot?.();
    return;
  }
  // Floating panel fallback (used when accessed from canvas hover-Edit button
  // before navigating to the tplSlot menu level).
  closeTlSidePanel();
  const slot = tlSource().slots[idx];
  if (!slot) return;
  const panel = document.createElement('div');
  panel.id = 'tlSidePanel';
  panel.className = 'tl-side-panel';
  panel.innerHTML = `
    <div class="tl-sp-header">
      <div class="tl-sp-title">Slot ${idx + 1}</div>
      <button class="tl-sp-close" onclick="closeTlSidePanel()">✕</button>
    </div>
    <div class="tl-sp-body">${renderTplSlotBody(idx)}</div>`;
  document.body.appendChild(panel);
}

window.closeTlSidePanel = function () {
  const p = document.getElementById('tlSidePanel');
  if (p) p.remove();
};

export function activeSlot(idx) { return tlSource().slots[idx]; }

window.setTlSlotFit = function (idx, fit) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.fit = fit;
  slot.scale = 100;
  slot.tx = 50; slot.ty = 50;
  redrawTplPreview();
  openTlSidePanel(idx);
};
window.setTlSlotScale = function (idx, val) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.scale = parseInt(val, 10) || 100;
  redrawTplPreview();
};
window.resetTlSlot = function (idx) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.tx = 50; slot.ty = 50; slot.scale = 100;
  redrawTplPreview();
  openTlSidePanel(idx);
};
window.removeTlSlot = function (idx) {
  const s = tlSource().slots[idx];
  // Keep the slot's position so the empty placeholder stays in place.
  tlSource().slots[idx] = s?.freeX != null
    ? { freeX: s.freeX, freeY: s.freeY, freeW: s.freeW, freeH: s.freeH }
    : {};
  UI.tlSelectedIdx = null;
  closeTlSidePanel();
  redrawTplPreview();
};
window.setTlSlotBgMode = function (idx, mode) {
  const slot = activeSlot(idx); if (!slot) return;
  if (mode === 'transparent') {
    if (slot.bg && slot.bg !== 'transparent') slot.bgLast = slot.bg;
    slot.bg = null;
  } else {
    slot.bg = slot.bgLast || slot.bg || '#FFFFFF';
  }
  openTlSidePanel(idx);
  redrawTplPreview();
};
window.setTlSlotBgColor = function (idx, color) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.bg = color;
  const hex = document.getElementById('tlSpBgHex');
  if (hex) hex.value = color;
  redrawTplPreview();
};
window.setTlSlotBgHex = function (idx, val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
  const slot = activeSlot(idx); if (!slot) return;
  slot.bg = c;
  const swatch = document.getElementById('tlSpBgSwatch');
  if (swatch) swatch.value = c;
  redrawTplPreview();
};
window.setTlSlotRatio = function (idx, val) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.ratio = val;
  // Update slot width to match the new ratio, keeping the current height.
  if (slot.freeH != null) slot.freeW = Math.round(slotWidthForRatio(slot, slot.freeH));
  redrawTplPreview();
  // Re-open the panel to show/hide the border section (hidden when ratio='fit').
  openTlSidePanel(idx);
};
window.setTlSlotBorderMode = function (idx, mode) {
  const slot = activeSlot(idx); if (!slot) return;
  if (mode === 'off') {
    if (slot.border) slot.borderLast = slot.border;
    slot.border = null;
  } else {
    slot.border = slot.borderLast || slot.border || { color: '#000000' };
  }
  openTlSidePanel(idx);
  redrawTplPreview();
};
window.setTlSlotBorderColor = function (idx, color) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.border = { ...(slot.border || {}), color };
  const hex = document.getElementById('tlSpBorderHex');
  if (hex) hex.value = color;
  redrawTplPreview();
};
window.setTlSlotBorderHex = function (idx, val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
  const slot = activeSlot(idx); if (!slot) return;
  slot.border = { ...(slot.border || {}), color: c };
  const swatch = document.getElementById('tlSpBorderSwatch');
  if (swatch) swatch.value = c;
  redrawTplPreview();
};
