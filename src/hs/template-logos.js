import { HS, UI, eyedropperBtn } from './state.js';
import { renderStep1, updateStep1Preview } from './design.js';
import { renderEditor } from './var-editor.js';
import { renderVariationPreview } from './var-canvas.js';
import { prepareLogo } from './logo-utils.js';
import { HS_H, HS_TPL_LOGO_DEFAULT, HS_TPL_LOGO_MAX, HS_TPL_LOGO_MIN, HS_W, emptyTemplateLogos, normalizeTplLogoSize } from '../hole-sign-data.js';
import { HS_TPL_LOGO_SAFE_FRAC, escXml, getTemplateLogoSlots, slotWidthForRatio } from '../hole-sign-render.js';
import { uploadLogo } from '../supabase.js';
import { logoThumbHtml } from '../media-utils.js';

// Delete/Backspace removes every selected image entirely, unless the user is
// typing in a text field or editing a text layer (own keydown handling).
// Highest index first — removeTlSlot() splices the slot out, which shifts
// every later index down by one, so removing low-to-high would delete the
// wrong slots for a multi-selection.
document.addEventListener('keydown', e => {
  if (!UI.tlSelectedIdxs.size) return;
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (document.activeElement?.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  [...UI.tlSelectedIdxs].sort((a, b) => b - a).forEach(idx => window.removeTlSlot(idx));
});

// ── Template logo controls ────────────────────────────────

const IC = {
  top:    `<i class="fa-solid fa-arrow-up"></i>`,
  bottom: `<i class="fa-solid fa-arrow-down"></i>`,
  left:   `<i class="fa-solid fa-arrow-left"></i>`,
  center: `<i class="fa-solid fa-compress"></i>`,
  spread: `<i class="fa-solid fa-arrows-left-right"></i>`,
  right:  `<i class="fa-solid fa-arrow-right"></i>`,
};

function slotAssignRow(tl, i) {
  const slot = (tl.slots || [])[i];
  const src = slot?.logoSrcTight || slot?.logoSrc;
  return `
    <div class="tl-assign-row">
      <span class="tl-assign-label">Slot ${i + 1}</span>
      ${src
        ? logoThumbHtml(src, '', 'tl-assign-thumb')
        : `<span class="tl-assign-empty">–</span>`}
      <button class="btn sm tl-assign-btn" data-slot="${i}" onclick="openTlSlotPicker(${i})">${src ? 'Replace' : '+ Add logo'}</button>
      ${src ? `<button class="btn sm tl-assign-rm" onclick="removeTlSlot(${i})" title="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>` : ''}
    </div>`;
}

export function renderTemplateLogoControls() {
  const tl = tlSource();
  // Count is no longer set via a manual toggle — it grows one at a time via
  // "+ Images" (Step-1 sidebar) and shrinks via per-image remove/Delete, so
  // an empty state here is just informational, not an "enable" control.
  if (!tl.count) {
    return `
      <div class="hs-section">
        <div class="hs-section-title">Template logos</div>
        <div style="font-size:12px;color:var(--gray-400)">No images added to the template yet.</div>
      </div>`;
  }
  const sz = normalizeTplLogoSize(tl.size);
  const pct = Math.round((sz - HS_TPL_LOGO_MIN) / (HS_TPL_LOGO_MAX - HS_TPL_LOGO_MIN) * 100);
  const slotRows = Array.from({ length: tl.count }, (_, i) => slotAssignRow(tl, i)).join('');
  return `
    <div class="hs-section">
      <div class="hs-section-title">Template logos</div>
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
          <button class="hs-tog-btn hs-tog-icon${tl.hAlign === 'left' ? ' active' : ''}" onclick="setTplHAlign('left')" title="Left">${IC.left}</button>
          <button class="hs-tog-btn hs-tog-icon${tl.hAlign === 'center' ? ' active' : ''}" onclick="setTplHAlign('center')" title="Center">${IC.center}</button>
          <button class="hs-tog-btn hs-tog-icon${tl.hAlign === 'spread' ? ' active' : ''}" onclick="setTplHAlign('spread')" title="Spread">${IC.spread}</button>
          <button class="hs-tog-btn hs-tog-icon${tl.hAlign === 'right' ? ' active' : ''}" onclick="setTplHAlign('right')" title="Right">${IC.right}</button>
        </div>
      </div>
      <div class="tl-assign-rows">${slotRows}</div>
      <div class="tl-hint">Drag slots in the preview to reposition and resize.</div>
      <button class="btn sm" style="margin-top:6px" onclick="resetTlFreePositions()">Reset to defaults</button>
    </div>`;
}

window.openTlSlotPicker = function (i) {
  openTlLibPicker(i);
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

// Appends one more image, uncapped — mirrors addTextLayer()'s pattern for
// free text layers. Given a centered default free position/size (rather than
// running the count-based auto-layout math, which isn't built to gracefully
// re-flow an unbounded, incrementally-grown list) since free positioning is
// already fully supported per-slot regardless of how it was created.
window.addTplImage = function () {
  const tl = tlSource();
  const idx = tl.count;
  tl.count += 1;
  const w = HS_TPL_LOGO_DEFAULT * 2, h = HS_TPL_LOGO_DEFAULT;
  tl.slots[idx] = { freeX: HS_W / 2 - w / 2, freeY: HS_H / 2 - h / 2, freeW: w, freeH: h };
  tl.customPositions = true;
  UI.tlSelectedIdxs = new Set([idx]);
  redrawTplStructural();
  if (HS.editingVarId) {
    UI.hsVarMenuSlotIdx = idx;
    window.openHsVarMenu?.('tplSlot');
  } else {
    UI.hsMenuSlotIdx = idx;
    window.openHsMenu?.('tplSlot');
  }
  openTlLibPicker(idx);
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

// Canvas-level alignment guide lines, shared across every slot's drag (not
// owned by any one slot) — created lazily on the canvas container and reused
// across drags; a fresh render clears the whole container anyway.
function ensureAlignGuides(container) {
  let v = container.querySelector(':scope > .tl-align-guide-v');
  let h = container.querySelector(':scope > .tl-align-guide-h');
  if (!v) { v = document.createElement('div'); v.className = 'tl-align-guide-v'; container.appendChild(v); }
  if (!h) { h = document.createElement('div'); h.className = 'tl-align-guide-h'; container.appendChild(h); }
  return { v, h };
}

// Finds the first candidate whose value is within `tol` of the box's left
// edge, center, or right edge (same shape used for both axes) and returns
// the candidate's coordinate plus the box's new position that aligns exactly
// to it. Returns null if nothing is within tolerance.
function findAxisSnap(candidates, pos, size, tol) {
  for (const cand of candidates) {
    if (Math.abs(pos - cand) < tol)                return { value: cand, newPos: cand };
    if (Math.abs(pos + size / 2 - cand) < tol)      return { value: cand, newPos: cand - size / 2 };
    if (Math.abs(pos + size - cand) < tol)          return { value: cand, newPos: cand - size };
  }
  return null;
}

// Drag and resize the slot box itself (sets per-slot freeX/freeY/freeW/freeH).
// Pointer on slot body → move (the whole current multi-selection moves
// together if this slot is part of one); pointer on a corner handle →
// resize this slot only, anchored at the opposite corner (matching the
// text-layer resize feel — grabbing any corner grows the box away from it
// rather than always from top-left).
// `handles` is { tl, tr, bl, br } — `allRects` is every slot's current rect
// in sign coords at wire-time (used both as this slot's own starting rect,
// allRects[idx], and as alignment targets for the OTHER slots during move).
// onTap(shiftKey) fires on a no-drag pointerup.
export function wireTlSlotFreeDrag(overlay, handles, idx, allRects, onTap) {
  const signRect = allRects[idx] || { x: 0, y: 0, w: 0, h: 0 };
  let mode = null, activeCorner = null, startClientX, startClientY;
  let startSignX, startSignY, startSignW, startSignH;
  let groupIndices = [idx], groupStarts = {};
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  const handleList = Object.values(handles).filter(Boolean);

  overlay.addEventListener('pointerdown', e => {
    if (e.target.closest('.tl-slot-handle,.tl-slot-hover-actions')) return;
    if (e.button !== 0) return;
    mode = 'move';
    overlay.setPointerCapture(e.pointerId);
    startClientX = e.clientX; startClientY = e.clientY;
    // Dragging a slot that's part of the current multi-selection moves the
    // whole selection together; otherwise it's just this one slot.
    groupIndices = (UI.tlSelectedIdxs.has(idx) && UI.tlSelectedIdxs.size > 1) ? [...UI.tlSelectedIdxs] : [idx];
    groupStarts = {};
    groupIndices.forEach(gIdx => {
      const gs = tlSource().slots[gIdx];
      const gRect = allRects[gIdx] || { x: 0, y: 0, w: 0, h: 0 };
      groupStarts[gIdx] = { x: gs?.freeX ?? gRect.x, y: gs?.freeY ?? gRect.y };
    });
    startSignX = groupStarts[idx].x;
    startSignY = groupStarts[idx].y;
    e.preventDefault();
    e.stopPropagation();
  });

  Object.entries(handles).forEach(([corner, handle]) => {
    if (!handle) return;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      mode = 'resize';
      activeCorner = corner;
      handle.setPointerCapture(e.pointerId);
      startClientX = e.clientX; startClientY = e.clientY;
      const s = tlSource().slots[idx];
      startSignX = s?.freeX ?? signRect.x;
      startSignY = s?.freeY ?? signRect.y;
      startSignW = s?.freeW ?? signRect.w;
      startSignH = s?.freeH ?? signRect.h;
      e.stopPropagation();
      e.preventDefault();
    });
  });

  const activeHandle = () => (activeCorner ? handles[activeCorner] : null);

  const onMove = e => {
    // hasPointerCapture guards against a dropped/lost pointerup leaving `mode`
    // stuck set — without it, a later hover-only pointermove would move/resize
    // the slot using the stale start point from the previous gesture.
    if (!mode) return;
    if (mode === 'move' && !overlay.hasPointerCapture(e.pointerId)) return;
    if (mode === 'resize' && !activeHandle()?.hasPointerCapture(e.pointerId)) return;
    const container = overlay.parentElement;
    const pr = container?.getBoundingClientRect();
    const scaleX = pr ? pr.width / HS_W : 1;
    const scaleY = pr ? pr.height / HS_H : 1;
    const dxSign = (e.clientX - startClientX) / scaleX;
    const dySign = (e.clientY - startClientY) / scaleY;
    if (Math.hypot(dxSign, dySign) > 5) UI.tlJustDragged = true;

    if (mode === 'move') {
      // Move every slot in the group by the same raw delta first.
      groupIndices.forEach(gIdx => {
        let gs = tlSource().slots[gIdx];
        if (gs == null) { tlSource().slots[gIdx] = {}; gs = tlSource().slots[gIdx]; }
        const gRect = allRects[gIdx] || signRect;
        gs.freeW = gs.freeW ?? gRect.w;
        gs.freeH = gs.freeH ?? gRect.h;
        gs.freeX = groupStarts[gIdx].x + dxSign;
        gs.freeY = groupStarts[gIdx].y + dySign;
      });

      // Alignment snap — based on the primary dragged slot only, against the
      // sign's own center plus every OTHER (non-group) slot's edges/center,
      // so the whole group rides along with whatever correction it finds.
      const s = tlSource().slots[idx];
      const others = allRects.filter((_, j) => !groupIndices.includes(j));
      const candX = [HS_W / 2, ...others.flatMap(r => [r.x, r.x + r.w / 2, r.x + r.w])];
      const candY = [HS_H / 2, ...others.flatMap(r => [r.y, r.y + r.h / 2, r.y + r.h])];
      const tolX = 5 / scaleX, tolY = 5 / scaleY;
      const snapX = findAxisSnap(candX, s.freeX, s.freeW, tolX);
      const snapY = findAxisSnap(candY, s.freeY, s.freeH, tolY);
      const dSnapX = snapX ? snapX.newPos - s.freeX : 0;
      const dSnapY = snapY ? snapY.newPos - s.freeY : 0;
      if (dSnapX || dSnapY) {
        groupIndices.forEach(gIdx => {
          const gs = tlSource().slots[gIdx];
          gs.freeX += dSnapX;
          gs.freeY += dSnapY;
        });
      }

      // Reposition every group member's overlay (siblings looked up by index
      // since this function only holds a direct reference to its own).
      groupIndices.forEach(gIdx => {
        const gs = tlSource().slots[gIdx];
        const gOverlay = gIdx === idx ? overlay : container?.querySelector(`.tl-slot[data-idx="${gIdx}"]`);
        if (gOverlay) {
          gOverlay.style.left = pct(gs.freeX, HS_W);
          gOverlay.style.top  = pct(gs.freeY, HS_H);
        }
      });

      if (container) {
        const { v, h } = ensureAlignGuides(container);
        v.style.left = pct(snapX ? snapX.value : 0, HS_W);
        v.classList.toggle('show', !!snapX);
        h.style.top = pct(snapY ? snapY.value : 0, HS_H);
        h.classList.toggle('show', !!snapY);
      }
    } else {
      let s = tlSource().slots[idx];
      if (s == null) { tlSource().slots[idx] = {}; s = tlSource().slots[idx]; }
      const isLeft = activeCorner === 'tl' || activeCorner === 'bl';
      const isTop  = activeCorner === 'tl' || activeCorner === 'tr';
      const dxEff = isLeft ? -dxSign : dxSign;
      const ratio = startSignW / Math.max(1, startSignH);
      const newW = Math.max(300, startSignW + dxEff);
      const newH = newW / ratio;
      const anchorRight  = startSignX + startSignW;
      const anchorBottom = startSignY + startSignH;
      s.freeW = newW;
      s.freeH = newH;
      s.freeX = isLeft ? anchorRight  - newW : startSignX;
      s.freeY = isTop  ? anchorBottom - newH : startSignY;
      overlay.style.left   = pct(s.freeX, HS_W);
      overlay.style.top    = pct(s.freeY, HS_H);
      overlay.style.width  = pct(s.freeW, HS_W);
      overlay.style.height = pct(s.freeH, HS_H);
    }
  };

  overlay.addEventListener('pointermove', onMove);
  handleList.forEach(h => h.addEventListener('pointermove', onMove));

  const onUp = e => {
    if (!mode) return;
    const wasDrag = UI.tlJustDragged;
    if (wasDrag) tlSource().customPositions = true;
    mode = null;
    activeCorner = null;
    setTimeout(() => { UI.tlJustDragged = false; }, 0);
    overlay.parentElement?.querySelector(':scope > .tl-align-guide-v')?.classList.remove('show');
    overlay.parentElement?.querySelector(':scope > .tl-align-guide-h')?.classList.remove('show');
    // Fire onTap before redrawTplPreview so the overlay is still in the DOM
    // when the picker reads getBoundingClientRect() for positioning.
    if (!wasDrag && onTap) onTap(e.shiftKey);
    redrawTplPreview();
  };
  overlay.addEventListener('pointerup', onUp);
  handleList.forEach(h => h.addEventListener('pointerup', onUp));
  overlay.addEventListener('pointercancel', onUp);
  handleList.forEach(h => h.addEventListener('pointercancel', onUp));
}

// Centered modal (not anchored to whatever was clicked) so it reads as a
// deliberate "pick a logo" step — used both right after adding a new image
// and when tapping an empty slot placeholder.
export function openTlLibPicker(idx) {
  closeTlLibPicker();
  const backdrop = document.createElement('div');
  backdrop.className = 'tl-lib-modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'tl-lib-modal';
  const libHtml = HS.library.length
    ? HS.library.map(l => `<div class="tl-lp-item" data-lid="${l.id}" title="${escXml(l.name)}">${logoThumbHtml(l.src)}</div>`).join('')
    : '<div class="tl-lp-empty">No logos uploaded yet</div>';
  modal.innerHTML = `
    <div class="tl-lib-modal-title">Choose a logo</div>
    <div class="tl-lib-grid">${libHtml}</div>
    <div class="tl-lp-upload" id="tlLpUpload">+ Upload image</div>
    <input type="file" id="tlLpFile" accept="image/*,.pdf,.ai,.eps" style="display:none">`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  UI.tlPickerEl = backdrop;

  modal.querySelectorAll('.tl-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      const logo = HS.library.find(l => l.id === el.dataset.lid);
      if (logo) assignTlSlot(idx, logo);
      closeTlLibPicker();
    });
  });
  const fileInput = modal.querySelector('#tlLpFile');
  modal.querySelector('#tlLpUpload').addEventListener('click', () => fileInput.click());
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

  // Click on the backdrop itself (not the modal or its contents) closes it.
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) closeTlLibPicker();
  });
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
    if (act === 'replace')   openTlLibPicker(idx);
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
      if (!ev.target.closest('#tlSlotToolbar') && !ev.target.closest('.tl-slot') && !ev.target.closest('.tl-lib-modal-backdrop') && !ev.target.closest('#tlSidePanel')) {
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
  UI.tlSelectedIdxs = new Set([idx]);
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
      <button class="tl-sp-close" onclick="closeTlSidePanel()" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
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
// Removes the whole image component — not just its logo — since each image
// is now its own individually-added item (see addTplImage()), not a fixed
// slot that should stick around empty. Splicing shifts every later index
// down by one, so selection and any open per-slot panel are re-indexed too.
window.removeTlSlot = function (idx) {
  const tl = tlSource();
  tl.slots.splice(idx, 1);
  tl.count = Math.max(0, tl.count - 1);

  const reindexed = new Set();
  UI.tlSelectedIdxs.forEach(i => {
    if (i === idx) return;
    reindexed.add(i > idx ? i - 1 : i);
  });
  UI.tlSelectedIdxs = reindexed;

  // If the removed slot was the one open in the per-slot panel, fall back to
  // the group panel instead of showing stale/wrong slot content; otherwise
  // shift the shown index down to match the splice.
  const shiftIdx = cur => (cur == null ? cur : cur === idx ? null : cur > idx ? cur - 1 : cur);
  if (HS.editingVarId) {
    UI.hsVarMenuSlotIdx = shiftIdx(UI.hsVarMenuSlotIdx);
    if (UI.hsVarMenu === 'tplSlot' && UI.hsVarMenuSlotIdx == null) UI.hsVarMenu = 'logos';
  } else {
    UI.hsMenuSlotIdx = shiftIdx(UI.hsMenuSlotIdx);
    if (UI.hsMenu === 'tplSlot' && UI.hsMenuSlotIdx == null) UI.hsMenu = 'logos';
  }

  closeTlSidePanel();
  closeTlSlotToolbar();
  redrawTplStructural();
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
