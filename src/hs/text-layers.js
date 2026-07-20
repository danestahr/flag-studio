import { HS, UI } from './state.js';
import { HS_FONTS, HS_W, HS_H } from '../hole-sign-data.js';
import { updateStep1Preview, repositionToolbar } from './design.js';

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
  const id = 'tl-' + Date.now();
  layers.push({
    id,
    text: 'Text',
    x: Math.round(HS_W * 0.1),
    y: Math.round(HS_H * 0.35),
    w: Math.round(HS_W * 0.8),
    font: 'dm-serif',
    size: 300,
    color: '#000000',
    align: 'center',
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
  tb.querySelector('[data-del]').addEventListener('click', () => {
    window.removeTextLayer(id);
  });

  tb.style.position = 'fixed';
  repositionToolbar(anchorEl);

  setTimeout(() => {
    const close = ev => {
      if (ev.target.closest('#hsTlToolbar') || ev.target.closest('.hs-tl-overlay')) return;
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
  if (arrows[e.key]) {
    e.preventDefault();
    const step = e.shiftKey ? 100 : 20;
    const [dx, dy] = arrows[e.key];
    layer.x += dx * step;
    layer.y += dy * step;
    doRefresh();
  }
});

// ── Inline edit mode ──────────────────────────────────────────────────────────

window.enterTextLayerEditMode = function (id, overlay) {
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
  wrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.07);';

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
  });

  const commit = () => {
    if (!overlay.contains(wrap)) return; // already committed
    const t = getText();
    if (t) layer.text = t;
    wrap.remove();
    UI.editingTextLayerId = null;
    if (HS.editingVarId) window._hsRenderVariationPreview?.();
    else updateStep1Preview();
  };

  editor.addEventListener('blur', e => {
    // Don't commit if focus moved to the floating toolbar — the user is
    // changing font/color/size while still editing.
    if (e.relatedTarget?.closest?.('#hsTlToolbar')) return;
    setTimeout(() => {
      if (document.activeElement?.closest('#hsTlToolbar, .hs-tl-editor-wrap')) return;
      commit();
    }, 100);
  });

  editor.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      wrap.remove();
      UI.editingTextLayerId = null;
      if (contentDiv) contentDiv.style.visibility = '';
      if (HS.editingVarId) window._hsRenderVariationPreview?.();
      else updateStep1Preview();
    }
    // Enter / Shift+Enter → soft return (contenteditable default behaviour)
  });
};
