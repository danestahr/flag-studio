// Shared zoomable canvas panel for the Variations step of both the flag and
// hole-sign editors: viewport-height fitting and ctrl/cmd+scroll zoom. Each
// tool owns its own zoom-% state (a module variable or a UI object field)
// via getZoom/setZoom — this only touches DOM.

import { esc } from './dom-utils.js';

const MIN_ZOOM = 40;
const MAX_ZOOM = 400;
const MIN_HEIGHT = 240;
// Breathing room left below the viewport-height-fitted canvas so it stops
// short of the browser's bottom edge instead of touching it flush.
const BELOW_MARGIN = 24;
// Gap reserved between the fitted canvas and canvas-scroll's own edge, so a
// drag/resize handle anchored just outside a logo/text box's corner (see
// .dz-resize, .hs-tl-resize-*) has somewhere to render when that box sits
// flush against the canvas edge — otherwise canvas-scroll's overflow:auto
// clips the handle exactly when it's needed to pull the box back.
const EDGE_MARGIN = 12;

// Resize listeners are process-global (one per scrollId, however many times
// the panel's DOM gets rebuilt) — keyed by id since the actual scroll/wrap
// elements get torn down and recreated on every re-render in the hole-sign
// tool, but document.getElementById is always re-resolved at fire time.
const wiredResize = new Set();

function fitCanvas(scroll, wrap, aspect, pct) {
  if (!scroll || !wrap) return;
  // Budget off the whole panel's bottom edge, not just canvas-scroll's own —
  // otherwise the footer (zoom controls / bleed hint) that follows the scroll
  // area inside the panel eats into BELOW_MARGIN and pushes the panel itself
  // past the viewport instead of leaving breathing room below it.
  const panel = scroll.closest('.var-canvas-panel') || scroll;
  const panelTop = panel.getBoundingClientRect().top;
  const chromeHeight = panel.offsetHeight - scroll.offsetHeight;
  const availH = Math.max(MIN_HEIGHT, Math.round(window.innerHeight - panelTop - chromeHeight - BELOW_MARGIN));
  scroll.style.height = availH + 'px';
  const cw = scroll.clientWidth - EDGE_MARGIN * 2, ch = scroll.clientHeight - EDGE_MARGIN * 2;
  if (cw <= 0 || ch <= 0) return;
  let w = cw, h = cw / aspect;
  if (h > ch) { h = ch; w = ch * aspect; }
  const k = (pct || 100) / 100;
  wrap.style.width  = Math.round(w * k) + 'px';
  wrap.style.height = Math.round(h * k) + 'px';
}

// Keeps a side panel (e.g. the variations list) sized to roughly fill the
// remaining viewport height, using the same live-measured math as fitCanvas
// above rather than CSS position:sticky + a vh-based height — a sticky panel
// with a viewport-relative height overflows the viewport whenever its actual
// (pre-stick) position sits lower than the offset that height assumes, which
// is exactly what happened once a sticky header sat above it too.
const wiredPanelResize = new Set();

export function fitSidePanel(panelId, minHeight = MIN_HEIGHT) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const top = panel.getBoundingClientRect().top;
  panel.style.height = Math.max(minHeight, Math.round(window.innerHeight - top - BELOW_MARGIN)) + 'px';

  if (!wiredPanelResize.has(panelId)) {
    wiredPanelResize.add(panelId);
    let raf = null;
    window.addEventListener('resize', () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitSidePanel(panelId, minHeight));
    });
    // Web fonts swapping in after this initial measurement can reflow the
    // header above this panel (different line-wrap/metrics), shifting `top`
    // out from under it with nothing left to trigger a re-measure — redo it
    // once fonts have actually settled.
    document.fonts?.ready.then(() => fitSidePanel(panelId, minHeight));
  }
}

export function createCanvasPanel({
  scrollId, wrapId, zoomValueId, zoomResetId,
  aspect, getZoom, setZoom, onApply,
}) {
  function refit() {
    fitCanvas(document.getElementById(scrollId), document.getElementById(wrapId), aspect, getZoom());
  }

  function apply(pct) {
    setZoom(pct);
    refit();
    const label = document.getElementById(zoomValueId);
    const reset = document.getElementById(zoomResetId);
    if (label) label.textContent = pct + '%';
    if (reset) reset.style.display = pct === 100 ? 'none' : '';
    onApply?.();
  }

  function setZoomClamped(val) {
    apply(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, parseInt(val, 10) || 100)));
  }

  function wireOnce() {
    const scroll = document.getElementById(scrollId);
    if (scroll && !scroll.__zoomWired) {
      scroll.__zoomWired = true;
      scroll.addEventListener('wheel', e => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const wrap = document.getElementById(wrapId);
        if (!wrap) return;
        const before = wrap.getBoundingClientRect();
        if (!before.width || !before.height) return;
        const fracX = (e.clientX - before.left) / before.width;
        const fracY = (e.clientY - before.top)  / before.height;
        const oldZoom = getZoom();
        const factor = 1 + Math.max(-0.25, Math.min(0.25, -e.deltaY * 0.005));
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(oldZoom * factor)));
        if (newZoom === oldZoom) return;
        apply(newZoom);
        const after = wrap.getBoundingClientRect();
        scroll.scrollLeft += (after.left + fracX * after.width)  - e.clientX;
        scroll.scrollTop  += (after.top  + fracY * after.height) - e.clientY;
      }, { passive: false });
    }

    const resetBtn = document.getElementById(zoomResetId);
    if (resetBtn && !resetBtn.__wired) {
      resetBtn.__wired = true;
      resetBtn.addEventListener('click', () => setZoomClamped(100));
    }

    if (!wiredResize.has(scrollId)) {
      wiredResize.add(scrollId);
      let raf = null;
      // A bare window resize changes the wrap's fitted px size exactly like a
      // zoom does (fitCanvas takes both into account), so it needs the same
      // onApply refresh (text overlay font rescale, image-box/text-layer clip
      // refresh) a zoom gets — not just refit()'s width/height update.
      window.addEventListener('resize', () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { refit(); onApply?.(); });
      });
      // Web fonts swapping in after the initial refit below can reflow
      // surrounding chrome and shift this panel's top offset — redo it once
      // fonts have actually settled.
      document.fonts?.ready.then(() => { refit(); onApply?.(); });
    }
  }

  wireOnce();
  // Nothing else forces an initial fit — without this the canvas would sit
  // at its natural (unconstrained) CSS size until the first resize/zoom
  // interaction, which is exactly what showed up as a clipped-looking canvas
  // on first load. apply() (not a bare refit()) so a non-100 initial getZoom()
  // — a tool that opens pre-zoomed-out — gets its label/reset-button synced
  // too, not just the canvas size itself.
  apply(getZoom());
  return { apply, setZoom: setZoomClamped, refit };
}

