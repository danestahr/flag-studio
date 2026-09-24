import { HS, UI, eyedropperBtn, HS_FRAME_LAYER_ORDER, getVariationLayer, setVariationLayer } from './state.js';
import { renderStep1, updateStep1Preview } from './design.js';
import { renderEditor } from './var-editor.js';
import { renderVariationPreview } from './var-canvas.js';
import { prepareLogo, removeBgFromLogo } from './logo-utils.js';
import { HS_H, HS_TPL_LOGO_DEFAULT, HS_TPL_LOGO_MAX, HS_TPL_LOGO_MIN, HS_W, emptyTemplateLogos, normalizeTplLogoSize } from '../hole-sign-data.js';
import { HS_TPL_LOGO_SAFE_FRAC, escXml, getTemplateLogoSlots, slotWidthForRatio } from '../hole-sign-render.js';
import { uploadLogo } from '../supabase.js';
import { logoThumbHtml } from '../media-utils.js';
import { positionFloatingToolbar } from '../dom-utils.js';

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

// Arrow keys nudge every selected template-logo slot by 1 real screen px
// (10px with Option/Alt held) — goes through image-box.js's own wrap._nudge,
// re-queried fresh by index same as the Delete handler above (a re-render can
// replace the element, so nothing here can hold onto a stale reference).
document.addEventListener('keydown', e => {
  if (!UI.tlSelectedIdxs.size) return;
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const d = arrows[e.key];
  if (!d) return;
  if (document.activeElement?.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  const step = e.altKey ? 10 : 1;
  const dx = d[0] * step, dy = d[1] * step;
  UI.tlSelectedIdxs.forEach(idx => {
    document.querySelector(`.dz-logo-wrap[data-tl-idx="${idx}"]`)?._nudge?.(dx, dy);
  });
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
      <div class="tl-hint">Drag slots in the preview to reposition and resize. Assign logos to slots below.</div>
      <button class="btn sm" style="margin-top:6px" onclick="resetTlFreePositions()">Reset to defaults</button>
    </div>`;
}

// Persistent grid tile for the sidebar (#sidebarLogosTile) — the per-slot
// assignment list used to live only inside the "Template logos" drill-down
// section above (reached by clicking a slot on canvas). Reuses the same
// openTlSlotPicker/removeTlSlot entry points, just as square tiles matching
// the Variations step's sponsor-logo tile instead of labeled rows.
// Always leads with a dashed "add" tile that goes straight to the OS file
// picker (uploadNewTplLogo — a brand-new slot, not an assignment onto an
// existing one) so there's always a way to add a logo straight from the
// tile, the same as the Variations tile's upload button, instead of only
// via the "+ Images" row in the main menu list. An unassigned slot (e.g.
// left behind by cancelling addTplImage's own library-choice modal
// elsewhere) is skipped rather than rendered as a second, identical-looking
// dashed "add" tile — assign or clean it up from the canvas instead.
export function renderTemplateLogoTileItems() {
  const tl = tlSource();
  const addBtn = `
    <button type="button" class="var-upload-btn hslt-slot" title="Upload logo" onclick="document.getElementById('hsTplLogoUpload').click()">
      <i class="fa-solid fa-plus" aria-hidden="true"></i>
    </button>
    <input type="file" id="hsTplLogoUpload" accept="image/*,.pdf,.ai,.eps" style="display:none" onchange="uploadNewTplLogo(this)">`;
  const slots = Array.from({ length: tl.count }, (_, i) => {
    const slot = (tl.slots || [])[i];
    const src = slot?.logoSrcTight || slot?.logoSrc;
    if (!src) return '';
    return `
      <div class="var-lib-item hslt-slot" title="Slot ${i + 1} — click to replace" onclick="openTlSlotPicker(${i})">
        ${logoThumbHtml(src, '')}
        <button class="var-lib-del" title="Remove" onclick="event.stopPropagation();removeTlSlot(${i})"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>`;
  }).join('');
  return addBtn + slots;
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
  // UI.hsFullEditorOpen distinguishes the full pencil-editor session from a
  // quick-edit draft (see beginQuickEdit in var-editor.js) — the latter also
  // sets HS.editingVarId but must not pop the side-panel editor open.
  if (UI.hsFullEditorOpen) {
    renderEditor();
    renderVariationPreview();
  } else if (HS.editingVarId) {
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

// Appends one more image slot, uncapped — mirrors addTextLayer()'s pattern
// for free text layers. Given a centered default free position/size (rather
// than running the count-based auto-layout math, which isn't built to
// gracefully re-flow an unbounded, incrementally-grown list) since free
// positioning is already fully supported per-slot regardless of how it was
// created. Shared by addTplImage (opens the library-choice picker) and the
// sidebar tile's direct-upload button (skips straight to a file, no slot
// left behind to roll back — see uploadNewTplLogo below).
function createNewTplSlot() {
  const tl = tlSource();
  const idx = tl.count;
  tl.count += 1;
  const w = HS_TPL_LOGO_DEFAULT * 2, h = HS_TPL_LOGO_DEFAULT;
  tl.slots[idx] = { freeX: HS_W / 2 - w / 2, freeY: HS_H / 2 - h / 2, freeW: w, freeH: h };
  tl.customPositions = true;
  UI.tlSelectedIdxs = new Set([idx]);
  redrawTplStructural();
  return idx;
}

window.addTplImage = function () {
  const idx = createNewTplSlot();
  if (HS.editingVarId) {
    UI.hsVarMenuSlotIdx = idx;
    window.openHsVarMenu?.('tplSlot');
  } else {
    UI.hsMenuSlotIdx = idx;
    window.openHsMenu?.('tplSlot');
  }
  openTlLibPicker(idx);
};

// The sidebar tile's own "add" tile (renderTemplateLogoTileItems below) goes
// straight to the OS file picker instead of addTplImage's library-choice
// modal — a plain upload shortcut, not a "pick an existing logo or upload"
// decision. No slot is created until a file actually comes back, so
// cancelling the OS dialog leaves nothing behind; a failed upload rolls the
// slot back for the same reason (never an orphaned empty slot sitting in
// the tile looking like a second, duplicate "add" tile).
window.uploadNewTplLogo = async function (input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const idx = createNewTplSlot();
  try {
    const logo = await uploadLogo(HS.projectId, file);
    HS.library.push(logo);
    assignTlSlot(idx, logo);
  } catch (err) {
    console.error('Upload failed', err);
    const tl = tlSource();
    tl.slots.splice(idx, 1);
    tl.count = Math.max(0, tl.count - 1);
    redrawTplStructural();
  }
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

// Centered modal (not anchored to whatever was clicked) so it reads as a
// deliberate "pick a logo" step — used both right after adding a new image
// and when tapping an empty slot placeholder.
export function openTlLibPicker(idx, { onAssigned } = {}) {
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
      if (logo) { assignTlSlot(idx, logo); onAssigned?.(); }
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
      onAssigned?.();
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

// The dark floating action bar for a selected (filled) template-logo slot —
// same `.dz-toolbar`/`.dz-tb-btn` component as the flag/hole-sign Variations
// logo toolbars, so a template logo now has the same on-canvas interaction
// as any other placed image: Replace/Fine-tune/Remove instead of jumping
// straight to the sidebar's slot-options panel on every click.
export function openTlSlotToolbar(idx, anchorEl) {
  closeTlSlotToolbar();
  const tb = document.createElement('div');
  tb.id = 'tlSlotToolbar';
  tb.className = 'dz-toolbar';
  tb.innerHTML = `
    <button class="dz-tb-btn" id="tlTbFill" title="Fill zone"><i class="fa-solid fa-expand"></i></button>
    <div class="dz-tb-sep"></div>
    <button class="dz-tb-btn" id="tlTbRemoveBg" title="Remove Background"><i class="fa-solid fa-wand-magic-sparkles"></i> Remove Background</button>
    <div class="dz-tb-sep"></div>
    <button class="dz-tb-btn" id="tlTbReplace"><i class="fa-solid fa-arrows-rotate"></i> Replace</button>
    <div class="dz-tb-sep"></div>
    <button class="dz-tb-btn" id="tlTbFinetune" title="Fine-tune"><i class="fa-solid fa-sliders"></i> Fine-tune</button>
    <div class="dz-tb-sep"></div>
    <button class="dz-tb-btn" id="tlTbRemove" title="Remove"><i class="fa-solid fa-trash"></i></button>`;
  document.body.appendChild(tb);
  // .dz-toolbar defaults to display:none in CSS (shared with hsZoneToolbar,
  // which flips it on itself in showHsToolbar) — without this it's built and
  // positioned correctly but never actually rendered.
  tb.style.display = 'flex';

  document.getElementById('tlTbFill').addEventListener('click', () => {
    fillTlSlot(idx);
  });
  document.getElementById('tlTbRemoveBg').addEventListener('click', () => {
    removeTlSlotBg(idx);
  });
  document.getElementById('tlTbReplace').addEventListener('click', () => {
    closeTlSlotToolbar();
    openTlLibPicker(idx);
  });
  document.getElementById('tlTbFinetune').addEventListener('click', () => {
    closeTlSlotToolbar();
    openTlSidePanel(idx);
  });
  document.getElementById('tlTbRemove').addEventListener('click', () => {
    closeTlSlotToolbar();
    window.removeTlSlot(idx);
  });

  const container = anchorEl.closest('.hs-design-preview-col');
  positionFloatingToolbar(tb, anchorEl, container, { gap: 6, toDocument: true });

  setTimeout(() => {
    const close = ev => {
      if (!ev.target.closest('#tlSlotToolbar') && !ev.target.closest('.dz-logo-wrap') && !ev.target.closest('.tl-lib-modal-backdrop')) {
        deselectTlSlots();
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

// Clears template-logo slot selection (state + the .selected outline + the
// floating toolbar) — distinct from closeTlSlotToolbar, which only hides the
// toolbar and is also used mid-selection when swapping it for the Fine-tune
// side panel or the Replace picker, where the slot should stay selected.
// Call this whenever selection is genuinely moving elsewhere on the canvas
// (a text layer, the background, another editor) so a stale selected slot
// doesn't keep hogging the toolbar over content the user has since moved on
// from.
export function deselectTlSlots() {
  closeTlSlotToolbar();
  if (!UI.tlSelectedIdxs.size) return;
  UI.tlSelectedIdxs = new Set();
  document.querySelectorAll('.dz-logo-wrap[data-tl-idx]').forEach(w => w.classList.remove('selected'));
}

// Resets this one slot's box back to its computed default rect (position +
// size for the current template/ratio/layout) — the box-based equivalent of
// the Variations logo toolbar's "Fill zone", which instead resizes a free-
// floating logo to fill its assigned zone. Only this slot is touched; other
// slots keep whatever position they're at (same single-slot scope as Replace/
// assignTlSlot above — template-logo slots, unlike variation logos, are never
// cross-referenced by id from elsewhere, so there's nothing else to update).
function fillTlSlot(idx) {
  const tl = tlSource();
  const slot = tl.slots[idx];
  if (!slot) return;
  const dr = getDefaultSlotRects(tl)[idx];
  if (!dr) return;
  slot.freeX = dr.x; slot.freeY = dr.y; slot.freeW = dr.w; slot.freeH = dr.h;
  closeTlSlotToolbar();
  redrawTplPreview();
}

// Same background-removal flow as the Variations logo toolbar's Remove
// Background (hs/var-toolbar.js) — replace the library entry in place and
// re-run prepareLogo for the fresh artwork bounds/aspect — but scoped to just
// this slot, matching assignTlSlot's single-slot scope (no HS.variations
// cross-reference to update: a template-logo slot's logoId isn't shared the
// way a variation logo layer's is).
async function removeTlSlotBg(idx) {
  const tl = tlSource();
  const slot = tl.slots[idx];
  if (!slot?.logoSrc) return;
  const btn = document.getElementById('tlTbRemoveBg');
  const origHTML = btn?.innerHTML;
  if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Removing…'; btn.disabled = true; }
  const anchorEl = document.querySelector(`.dz-logo-wrap[data-tl-idx="${idx}"]`);
  const spinner = document.createElement('div');
  spinner.className = 'logo-processing-spinner';
  anchorEl?.appendChild(spinner);
  try {
    const oldId = slot.logoId;
    const logo = HS.library.find(l => l.id === oldId) || { src: slot.logoSrc, name: 'logo.png' };
    const newLogo = await removeBgFromLogo(logo, s => {
      if (btn) btn.innerHTML = s === 'uploading' ? '<i class="fa-solid fa-arrow-up-from-bracket"></i> Uploading…' : '<i class="fa-solid fa-spinner fa-spin"></i> Removing…';
    });
    const origIdx = HS.library.findIndex(l => l.id === oldId);
    if (origIdx >= 0) HS.library.splice(origIdx, 1, newLogo);
    else HS.library.push(newLogo);
    slot.logoId = newLogo.id;
    slot.logoSrc = newLogo.src;
    delete slot.logoSrcTight; delete slot.logoAspect; delete slot.logoArtworkBounds;
    await prepareLogo(slot, newLogo.src);
  } catch (err) { console.error('BG removal failed', err); }
  spinner.remove();
  closeTlSlotToolbar();
  redrawTplPreview();
  window._refreshDesignLogosTile?.();
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
    // Default to the uploaded image's own aspect rather than forcing 2:1 —
    // a user who's already picked a specific ratio for this slot keeps it
    // across a Replace.
    ratio: existing?.ratio || 'fit',
    border: { color: '#D1D5DB' },
    ...freePos,
  };
  tl.slots[idx] = slot;
  UI.tlSelectedIdxs = new Set([idx]);
  prepareLogo(slot, logo.src).then(() => {
    // logoAspect is only known once the artwork loads — resize the box to
    // match it now, same math as switching ratio to 'fit' by hand.
    if (slot.ratio === 'fit' && slot.freeH != null) {
      slot.freeW = Math.round(slotWidthForRatio(slot, slot.freeH));
    }
    redrawTplPreview();
    window._refreshDesignLogosTile?.();
  }).catch(() => {});
  redrawTplPreview();
  window._refreshDesignLogosTile?.();
}

// Renders the slot visual-options body as an HTML string for use in the
// sidebar menu. Also used by openTlSidePanel for the floating panel variant.
// Template images are template-owned content — like free text layers, they
// can move above or below the rest of the template's own content (banners,
// static top/bottom text, other template images/logos), but can never sink
// below the background the way variation content can — hence the capped
// 2-item HS_FRAME_LAYER_ORDER (see state.js) instead of variation logos' full
// 3-item HS_LAYER_ORDER. Shown regardless of whether a logo has been assigned
// yet — the slot itself already occupies a paint position.
function tlSlotArrangeSection(idx, slot) {
  const tierIdx = HS_FRAME_LAYER_ORDER.indexOf(getVariationLayer(slot));
  const atBack = tierIdx <= 0;
  const atFront = tierIdx >= HS_FRAME_LAYER_ORDER.length - 1;
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">Arrange</div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn" title="Move to back" onclick="setTlSlotLayer(${idx}, '${HS_FRAME_LAYER_ORDER[0]}')"${atBack ? ' disabled' : ''}><i class="fa-solid fa-arrows-down-to-line" aria-hidden="true"></i></button>
        <button class="hs-tog-btn" title="Send backward" onclick="stepTlSlotLayer(${idx}, -1)"${atBack ? ' disabled' : ''}><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>
        <button class="hs-tog-btn" title="Bring forward" onclick="stepTlSlotLayer(${idx}, 1)"${atFront ? ' disabled' : ''}><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
        <button class="hs-tog-btn" title="Move to front" onclick="setTlSlotLayer(${idx}, '${HS_FRAME_LAYER_ORDER[HS_FRAME_LAYER_ORDER.length - 1]}')"${atFront ? ' disabled' : ''}><i class="fa-solid fa-arrows-up-to-line" aria-hidden="true"></i></button>
      </div>
    </div>`;
}

window.setTlSlotLayer = function (idx, tier) {
  const slot = activeSlot(idx); if (!slot) return;
  setVariationLayer(slot, tier);
  redrawTplPreview();
  openTlSidePanel(idx);
};
window.stepTlSlotLayer = function (idx, dir) {
  const slot = activeSlot(idx); if (!slot) return;
  const next = HS_FRAME_LAYER_ORDER.indexOf(getVariationLayer(slot)) + dir;
  if (next < 0 || next >= HS_FRAME_LAYER_ORDER.length) return;
  setVariationLayer(slot, HS_FRAME_LAYER_ORDER[next]);
  redrawTplPreview();
  openTlSidePanel(idx);
};

export function renderTplSlotBody(idx) {
  const slot = tlSource().slots[idx];
  if (!slot?.logoSrc) return '<div class="hs-section" style="font-size:13px;color:var(--gray-400)">No logo assigned to this slot.</div>' + tlSlotArrangeSection(idx, slot);
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
    ${tlSlotArrangeSection(idx, slot)}
    <div class="hs-editor-section">
      <button class="btn sm" onclick="resetTlSlot(${idx})">Reset position</button>
      <button class="btn sm" style="color:#dc2626;border-color:#fecaca;margin-top:4px" onclick="removeTlSlot(${idx})">Remove logo</button>
    </div>`;
}

// Opens (or refreshes) the Fine-tune controls for one slot as the 'tplSlot'
// level of the same sidebar menu every other design control lives in — the
// same structure renderDesignSection()/renderEditor() already use for
// Background, Top banner, etc. (see HS_MENU_TITLES['tplSlot']).
export function openTlSidePanel(idx) {
  // Already at the tplSlot level — refresh its body in place instead of a
  // full sidebar re-render, so a slider drag doesn't also re-init the canvas.
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
  // Not yet navigated into the tplSlot level (e.g. Fine-tune clicked straight
  // from the canvas toolbar) — same entry point addTplImage() already uses.
  if (HS.editingVarId) {
    UI.hsVarMenuSlotIdx = idx;
    window.openHsVarMenu?.('tplSlot');
  } else {
    UI.hsMenuSlotIdx = idx;
    window.openHsMenu?.('tplSlot');
  }
}

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
