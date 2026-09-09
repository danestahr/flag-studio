import { HS, UI, HS_FRAME_LAYER_ORDER, getVariationLayer, setVariationLayer } from './state.js';
import { HS_FONTS, HS_W, HS_H } from '../hole-sign-data.js';
import { getLogoZone } from '../hole-sign-render.js';
import { applyAutoWidth, updateStep1Preview, repositionToolbar } from './design.js';

// Returns the active text layers array — draft when editing a variation, global otherwise.
export function textLayerSource() {
  if (HS.editingVarId && HS.editingDraft) {
    if (!Array.isArray(HS.editingDraft.textLayers)) {
      HS.editingDraft.textLayers = (HS.textLayers || []).map(l => ({ ...l }));
    }
    return HS.editingDraft.textLayers;
  }
  if (!Array.isArray(HS.textLayers)) HS.textLayers = [];
  return HS.textLayers;
}

function doRefresh() {
  // While the inline editor is open, just update the editor's visual style
  // in place rather than doing a full repaint (which would destroy the editor).
  if (UI.editingTextLayerId) {
    const editor = document.querySelector('.hs-tl-editor');
    if (editor) {
      const layer = textLayerSource().find(l => l.id === UI.editingTextLayerId);
      if (layer) {
        const pr = editor.closest('.hs-tl-overlay')?.parentElement?.getBoundingClientRect();
        const sc = pr?.height ? pr.height / HS_H : 1;
        const fontFamily = HS_FONTS.find(f => f.id === layer.font)?.family || "'DM Serif Display', serif";
        editor.style.fontFamily = fontFamily;
        editor.style.fontSize = Math.max(8, Math.round(layer.size * sc)) + 'px';
        editor.dataset.baseSize = layer.size;
        editor.style.color = layer.color;
        editor.style.textAlign = layer.align || 'center';
      }
    }
    return;
  }
  if (HS.editingVarId) window._hsRenderVariationPreview?.();
  else updateStep1Preview();
}

// ── Add / remove ──────────────────────────────────────────────────────────────

window.addTextLayer = function () {
  const layers = textLayerSource();
  // Match the width of the purple logo placement boundary so a new text box
  // starts out aligned with it, rather than an arbitrary fraction of HS_W.
  const state = (HS.editingVarId && HS.editingDraft) ? HS.editingDraft : HS;
  const lz = getLogoZone(state, state.templateStyle);
  const id = 'tl-' + Date.now();
  layers.push({
    id,
    text: 'Text',
    x: Math.round(lz.x),
    y: Math.round(HS_H * 0.35),
    w: Math.round(lz.w),
    font: 'dm-serif',
    size: 300,
    color: '#000000',
    align: 'center',
    dock: null,
    dockOrder: 0,
  });
  UI.activeTextLayerId = id;
  doRefresh();
};

window.removeTextLayer = function (id) {
  const layers = textLayerSource();
  const idx = layers.findIndex(l => l.id === id);
  if (idx >= 0) layers.splice(idx, 1);
  if (UI.activeTextLayerId === id) UI.activeTextLayerId = null;
  window.closeTextLayerToolbar();
  doRefresh();
};

// ── Toolbar ───────────────────────────────────────────────────────────────────

window.closeTextLayerToolbar = function () {
  const el = document.getElementById('hsTlToolbar');
  if (el) el.remove();
};

