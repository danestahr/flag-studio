import { HS_FONTS } from '../hole-sign-data.js';

// Active and editing state
let _activeFlagTlId = null;
let _editingFlagTlId = null;

// Current rendering context — set each time renderFlagTextOverlays is called
let _ctx = null; // { textLayers, onChange, wrapId }

const TB_ID = 'flagTlToolbar';

function closeFlagTlToolbar() {
  const tb = document.getElementById(TB_ID);
  if (tb) tb.remove();
}

function repositionFlagTlToolbar(anchorEl) {
  const tb = document.getElementById(TB_ID);
  if (!tb || !anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const tbH = tb.offsetHeight || 40;
  const top = rect.top > tbH + 20
    ? rect.top + window.scrollY - tbH - 8
    : rect.bottom + window.scrollY + 8;
  tb.style.top = top + 'px';
  tb.style.left = Math.max(8, rect.left + window.scrollX) + 'px';
}

function openFlagTlToolbar(id, anchorEl, textLayers, onChange) {
  closeFlagTlToolbar();
  const layer = textLayers.find(l => l.id === id);
  if (!layer) return;

  const tb = document.createElement('div');
  tb.className = 'hs-tl-toolbar';
  tb.id = TB_ID;

  const fontOpts = HS_FONTS.map(f =>
    `<option value="${f.id}"${layer.font === f.id ? ' selected' : ''}>${f.name}</option>`
  ).join('');

  tb.innerHTML = `
    <select class="hs-tl-tb-select" id="flagTlFont">${fontOpts}</select>
    <div class="hs-tl-tb-sep"></div>
    <div class="hs-tl-tb-size-row">
      <input type="range" class="hs-tl-tb-slider" id="flagTlSizeSlider" min="1" max="30" step="0.5" value="${layer.fontSize}">
      <span class="hs-tl-tb-size-val" id="flagTlSizeVal">${layer.fontSize}%</span>
    </div>
    <div class="hs-tl-tb-sep"></div>
    <input type="color" class="hs-tl-tb-color" id="flagTlColor" value="${layer.color}" title="Color">
    <div class="hs-tl-tb-sep"></div>
    <button class="hs-tl-tb-btn${layer.align === 'left'   ? ' active' : ''}" data-align="left"   title="Left">
      <svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor"><rect x="0" y="0" width="14" height="2" rx="1"/><rect x="0" y="5" width="8" height="2" rx="1"/><rect x="0" y="10" width="11" height="2" rx="1"/></svg>
    </button>
    <button class="hs-tl-tb-btn${!layer.align || layer.align === 'center' ? ' active' : ''}" data-align="center" title="Center">
      <svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor"><rect x="0" y="0" width="14" height="2" rx="1"/><rect x="3" y="5" width="8" height="2" rx="1"/><rect x="1.5" y="10" width="11" height="2" rx="1"/></svg>
    </button>
    <button class="hs-tl-tb-btn${layer.align === 'right'  ? ' active' : ''}" data-align="right"  title="Right">
      <svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor"><rect x="0" y="0" width="14" height="2" rx="1"/><rect x="6" y="5" width="8" height="2" rx="1"/><rect x="3" y="10" width="11" height="2" rx="1"/></svg>
    </button>
    <div class="hs-tl-tb-sep"></div>
    <button class="hs-tl-tb-btn hs-tl-tb-delete" title="Delete">
      <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor"><path d="M0.75 3.25h10.5M3.75 3.25V1.75h4.5v1.5M1.5 3.25l.75 8a1 1 0 001 .9h5.5a1 1 0 001-.9l.75-8"/></svg>
    </button>`;

  document.body.appendChild(tb);
  tb.style.position = 'fixed';

  tb.addEventListener('mousedown', e => {
    if (!['INPUT', 'SELECT'].includes(e.target.tagName)) e.preventDefault();
  });

  const getWrap = () => _ctx?.wrapId ? document.getElementById(_ctx.wrapId) : null;
  const getOverlay = () => getWrap()?.querySelector(`.flag-tl-overlay[data-tl-id="${id}"]`);
  const getTextDiv = () => getOverlay()?.querySelector('.hs-tl-content');

  tb.querySelector('#flagTlFont').addEventListener('change', e => {
    const l = textLayers.find(x => x.id === id); if (!l) return;
    l.font = e.target.value;
    const family = HS_FONTS.find(f => f.id === l.font)?.family || "'DM Serif Display', serif";
    const div = getTextDiv();
    if (div) div.style.fontFamily = family;
    onChange();
  });

  const sizeSlider = tb.querySelector('#flagTlSizeSlider');
  const sizeVal = tb.querySelector('#flagTlSizeVal');
  sizeSlider.addEventListener('input', e => {
    const n = parseFloat(e.target.value);
    sizeVal.textContent = n + '%';
    const l = textLayers.find(x => x.id === id); if (!l) return;
    l.fontSize = n;
    const wrap = getWrap();
    const div = getTextDiv();
    if (div && wrap) div.style.fontSize = Math.max(8, (n / 100) * wrap.offsetHeight) + 'px';
    onChange();
  });

  tb.querySelector('#flagTlColor').addEventListener('input', e => {
    const l = textLayers.find(x => x.id === id); if (!l) return;
    l.color = e.target.value;
    const div = getTextDiv();
    if (div) div.style.color = l.color;
    onChange();
  });

  tb.querySelectorAll('[data-align]').forEach(btn => {
    btn.addEventListener('click', () => {
      tb.querySelectorAll('[data-align]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const l = textLayers.find(x => x.id === id); if (!l) return;
      l.align = btn.dataset.align;
      const div = getTextDiv();
      if (div) div.style.textAlign = l.align;
      onChange();
    });
  });

  tb.querySelector('.hs-tl-tb-delete').addEventListener('click', () => {
    const idx = textLayers.findIndex(l => l.id === id);
    if (idx >= 0) textLayers.splice(idx, 1);
    _activeFlagTlId = null;
    closeFlagTlToolbar();
    const overlay = getOverlay();
    if (overlay) overlay.remove();
    onChange();
  });

  repositionFlagTlToolbar(anchorEl);

  setTimeout(() => {
    const close = ev => {
      if (ev.target.closest('#' + TB_ID) || ev.target.closest('.flag-tl-overlay')) return;
      closeFlagTlToolbar();
      _activeFlagTlId = null;
      document.querySelectorAll('.flag-tl-overlay').forEach(el => el.classList.remove('selected'));
      document.removeEventListener('click', close, true);
    };
    document.addEventListener('click', close, true);
  }, 0);
}

function enterFlagTlEditMode(id, overlay, textLayers) {
  if (overlay.querySelector('.hs-tl-editor-wrap')) return;
  const layer = textLayers.find(l => l.id === id);
  if (!layer) return;

  const wrap = overlay.parentElement;
  if (!wrap) return;
  const fontFamily = HS_FONTS.find(f => f.id === layer.font)?.family || "'DM Serif Display', serif";
  const fsPx = Math.max(8, (layer.fontSize / 100) * wrap.offsetHeight);

  const editorWrap = document.createElement('div');
  editorWrap.className = 'hs-tl-editor-wrap';
  editorWrap.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.07);';

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

  const contentDiv = overlay.querySelector('.hs-tl-content');
  if (contentDiv) contentDiv.style.visibility = 'hidden';

  editorWrap.appendChild(editor);
  overlay.appendChild(editorWrap);
  _editingFlagTlId = id;

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
    if (contentDiv) contentDiv.textContent = layer.text || 'Text';
  });

  const commit = () => {
    if (!overlay.contains(editorWrap)) return;
    const t = getText();
    if (t) layer.text = t;
    editorWrap.remove();
    _editingFlagTlId = null;
    if (contentDiv) contentDiv.style.visibility = '';
  };

  editor.addEventListener('blur', e => {
    if (e.relatedTarget?.closest?.('#' + TB_ID)) return;
    setTimeout(() => {
      if (document.activeElement?.closest('#' + TB_ID + ', .hs-tl-editor-wrap')) return;
      commit();
    }, 100);
  });

  editor.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      editorWrap.remove();
      _editingFlagTlId = null;
      if (contentDiv) contentDiv.style.visibility = '';
    }
  });
}