// Full canvas-panel shell for the Variations step: header (name + optional
// "+" button), a floating overlay slot (edit-request note + an optional
// Front/Back face toggle, hidden by default — the hole-sign tool doesn't
// [yet] support independently-editable sides, so it renders the row but
// leaves it hidden rather than omitting the structure) anchored over the top
// of the canvas the same way .canvas-panel-footer floats over its bottom,
// the zoomable canvas box, and a description/zoom-controls footer.
// `container` must already be the `.var-canvas-panel` element — this only
// fills it in and wires the header/face-toggle controls; zoom behavior is
// delegated to createCanvasPanel above.
export function renderCanvasPanel(container, {
  panelId, scrollId, wrapId, zoomValueId, zoomResetId,
  aspect, getZoom, setZoom, onApply,
  headerName = '', headerNameId = panelId + 'Title',
  onAdd, addBtnId = panelId + 'AddBtn', addBtnTitle = 'Add text or logo',
  noteHtml = '',
  faceToggleHidden = true,
  faceTabFrontId = panelId + 'FaceFront', faceTabBackId = panelId + 'FaceBack', onFaceChange,
  sameSidesRowId = panelId + 'SidesRow', sameSidesCheckId = panelId + 'SidesCheck', onToggleSameSides,
  canvasContentHtml = '',
  description = '',
  zoomHint = '⌘ + scroll to zoom',
}) {
  if (!container) return null;
  // When the face toggle is shown (flags' Variations step — the only caller
  // with both an add button and a visible face row), the add button moves
  // into that same row (Front/Back left, toggle, then the button) instead of
  // getting its own header line. Every other caller (headerName-only panels,
  // or hole signs' hidden face row) keeps the button in the header as before.
  const addBtnInFaceRow = !!(onAdd && !faceToggleHidden);
  const addBtnHtml = onAdd ? `<button class="btn sm" id="${addBtnId}" type="button" title="${esc(addBtnTitle)}"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>` : '';
  const hasHeader = !!(headerName || (onAdd && !addBtnInFaceRow));
  container.innerHTML = `
    ${hasHeader ? `
    <div class="canvas-panel-header">
      <span class="canvas-panel-title" id="${headerNameId}">${esc(headerName)}</span>
      ${addBtnInFaceRow ? '' : addBtnHtml}
    </div>` : ''}
    <div class="canvas-panel-overlay-top">
      ${noteHtml}
      <div class="canvas-face-row"${faceToggleHidden ? ' style="display:none"' : ''}>
        <div class="face-toggle-row">
          <button class="face-tab active" id="${faceTabFrontId}" type="button">Front</button>
          <button class="face-tab" id="${faceTabBackId}" type="button">Back</button>
        </div>
        <div class="sides-row" id="${sameSidesRowId}" style="display:none">
          <label class="gs-tag-label">
            <input type="checkbox" id="${sameSidesCheckId}" class="gs-toggle-input">
            <span class="gs-toggle-text">Same Front &amp; Back Design</span>
            <span class="gs-toggle-switch"></span>
          </label>
        </div>
        ${addBtnInFaceRow ? addBtnHtml : ''}
      </div>
    </div>
    <div class="canvas-preview-box">
      <div class="canvas-scroll" id="${scrollId}">
        <div class="canvas-scroll-inner">
          <div class="canvas-zoom-wrap" id="${wrapId}">${canvasContentHtml}</div>
        </div>
      </div>
    </div>
    <div class="canvas-panel-footer">
      <div class="canvas-bleed-hint">${esc(description)}</div>
      <div class="canvas-zoom-row">
        <span class="canvas-zoom-value" id="${zoomValueId}">100%</span>
        <button class="canvas-zoom-reset" id="${zoomResetId}" type="button" style="display:none">Reset</button>
        <span class="canvas-zoom-hint">${esc(zoomHint)}</span>
      </div>
    </div>`;

  if (onAdd) document.getElementById(addBtnId)?.addEventListener('click', onAdd);
  document.getElementById(faceTabFrontId)?.addEventListener('click', () => onFaceChange?.('front'));
  document.getElementById(faceTabBackId)?.addEventListener('click', () => onFaceChange?.('back'));
  document.getElementById(sameSidesCheckId)?.addEventListener('change', e => onToggleSameSides?.(e.target.checked));

  return createCanvasPanel({ scrollId, wrapId, zoomValueId, zoomResetId, aspect, getZoom, setZoom, onApply });
}