window.openTextLayerToolbar = function (id, anchorEl) {
  window.closeTextLayerToolbar();
  const layer = textLayerSource().find(l => l.id === id);
  if (!layer) return;

  const tb = document.createElement('div');
  tb.className = 'hs-tl-toolbar';
  tb.id = 'hsTlToolbar';

  const fontOpts = HS_FONTS.map(f =>
    `<option value="${f.id}"${layer.font === f.id ? ' selected' : ''}>${f.name}</option>`
  ).join('');

  tb.innerHTML = `
    <select class="hs-tl-tb-select" id="hsTlFont">${fontOpts}</select>
    <div class="hs-tl-tb-sep"></div>
    <div class="hs-tl-tb-size-row">
      <input type="range" class="hs-tl-tb-slider" id="hsTlSizeSlider" min="60" max="2000" step="10" value="${layer.size}">
      <span class="hs-tl-tb-size-val" id="hsTlSizeVal">${layer.size}</span>
    </div>
    <div class="hs-tl-tb-sep"></div>
    <input type="color" class="hs-tl-tb-color" id="hsTlColor" value="${layer.color}" title="Color">
    <div class="hs-tl-tb-sep"></div>
    <button class="hs-tl-tb-btn${layer.align === 'left'   ? ' active' : ''}" data-align="left"   title="Left">
      <i class="fa-solid fa-align-left" aria-hidden="true"></i>
    </button>
    <button class="hs-tl-tb-btn${layer.align === 'center' ? ' active' : ''}" data-align="center" title="Center">
      <i class="fa-solid fa-align-center" aria-hidden="true"></i>
    </button>
    <button class="hs-tl-tb-btn${layer.align === 'right'  ? ' active' : ''}" data-align="right"  title="Right">
      <i class="fa-solid fa-align-right" aria-hidden="true"></i>
    </button>
    <div class="hs-tl-tb-sep"></div>
    <button class="hs-tl-tb-btn" id="hsTlLayerToBack" title="Move to back"><i class="fa-solid fa-arrows-down-to-line"></i></button>
    <button class="hs-tl-tb-btn" id="hsTlLayerDown" title="Send backward"><i class="fa-solid fa-arrow-down"></i></button>
    <button class="hs-tl-tb-btn" id="hsTlLayerUp" title="Bring forward"><i class="fa-solid fa-arrow-up"></i></button>
    <button class="hs-tl-tb-btn" id="hsTlLayerToFront" title="Move to front"><i class="fa-solid fa-arrows-up-to-line"></i></button>
    ${layer.dock ? `
    <div class="hs-tl-tb-sep"></div>
    <button class="hs-tl-tb-btn" id="hsTlUndock" title="Pull this layer out of the banner">
      <i class="fa-solid fa-arrow-up-from-bracket"></i> Undock
    </button>` : ''}
    <div class="hs-tl-tb-sep"></div>
    <button class="hs-tl-tb-btn hs-tl-tb-delete" data-del="${id}" title="Remove">Remove</button>`;

  document.body.appendChild(tb);

  // Prevent toolbar buttons from stealing focus away from the contenteditable editor.
  // Input/select elements are exempted so they still receive focus normally.
  tb.addEventListener('mousedown', e => {
    if (!['INPUT', 'SELECT'].includes(e.target.tagName)) e.preventDefault();
  });

  tb.querySelector('#hsTlFont').addEventListener('change', e => {
    const l = textLayerSource().find(x => x.id === id); if (!l) return;
    l.font = e.target.value; doRefresh();
  });
  const sizeSlider = tb.querySelector('#hsTlSizeSlider');
  const sizeVal = tb.querySelector('#hsTlSizeVal');
  sizeSlider.addEventListener('input', e => {
    const n = parseInt(e.target.value, 10);
    sizeVal.textContent = n;
    const l = textLayerSource().find(x => x.id === id); if (!l) return;
    l.size = n; doRefresh();
  });
  tb.querySelector('#hsTlColor').addEventListener('input', e => {
    const l = textLayerSource().find(x => x.id === id); if (!l) return;
    l.color = e.target.value; doRefresh();
  });
  tb.querySelectorAll('[data-align]').forEach(btn => {
    btn.addEventListener('click', () => {
      tb.querySelectorAll('[data-align]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const l = textLayerSource().find(x => x.id === id); if (!l) return;
      l.align = btn.dataset.align; doRefresh();
    });
  });
  tb.querySelector('#hsTlUndock')?.addEventListener('click', () => {
    const l = textLayerSource().find(x => x.id === id); if (!l) return;
    l.dock = null;
    doRefresh();
    window.closeTextLayerToolbar();
  });
  // Free text layers are template-owned content — they can move above or
  // below the rest of the template's own content (banners, static top/bottom
  // text, template images), but unlike variation content they can never sink
  // below the background, hence the capped 2-item HS_FRAME_LAYER_ORDER
  // instead of the 3-item HS_LAYER_ORDER variation logos use.
  const layerToBackBtn = tb.querySelector('#hsTlLayerToBack');
  const layerUpBtn = tb.querySelector('#hsTlLayerUp');
  const layerDownBtn = tb.querySelector('#hsTlLayerDown');
  const layerToFrontBtn = tb.querySelector('#hsTlLayerToFront');
  function syncLayerBtns(l) {
    const idx = HS_FRAME_LAYER_ORDER.indexOf(getVariationLayer(l));
    layerToBackBtn.disabled = idx <= 0;
    layerDownBtn.disabled = idx <= 0;
    layerUpBtn.disabled = idx >= HS_FRAME_LAYER_ORDER.length - 1;
    layerToFrontBtn.disabled = idx >= HS_FRAME_LAYER_ORDER.length - 1;
  }
  function setLayer(tier) {
    const l = textLayerSource().find(x => x.id === id); if (!l) return;
    setVariationLayer(l, tier);
    syncLayerBtns(l);
    doRefresh();
  }
  layerToBackBtn.addEventListener('click', () => setLayer(HS_FRAME_LAYER_ORDER[0]));
  layerToFrontBtn.addEventListener('click', () => setLayer(HS_FRAME_LAYER_ORDER[HS_FRAME_LAYER_ORDER.length - 1]));
  layerUpBtn.addEventListener('click', () => {
    const idx = HS_FRAME_LAYER_ORDER.indexOf(getVariationLayer(layer));
    if (idx < HS_FRAME_LAYER_ORDER.length - 1) setLayer(HS_FRAME_LAYER_ORDER[idx + 1]);
  });
  layerDownBtn.addEventListener('click', () => {
    const idx = HS_FRAME_LAYER_ORDER.indexOf(getVariationLayer(layer));
    if (idx > 0) setLayer(HS_FRAME_LAYER_ORDER[idx - 1]);
  });
  syncLayerBtns(layer);
  tb.querySelector('[data-del]').addEventListener('click', () => {
    window.removeTextLayer(id);
  });

  tb.style.position = 'fixed';
  repositionToolbar(anchorEl);

  setTimeout(() => {
    const close = ev => {
      // Not just `.hs-tl-overlay` — a top/bottom banner zone shares that same
      // class (to reuse this toolbar's styling, see banner.js), so a plain
      // class check here would wrongly treat clicking a *different* band as
      // still being inside this text layer's own overlay and refuse to close.
      if (ev.target.closest('#hsTlToolbar') || anchorEl.contains(ev.target)) return;
      window.closeTextLayerToolbar();
      UI.activeTextLayerId = null;
      document.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.remove('selected'));
      document.removeEventListener('click', close, true);
    };
    document.addEventListener('click', close, true);
  }, 0);
};