function syncFlagTlFontSizes(wrap, textLayers) {
  const sc = wrap.offsetHeight;
  wrap.querySelectorAll('.flag-tl-overlay').forEach(overlay => {
    const layer = textLayers.find(l => l.id === overlay.dataset.tlId);
    if (!layer) return;
    const fsPx = Math.max(8, (layer.fontSize / 100) * sc);
    const div = overlay.querySelector('.hs-tl-content');
    if (div) div.style.fontSize = fsPx + 'px';
    const editor = overlay.querySelector('.hs-tl-editor');
    if (editor) editor.style.fontSize = fsPx + 'px';
  });
}

export function renderFlagTextOverlays(wrapId, textLayers, onChange) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;

  // Reset context for this render
  _ctx = { textLayers, onChange, wrapId };

  wrap.querySelectorAll('.flag-tl-overlay').forEach(el => el.remove());

  // Centre guides for text dragging — span the whole canvas (unlike the logo
  // zone's own guides, which are scoped to that zone's box), since text can be
  // placed anywhere on the flag.
  wrap.querySelectorAll('.flag-tl-guide-h, .flag-tl-guide-v').forEach(el => el.remove());
  const tlGh = document.createElement('div'); tlGh.className = 'dz-guide-h flag-tl-guide-h'; wrap.appendChild(tlGh);
  const tlGv = document.createElement('div'); tlGv.className = 'dz-guide-v flag-tl-guide-v'; wrap.appendChild(tlGv);

  // Keep a live ResizeObserver so font sizes stay correct when the canvas is zoomed
  if (wrap._flagTlRO) wrap._flagTlRO.disconnect();
  if (Array.isArray(textLayers) && textLayers.length) {
    wrap._flagTlRO = new ResizeObserver(() => syncFlagTlFontSizes(wrap, textLayers));
    wrap._flagTlRO.observe(wrap);
  }

  if (!Array.isArray(textLayers) || !textLayers.length) return;

  textLayers.forEach(layer => {
    const sc = wrap.offsetHeight;
    const fontFamily = HS_FONTS.find(f => f.id === layer.font)?.family || "'DM Serif Display', serif";
    const fsPx = Math.max(8, (layer.fontSize / 100) * sc);
    const isActive = _activeFlagTlId === layer.id;

    const overlay = document.createElement('div');
    overlay.className = 'hs-tl-overlay flag-tl-overlay' + (isActive ? ' selected' : '');
    overlay.dataset.tlId = layer.id;
    overlay.style.cssText = `position:absolute;left:${layer.x}%;top:${layer.y}%;width:${layer.w}%;`;

    const textDiv = document.createElement('div');
    textDiv.className = 'hs-tl-content';
    textDiv.style.cssText = [
      'width:100%;pointer-events:none;overflow:visible;',
      `font-family:${fontFamily};font-size:${fsPx}px;`,
      `color:${layer.color};text-align:${layer.align || 'center'};`,
      'line-height:1.1;white-space:pre-wrap;word-break:break-word;',
    ].join('');
    textDiv.textContent = layer.text || 'Text';
    overlay.appendChild(textDiv);

    // Left-edge resize handle
    const lh = document.createElement('div');
    lh.className = 'hs-tl-resize-l';
    let lhStartX, lhStartLayerX, lhStartW;
    lh.addEventListener('pointerdown', e => {
      e.stopPropagation();
      lh.setPointerCapture(e.pointerId);
      lhStartX = e.clientX; lhStartLayerX = layer.x; lhStartW = layer.w;
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    lh.addEventListener('pointermove', e => {
      if (!lh.hasPointerCapture(e.pointerId)) return;
      const sx = wrap.offsetWidth / 100;
      const dx = (e.clientX - lhStartX) / sx;
      const rightEdge = lhStartLayerX + lhStartW;
      const newW = Math.max(5, lhStartW - dx);
      layer.x = rightEdge - newW; layer.w = newW;
      overlay.style.left = layer.x + '%';
      overlay.style.width = newW + '%';
    });
    lh.addEventListener('pointerup', () => { document.body.style.cursor = ''; onChange(); });
    overlay.appendChild(lh);

    // Right-edge resize handle
    const rh = document.createElement('div');
    rh.className = 'hs-tl-resize-r';
    let rhStartX, rhStartW;
    rh.addEventListener('pointerdown', e => {
      e.stopPropagation();
      rh.setPointerCapture(e.pointerId);
      rhStartX = e.clientX; rhStartW = layer.w;
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    rh.addEventListener('pointermove', e => {
      if (!rh.hasPointerCapture(e.pointerId)) return;
      const sx = wrap.offsetWidth / 100;
      const newW = Math.max(5, rhStartW + (e.clientX - rhStartX) / sx);
      layer.w = newW;
      overlay.style.width = newW + '%';
    });
    rh.addEventListener('pointerup', () => { document.body.style.cursor = ''; onChange(); });
    overlay.appendChild(rh);

    // Corner handles — drag to scale font size
    const makeCorner = (cls, xSign, ySign) => {
      const ch = document.createElement('div');
      ch.className = `hs-tl-resize-corner ${cls}`;
      let chStartX, chStartY, chStartSize;
      ch.addEventListener('pointerdown', e => {
        e.stopPropagation();
        ch.setPointerCapture(e.pointerId);
        chStartX = e.clientX; chStartY = e.clientY; chStartSize = layer.fontSize;
        document.body.style.cursor = getComputedStyle(ch).cursor || 'nwse-resize';
        e.preventDefault();
      });
      ch.addEventListener('pointermove', e => {
        if (!ch.hasPointerCapture(e.pointerId)) return;
        const dx = (e.clientX - chStartX) * xSign;
        const dy = (e.clientY - chStartY) * ySign;
        const outward = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
        const newSize = Math.max(0.5, Math.min(40, parseFloat((chStartSize + outward * 0.05).toFixed(1))));
        layer.fontSize = newSize;
        textDiv.style.fontSize = Math.max(8, (newSize / 100) * wrap.offsetHeight) + 'px';
        const slider = document.getElementById('flagTlSizeSlider');
        const val = document.getElementById('flagTlSizeVal');
        if (slider) slider.value = newSize;
        if (val) val.textContent = newSize + '%';
      });
      ch.addEventListener('pointerup', () => { document.body.style.cursor = ''; onChange(); });
      return ch;
    };
    overlay.appendChild(makeCorner('tl', -1, -1));
    overlay.appendChild(makeCorner('tr',  1, -1));
    overlay.appendChild(makeCorner('bl', -1,  1));
    overlay.appendChild(makeCorner('br',  1,  1));

    // Click: select + open toolbar
    overlay.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.flag-tl-overlay').forEach(el => el.classList.remove('selected'));
      overlay.classList.add('selected');
      _activeFlagTlId = layer.id;
      openFlagTlToolbar(layer.id, overlay, textLayers, onChange);
    });

    // Double-click: inline edit
    overlay.addEventListener('dblclick', e => {
      e.stopPropagation();
      enterFlagTlEditMode(layer.id, overlay, textLayers);
    });

    // Drag to move
    let startCX, startCY, startX, startY, didDrag = false;
    overlay.addEventListener('pointerdown', e => {
      if (e.target.closest('.hs-tl-editor-wrap, .hs-tl-resize-l, .hs-tl-resize-r, .hs-tl-resize-corner')) return;
      overlay.setPointerCapture(e.pointerId);
      startCX = e.clientX; startCY = e.clientY;
      startX = layer.x; startY = layer.y;
      didDrag = false;
      e.preventDefault();
    });

    overlay.addEventListener('pointermove', e => {
      if (!overlay.hasPointerCapture(e.pointerId)) return;
      const sx = wrap.offsetWidth  / 100;
      const sy = wrap.offsetHeight / 100;
      const dx = (e.clientX - startCX) / sx;
      const dy = (e.clientY - startCY) / sy;
      if (!didDrag && Math.hypot(dx, dy) > 2) {
        didDrag = true;
        closeFlagTlToolbar();
        document.body.style.cursor = 'grabbing';
      }
      if (!didDrag) return;
      let nx = Math.max(-layer.w + 5, Math.min(95, startX + dx));
      let ny = Math.max(0, Math.min(100, startY + dy));

      // Snap the text box's own center (not just its top-left anchor) to the
      // canvas center — matches the logo drop-zone's snap-to-center behavior.
      const halfWPct = layer.w / 2;
      const halfHPct = (overlay.offsetHeight / wrap.offsetHeight * 100) / 2;
      const snapTolX = 5 / wrap.offsetWidth  * 100;
      const snapTolY = 5 / wrap.offsetHeight * 100;
      const snapH = Math.abs((nx + halfWPct) - 50) < snapTolX;
      const snapV = Math.abs((ny + halfHPct) - 50) < snapTolY;
      if (snapH) nx = 50 - halfWPct;
      if (snapV) ny = 50 - halfHPct;
      wrap.classList.toggle('dz-adjusting', true);
      wrap.classList.toggle('snap-h', snapH);
      wrap.classList.toggle('snap-v', snapV);

      layer.x = nx; layer.y = ny;
      overlay.style.left = nx + '%';
      overlay.style.top  = ny + '%';
    });

    overlay.addEventListener('pointerup', () => {
      document.body.style.cursor = '';
      wrap.classList.remove('dz-adjusting', 'snap-h', 'snap-v');
      if (didDrag) {
        onChange();
        if (_activeFlagTlId === layer.id) {
          requestAnimationFrame(() => openFlagTlToolbar(layer.id, overlay, textLayers, onChange));
        }
      }
      didDrag = false;
    });

    wrap.appendChild(overlay);
  });
}

export function addFlagTextLayer(textLayers, wrapId, onChange) {
  const id = 'ftl-' + Date.now();
  textLayers.push({
    id,
    text: 'Text',
    x: 10,
    y: 40,
    w: 80,
    fontSize: 5,
    font: 'dm-serif',
    color: '#000000',
    align: 'center',
  });
  _activeFlagTlId = id;
  renderFlagTextOverlays(wrapId, textLayers, onChange);
  onChange();
  const overlay = document.querySelector(`.flag-tl-overlay[data-tl-id="${id}"]`);
  if (overlay) {
    overlay.classList.add('selected');
    openFlagTlToolbar(id, overlay, textLayers, onChange);
  }
}

// Keyboard shortcuts for active text layer
document.addEventListener('keydown', e => {
  if (!_activeFlagTlId || !_ctx) return;
  if (_editingFlagTlId) return;
  if (document.activeElement?.closest?.('.hs-tl-editor-wrap, [contenteditable], #' + TB_ID)) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const { textLayers, onChange, wrapId } = _ctx;
    const idx = textLayers.findIndex(l => l.id === _activeFlagTlId);
    if (idx >= 0) textLayers.splice(idx, 1);
    _activeFlagTlId = null;
    closeFlagTlToolbar();
    renderFlagTextOverlays(wrapId, textLayers, onChange);
    onChange();
    return;
  }

  const { textLayers, onChange, wrapId } = _ctx;
  const layer = textLayers.find(l => l.id === _activeFlagTlId);
  if (!layer) return;

  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1;
    const [dx, dy] = arrows[e.key];
    layer.x += dx * step;
    layer.y += dy * step;
    const wrap = document.getElementById(wrapId);
    const overlay = wrap?.querySelector(`.flag-tl-overlay[data-tl-id="${_activeFlagTlId}"]`);
    if (overlay) {
      overlay.style.left = layer.x + '%';
      overlay.style.top  = layer.y + '%';
    }
    onChange();
  }
});
