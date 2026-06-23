import { HS, UI } from './state.js';
import { HS_H, HS_W } from '../hole-sign-data.js';
import { getEffectiveState, getEffectiveVariation } from './state.js';
import { getLogoZone, getTemplateLogoSlots, renderHoleSignInto } from '../hole-sign-render.js';
import { hideHsToolbar, prepareLogo, applyFillToVariation } from './logo-utils.js';
import { isDisplayableImage, fileTypeLabel } from '../media-utils.js';
import { stripSlotImages, paintTplSlotOverlays } from './design.js';
import { wireCanvasTextEditing, wireElementDrag, wireQuickAddHover } from './banner.js';
import { showHsToolbar } from './var-toolbar.js';
import { renderVarList } from './variations.js';

// ── Canvas sizing & zoom ───────────────────────────────────

function fitWrap(scroll, wrap, pct) {
  if (!scroll || !wrap) return;
  const top = scroll.getBoundingClientRect().top;
  const availH = Math.max(240, Math.round(window.innerHeight - top - 24));
  scroll.style.height = availH + 'px';
  const cw = scroll.clientWidth, ch = scroll.clientHeight;
  if (!cw || !ch) return;
  const ar = HS_W / HS_H;
  let w = cw, h = cw / ar;
  if (h > ch) { h = ch; w = ch * ar; }
  const k = (pct || 100) / 100;
  wrap.style.width  = Math.round(w * k) + 'px';
  wrap.style.height = Math.round(h * k) + 'px';
}

// When zoom changes during inline text editing, rescale the input's font size so
// the cursor/selection highlight stays aligned with the visible SVG text.
function rescaleEditorInput(previewId) {
  requestAnimationFrame(() => {
    const preview = document.getElementById(previewId);
    const input = preview?.querySelector('.canvas-edit-input');
    if (!input || !preview) return;
    const sc = (preview.clientHeight || HS_H) / HS_H;
    const kind = input.closest('.canvas-edit-zone')?.dataset?.kind;
    if (!kind) return;
    const src = (HS.editingVarId && HS.editingDraft) ? HS.editingDraft : HS;
    const t = kind === 'top'            ? src.topText
            : kind === 'bottom'         ? src.bottomText
            : kind === 'bannerTopTitle' ? src.bannerTop?.topText
            : kind === 'bannerTopSub'   ? src.bannerTop?.subText
            : kind === 'bannerBotTitle' ? src.bannerBottom?.topText
            : kind === 'bannerBotSub'   ? src.bannerBottom?.subText
            : null;
    if (!t) return;
    input.style.fontSize = Math.max(9, Math.round((t.size || 200) * sc)) + 'px';
  });
}

export function applyHsZoom(pct) {
  UI.hsZoom = pct;
  fitWrap(document.getElementById('hsCanvasScroll'), document.getElementById('hsZoomWrap'), pct);
  const label = document.getElementById('hsZoomValue');
  const reset = document.getElementById('hsZoomReset');
  if (label) label.textContent = pct + '%';
  if (reset) reset.style.display = pct === 100 ? 'none' : '';
  if (UI.canvasEdit) rescaleEditorInput('hsSignPreview');
}

window.setHsZoom = function (val) {
  applyHsZoom(Math.max(40, Math.min(400, parseInt(val, 10) || 100)));
};

export function applyHsStep1Zoom(pct) {
  UI.hsStep1Zoom = pct;
  fitWrap(document.getElementById('hsStep1Scroll'), document.getElementById('hsStep1ZoomWrap'), pct);
  const label = document.getElementById('hsStep1ZoomValue');
  const reset = document.getElementById('hsStep1ZoomReset');
  if (label) label.textContent = pct + '%';
  if (reset) reset.style.display = pct === 100 ? 'none' : '';
  if (UI.canvasEdit) rescaleEditorInput('hsStep1Preview');
}

window.setHsStep1Zoom = function (val) {
  applyHsStep1Zoom(Math.max(40, Math.min(400, parseInt(val, 10) || 100)));
};