// ── Inline edit mode ──────────────────────────────────────────────────────────

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (!UI.activeTextLayerId) return;
  // Ignore while the inline text editor or any toolbar control is focused
  if (document.activeElement?.closest?.('.hs-tl-editor-wrap, [contenteditable], #hsTlToolbar')) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    window.removeTextLayer(UI.activeTextLayerId);
    return;
  }

  const layer = textLayerSource().find(l => l.id === UI.activeTextLayerId);
  if (!layer) return;

  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  // A docked layer's visual position is driven by dockedLayerPositions(), not
  // its stored x/y — nudging those would silently do nothing visible.
  if (arrows[e.key] && !layer.dock) {
    e.preventDefault();
    const step = e.shiftKey ? 100 : 20;
    const [dx, dy] = arrows[e.key];
    layer.x += dx * step;
    layer.y += dy * step;
    doRefresh();
  }
});

// ── Inline edit mode ──────────────────────────────────────────────────────────

window.enterTextLayerEditMode = function (id, overlay, { onCommit } = {}) {
  if (overlay.querySelector('.hs-tl-editor-wrap')) return;
  const layer = textLayerSource().find(l => l.id === id);
  if (!layer) return;

  const parentEl = overlay.parentElement;
  const pr = parentEl?.getBoundingClientRect();
  if (!pr || !pr.height) return;
  const sc = pr.height / HS_H;
  const fontFamily = HS_FONTS.find(f => f.id === layer.font)?.family || "'DM Serif Display', serif";
  const fsPx = Math.max(8, Math.round(layer.size * sc));

  const wrap = document.createElement('div');
  wrap.className = 'hs-tl-editor-wrap';
  wrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';

  const editor = document.createElement('div');
  editor.className = 'hs-tl-editor';
  editor.contentEditable = 'true';
  editor.innerText = layer.text;
  editor.style.cssText = [
    'outline:none;border:none;width:100%;',
    `font-family:${fontFamily};`,
    `font-size:${fsPx}px;`,
    `color:${layer.color};`,
    `text-align:${layer.align || 'center'};`,
    'line-height:1.1;white-space:pre-wrap;word-break:break-word;cursor:text;',
  ].join('');
  editor.dataset.baseSize = layer.size;

  // Hide the permanent text content div so we only see the contenteditable.
  // No SVG text exists in the preview (it's always stripped via hideTextLayers).
  const contentDiv = overlay.querySelector('.hs-tl-content');
  if (contentDiv) contentDiv.style.visibility = 'hidden';

  wrap.appendChild(editor);
  overlay.appendChild(wrap);

  UI.editingTextLayerId = id;

  // Select all on focus
  requestAnimationFrame(() => {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    editor.focus();
  });

  const getText = () => editor.innerText.replace(/\r\n?/g, '\n').trim();

  editor.addEventListener('input', () => {
    layer.text = getText() || layer.text;
    // Keep the hidden textDiv in sync so the overlay auto-expands to match
    // the editor content — no explicit height calculation needed.
    if (contentDiv) contentDiv.textContent = layer.text || 'Text';
    // A collapsed (autoWidth) layer keeps re-fitting its box as the user
    // types — this editor lives inside a full repaint's early-out (see
    // doRefresh() above), so nothing else re-fits it live while it's open.
    if (layer.autoWidth && !layer.dock && parentEl) {
      applyAutoWidth(layer, parentEl);
      overlay.style.left  = (layer.x / HS_W * 100).toFixed(4) + '%';
      overlay.style.width = (layer.w / HS_W * 100).toFixed(4) + '%';
    }
  });

  const commit = () => {
    if (!overlay.contains(wrap)) return; // already committed
    const t = getText();
    if (t) layer.text = t;
    wrap.remove();
    UI.editingTextLayerId = null;
    if (onCommit) onCommit();
    else if (HS.editingVarId) window._hsRenderVariationPreview?.();
    else updateStep1Preview();
  };

  editor.addEventListener('blur', e => {
    // Don't commit if focus moved to the floating toolbar — the user is
    // changing font/color/size while still editing.
    if (e.relatedTarget?.closest?.('#hsTlToolbar')) return;
    // Commit synchronously, not deferred (see banner.js's matching band-editor
    // blur handler): a deferred commit's rerender was landing after the user
    // had already clicked to select something else, clobbering that selection
    // and forcing a second click before it actually stuck.
    if (document.activeElement?.closest('#hsTlToolbar, .hs-tl-editor-wrap')) return;
    commit();
  });

  // Belt-and-suspenders for the blur handler above (see the matching fix on
  // banner.js's band editor): several other canvas surfaces (a logo's empty
  // drop zone, a template-logo slot, the background quick-swap zone) aren't
  // focusable, so clicking them never fires a native blur on this editor at
  // all — nothing then commits the edit, leaving it (and, for quick-edit,
  // HS.editingDraft) dangling until something else happens to commit it. A
  // capture-phase outside click always fires regardless of what the clicked
  // element's own handler does, so use it as the catch-all commit point.
  setTimeout(() => {
    const outsideCommit = ev => {
      if (ev.target.closest?.('.hs-tl-editor-wrap, #hsTlToolbar')) return;
      document.removeEventListener('click', outsideCommit, true);
      commit();
    };
    document.addEventListener('click', outsideCommit, true);
  }, 0);

  editor.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      wrap.remove();
      UI.editingTextLayerId = null;
      if (contentDiv) contentDiv.style.visibility = '';
      if (onCommit) onCommit();
      else if (HS.editingVarId) window._hsRenderVariationPreview?.();
      else updateStep1Preview();
    }
    // Enter / Shift+Enter → soft return (contenteditable default behaviour)
  });
};