let _hsResizeWired = false;
function wireCanvasResize() {
  if (_hsResizeWired) return;
  _hsResizeWired = true;
  let raf = null;
  window.addEventListener('resize', () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      fitWrap(document.getElementById('hsCanvasScroll'),  document.getElementById('hsZoomWrap'),      UI.hsZoom);
      fitWrap(document.getElementById('hsStep1Scroll'),   document.getElementById('hsStep1ZoomWrap'), UI.hsStep1Zoom);
    });
  });
}

export function wireCanvasZoom(scrollId, wrapId, getZoom, applyZoom) {
  wireCanvasResize();
  const scroll = document.getElementById(scrollId);
  if (!scroll || scroll.__zoomWired) return;
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
    const newZoom = Math.max(40, Math.min(400, Math.round(oldZoom * factor)));
    if (newZoom === oldZoom) return;
    applyZoom(newZoom);
    const after = wrap.getBoundingClientRect();
    scroll.scrollLeft += (after.left + fracX * after.width)  - e.clientX;
    scroll.scrollTop  += (after.top  + fracY * after.height) - e.clientY;
  }, { passive: false });
}

// ── Logo position helper ───────────────────────────────────

export function positionWrap(wrap, ld) {
  wrap.style.left   = ld.x + '%';
  wrap.style.top    = ld.y + '%';
  wrap.style.width  = ld.w + '%';
  wrap.style.height = 'auto';
}

// ── Logo drag/resize interaction ───────────────────────────

export function setupHsInteraction(dz, wrap, handle, variation) {
  let mode = null;
  let startPX, startPY, startX, startY, rStartX, rStartW;

  wrap.addEventListener('pointerdown', e => {
    if (e.target === handle) return;
    mode = 'move';
    dz.classList.add('dz-adjusting');
    wrap.setPointerCapture(e.pointerId);
    startPX = e.clientX; startPY = e.clientY;
    startX  = parseFloat(wrap.style.left);
    startY  = parseFloat(wrap.style.top);
    e.preventDefault();
  });

  handle.addEventListener('pointerdown', e => {
    mode = 'resize';
    dz.classList.add('dz-adjusting');
    handle.setPointerCapture(e.pointerId);
    rStartX = e.clientX;
    rStartW = parseFloat(wrap.style.width);
    e.stopPropagation();
    e.preventDefault();
  });

  wrap.addEventListener('pointermove', e => {
    if (!mode) return;
    const ld = variation.logoData || { x: 50, y: 50, w: 90 };
    if (mode === 'move') {
      const dzRect = dz.getBoundingClientRect();
      const dx = (e.clientX - startPX) / dzRect.width  * 100;
      const dy = (e.clientY - startPY) / dzRect.height * 100;
      let nx = startX + dx;
      let ny = startY + dy;
      const snapX = 5 / dzRect.width  * 100;
      const snapY = 5 / dzRect.height * 100;
      const snapH = Math.abs(nx - 50) < snapX;
      const snapV = Math.abs(ny - 50) < snapY;
      if (snapH) nx = 50;
      if (snapV) ny = 50;
      dz.classList.toggle('snap-h', snapH);
      dz.classList.toggle('snap-v', snapV);
      ld.x = nx; ld.y = ny;
      variation.logoData = ld;
      positionWrap(wrap, ld);
    } else if (mode === 'resize') {
      const dzRect = dz.getBoundingClientRect();
      const delta = (e.clientX - rStartX) / dzRect.width * 100 * 2;
      const nw = Math.max(10, rStartW + delta);
      const ld2 = variation.logoData || { x: 50, y: 50, w: 90 };
      ld2.w = nw;
      variation.logoData = ld2;
      positionWrap(wrap, ld2);
    }
  });

  handle.addEventListener('pointermove', e => {
    if (mode !== 'resize') return;
    const ld = variation.logoData || { x: 50, y: 50, w: 90 };
    const dzRect = dz.getBoundingClientRect();
    const delta = (e.clientX - rStartX) / dzRect.width * 100 * 2;
    ld.w = Math.max(10, rStartW + delta);
    variation.logoData = ld;
    positionWrap(wrap, ld);
  });

  const onUp = () => {
    if (!mode) return;
    mode = null;
    dz.classList.remove('dz-adjusting', 'snap-h', 'snap-v');
    renderVarList();
  };
  wrap.addEventListener('pointerup', onUp);
  handle.addEventListener('pointerup', onUp);
}

// ── Variation preview ──────────────────────────────────────

export function renderVariationPreview() {
  hideHsToolbar();
  const preview = document.getElementById('hsSignPreview');
  if (!preview) return;
  preview.innerHTML = '';

  // Default hole sign selected — render it full-canvas, read-only
  if (UI.activeDefaultId) {
    const def = HS.defaults.find(d => d.id === UI.activeDefaultId);
    if (def) {
      const defState = {
        templateStyle: 'hole-sign-full-graphic',
        background: { type: 'color', color: '#ffffff' },
        topText: { text: '' }, bottomText: { text: '' },
        bannerTop: null, bannerBottom: null,
        templateLogos: { count: 0, slots: [] },
      };
      const defVariation = { logoSrc: def.src };
      renderHoleSignInto(preview, defState, defVariation);
      const svgEl = preview.querySelector('svg');
      if (svgEl) svgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    }
    return;
  }

  const activeVar = HS.activeVarId ? HS.variations.find(v => v.id === HS.activeVarId) : null;
  const effState = getEffectiveState(activeVar);
  const isEditingActive = HS.editingVarId && HS.editingVarId === HS.activeVarId;

  // Re-snap template logo slots to the current layout so banner/text changes
  // automatically reposition non-custom slots. Inline to avoid circular import.
  if (isEditingActive && HS.editingDraft) {
    const tl = HS.editingDraft.templateLogos;
    if (tl && !tl.customPositions && tl.count > 0) {
      const tlCopy = { ...tl, slots: (tl.slots || []).map(() => null) };
      const draftState = { ...HS, ...HS.editingDraft, templateLogos: tlCopy };
      const tid = HS.editingDraft.templateStyle || HS.templateStyle;
      const defaults = getTemplateLogoSlots(draftState, tid);
      (tl.slots || []).forEach((s, i) => {
        if (!s) return;
        const d = defaults[i];
        if (d) { s.freeX = d.x; s.freeY = d.y; s.freeW = d.w; s.freeH = d.h; }
      });
    }
  }

  const isFullGraphic = effState.templateStyle === 'hole-sign-full-graphic';

  const bgSvgDiv = document.createElement('div');
  bgSvgDiv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  // Full-graphic: logo lives inside the SVG, so always pass the variation.
  // Standard templates: logo is a DOM overlay; only pass variation when there's no logo
  // (so the text/sponsor fallback still renders in the SVG).
  const bgVarForRender = isFullGraphic
    ? getEffectiveVariation(activeVar)
    : (activeVar && !activeVar.logoSrc ? getEffectiveVariation(activeVar) : null);
  const bgState = isEditingActive ? stripSlotImages(effState) : effState;
  renderHoleSignInto(bgSvgDiv, bgState, bgVarForRender);
  const bgSvgEl = bgSvgDiv.querySelector('svg');
  if (bgSvgEl) {
    bgSvgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    preview.appendChild(bgSvgEl);
  }

  if (!HS.activeVarId) {
    const ph = document.createElement('div');
    ph.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;color:rgba(255,255,255,.6);';
    ph.textContent = 'Select or upload a logo';
    preview.appendChild(ph);
    return;
  }

  const variation = getEffectiveVariation(activeVar);
  if (!variation) return;
  const lz = getLogoZone(effState, effState.templateStyle);
  const dzone = document.createElement('div');
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  dzone.style.cssText = `position:absolute;left:${pct(lz.x, HS_W)};top:${pct(lz.y, HS_H)};width:${pct(lz.w, HS_W)};height:${pct(lz.h, HS_H)};`;

  if (isFullGraphic) {
    // Full-graphic: image fills the canvas via the SVG renderer; dzone is just an
    // invisible interaction surface for drop and toolbar (no handles or guides).
    dzone.className = 'dzone dzone-full-graphic' + (variation.logoSrc ? ' has-logo' : '');
    dzone.style.cursor = 'pointer';
    dzone.addEventListener('click', e => {
      e.stopPropagation();
      if (UI.hsActiveZone?.dzone === dzone) { hideHsToolbar(); return; }
      if (UI.hsActiveZone) UI.hsActiveZone.dzone.classList.remove('selected');
      UI.hsActiveZone = { dzone, variation };
      showHsToolbar(dzone, !variation.logoSrc);
    });
  } else {
    const hasLogo = !!variation.logoSrc;
    dzone.className = 'dzone' + (hasLogo ? ' has-logo' : ' hs-logo-placeholder');
    const gh = document.createElement('div'); gh.className = 'dz-guide-h'; dzone.appendChild(gh);
    const gv = document.createElement('div'); gv.className = 'dz-guide-v'; dzone.appendChild(gv);

    if (hasLogo) {
      const ld = variation.logoData || { x: 50, y: 50, w: 90 };
      const wrap = document.createElement('div');
      wrap.className = 'dz-logo-wrap';
      positionWrap(wrap, ld);

      const displaySrc = variation.logoSrcTight || variation.logoSrc;
      if (isDisplayableImage(displaySrc)) {
        const img = document.createElement('img');
        img.className = 'placed-img';
        img.src = displaySrc;
        img.alt = variation.name;
        img.draggable = false;
        wrap.appendChild(img);
      } else {
        const badge = document.createElement('div');
        badge.className = 'placed-file-badge';
        badge.textContent = fileTypeLabel(displaySrc);
        wrap.appendChild(badge);
      }

      const handle = document.createElement('div');
      handle.className = 'dz-resize';
      wrap.appendChild(handle);

      dzone.appendChild(wrap);
      setupHsInteraction(dzone, wrap, handle, variation);

      wrap.addEventListener('click', e => {
        e.stopPropagation();
        if (UI.hsActiveZone?.dzone === dzone) { hideHsToolbar(); return; }
        if (UI.hsActiveZone) UI.hsActiveZone.dzone.classList.remove('selected');
        UI.hsActiveZone = { dzone, variation };
        dzone.classList.add('selected');
        showHsToolbar(dzone);
      });
    } else {
      dzone.style.cursor = 'pointer';
      dzone.addEventListener('click', e => {
        e.stopPropagation();
        if (UI.hsActiveZone?.dzone === dzone) { hideHsToolbar(); return; }
        if (UI.hsActiveZone) UI.hsActiveZone.dzone.classList.remove('selected');
        UI.hsActiveZone = { dzone, variation };
        dzone.classList.add('selected');
        // If the variation already has sponsor text, go straight to editing it.
        if (activeVar?.sponsorText?.text) {
          hideHsToolbar();
          window.startEditVar?.(activeVar.id);
          window.openHsVarMenu?.('sponsor');
        } else {
          showHsToolbar(dzone, true);
        }
      });
    }
  }

  dzone.addEventListener('dragover',  e => { e.preventDefault(); dzone.classList.add('drag-over'); });
  dzone.addEventListener('dragleave', e => { if (!dzone.contains(e.relatedTarget)) dzone.classList.remove('drag-over'); });
  dzone.addEventListener('drop', e => {
    e.preventDefault();
    dzone.classList.remove('drag-over');
    if (!UI.hsDragLogoId) return;
    const logo = HS.library.find(l => l.id === UI.hsDragLogoId);
    if (!logo) return;
    UI.hsDragLogoId = null;
    variation.logoId  = logo.id;
    variation.logoSrc = logo.src;
    delete variation.logoSrcTight; delete variation.sponsorText;
    if (!variation.logoData) variation.logoData = { x: 50, y: 50, w: 90 };
    renderVariationPreview();
    prepareLogo(variation, logo.src).then(() => {
      applyFillToVariation(variation);
      const thumb = document.getElementById('hsvt-' + activeVar?.id);
      if (thumb) renderHoleSignInto(thumb, getEffectiveState(activeVar), getEffectiveVariation(activeVar));
      renderVariationPreview();
    }).catch(() => {});
  });

  preview.appendChild(dzone);

  if (isEditingActive) {
    wireElementDrag(preview, 'logos');
    paintTplSlotOverlays(preview, effState);
    wireCanvasTextEditing(preview);
    wireQuickAddHover(preview);
  }
}
