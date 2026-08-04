import { HS, UI } from './state.js';
import { HS_H, HS_W } from '../hole-sign-data.js';
import { getEffectiveState, getEffectiveVariation } from './state.js';
import { getLogoZone, getTemplateLogoSlots, renderHoleSignInto } from '../hole-sign-render.js';
import { hideHsToolbar, prepareLogo, applyFillToVariation } from './logo-utils.js';
import { stripSlotImages, paintTplSlotOverlays, paintTextLayerOverlays } from './design.js';
import { createImageBox } from '../image-box.js';
import { wireBannerHeightHandles, wireBannerSpacingHandles, wireCanvasTextEditing, wireElementDrag } from './banner.js';
import { removeActiveHsLogo, showHsToolbar } from './var-toolbar.js';
import { renderVarList, buildLibStrip } from './variations.js';
import { uploadLogo } from '../supabase.js';
import { renderCanvasPanel } from '../canvas-panel.js';

// ── Canvas sizing & zoom ───────────────────────────────────

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
    const t = kind === 'top' ? src.topText : kind === 'bottom' ? src.bottomText : null;
    if (!t) return;
    input.style.fontSize = Math.max(9, Math.round((t.size || 200) * sc)) + 'px';
  });
}

// The Variations-step canvas panel — constructed fresh each time
// renderStep2() rebuilds panel-2's markup (mirrors the old per-render
// wireCanvasZoom() call below); renderCanvasPanel()'s own wiring is
// idempotent per element/id, so re-constructing on every render is safe.
// The Front/Back face toggle it can render is left hidden: hole signs are
// always printed identically front and back, so there's nothing to switch.
let hsVarCanvas = null;

export function initHsVarCanvas(container) {
  hsVarCanvas = renderCanvasPanel(container, {
    panelId: 'hsCanvasPanel',
    scrollId: 'hsCanvasScroll',
    wrapId: 'hsZoomWrap',
    zoomValueId: 'hsZoomValue',
    zoomResetId: 'hsZoomReset',
    aspect: HS_W / HS_H,
    getZoom: () => UI.hsZoom,
    setZoom: v => { UI.hsZoom = v; },
    onApply: () => { if (UI.canvasEdit) rescaleEditorInput('hsSignPreview'); },
    headerName: '—',
    headerNameId: 'hsActiveVarName',
    canvasContentHtml: '<div class="hs-sign-preview" id="hsSignPreview"></div>',
    description: 'Drag logos into zones',
  });
}

export function applyHsZoom(pct) { hsVarCanvas?.apply(pct); }

// Design step-1's canvas panel — same shared component as the Variations
// step above, just with no header/face-toggle (a single master template,
// not a variation) and its own zoom-% state.
let hsStep1Canvas = null;

export function initHsStep1Canvas(container) {
  hsStep1Canvas = renderCanvasPanel(container, {
    panelId: 'hsStep1CanvasPanel',
    scrollId: 'hsStep1Scroll',
    wrapId: 'hsStep1ZoomWrap',
    zoomValueId: 'hsStep1ZoomValue',
    zoomResetId: 'hsStep1ZoomReset',
    aspect: HS_W / HS_H,
    getZoom: () => UI.hsStep1Zoom,
    setZoom: v => { UI.hsStep1Zoom = v; },
    onApply: () => { if (UI.canvasEdit) rescaleEditorInput('hsStep1Preview'); },
    canvasContentHtml: '<div class="hs-sign-thumb" id="hsStep1Preview"></div>',
  });
}

export function applyHsStep1Zoom(pct) { hsStep1Canvas?.apply(pct); }

// ── Variation preview ──────────────────────────────────────

export function renderVariationPreview() {
  hideHsToolbar();
  const preview = document.getElementById('hsSignPreview');
  if (!preview) return;
  preview.innerHTML = '';

  const nameEl = document.getElementById('hsActiveVarName');
  if (nameEl) {
    const activeName = UI.activeDefaultId
      ? HS.defaults.find(d => d.id === UI.activeDefaultId)?.name
      : HS.variations.find(v => v.id === HS.activeVarId)?.name;
    nameEl.textContent = activeName || '—';
  }

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
  // Only hide text layers (and top/bottom band text) from the SVG when editing
  // (they become interactive DOM overlays). When just viewing, let them render
  // in the SVG directly.
  const hideTextLayers = isEditingActive ? (effState.textLayers || []).map(l => l.id) : [];
  const hideText = isEditingActive ? ['top', 'bottom'] : [];
  const bgState = { ...(isEditingActive ? stripSlotImages(effState) : effState), hideTextLayers, hideText };
  renderHoleSignInto(bgSvgDiv, bgState, bgVarForRender);
  const bgSvgEl = bgSvgDiv.querySelector('svg');
  if (bgSvgEl) {
    bgSvgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    preview.appendChild(bgSvgEl);
  }

  // Standard templates place the logo as a DOM overlay (dzone/.dz-logo-wrap
  // below) so it's draggable — that overlay can't participate in the SVG's
  // own paint order, so it always rendered above literally everything baked
  // into bgSvgEl, including the frame (banner/text/template logo slots),
  // which defaults to sitting above content there. Pull the frame back out
  // into its own z-indexed overlay (reusing the same .dz-frame-overlay /
  // .above-frame rules the flag canvas uses) so the DOM logo stacks with it
  // correctly instead of always winning.
  if (!isFullGraphic && bgSvgEl) {
    const frameGroup = bgSvgEl.querySelector('.hs-frame');
    if (frameGroup) {
      const frameSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      frameSvg.setAttribute('viewBox', `0 0 ${HS_W} ${HS_H}`);
      frameSvg.setAttribute('class', 'dz-frame-overlay');
      frameSvg.appendChild(frameGroup);
      preview.appendChild(frameSvg);
    }
  }

  if (!HS.activeVarId) {
    const ph = document.createElement('div');
    ph.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;color:rgba(255,255,255,.6);';
    ph.textContent = 'Select or upload a logo';
    preview.appendChild(ph);
    return;
  }

  const variation = getEffectiveVariation(activeVar);

  // Full-artboard design: image fills the entire canvas, replaces the logo zone.
  if (activeVar?.artboardSrc) {
    const img = document.createElement('img');
    img.src = activeVar.artboardSrc;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;';
    preview.appendChild(img);
    // Clickable surface so the toolbar can be opened for Replace/Remove
    const abZone = document.createElement('div');
    abZone.style.cssText = 'position:absolute;inset:0;cursor:pointer;';
    abZone.addEventListener('click', e => {
      e.stopPropagation();
      if (UI.hsActiveZone?.dzone === abZone) { hideHsToolbar(); UI.hsActiveZone = null; return; }
      UI.hsActiveZone = { dzone: abZone, variation };
      showHsToolbar(abZone);
    });
    preview.appendChild(abZone);
    if (isEditingActive) {
      paintTplSlotOverlays(preview, effState);
      paintTextLayerOverlays(preview, effState);
      wireCanvasTextEditing(preview);
      wireBannerHeightHandles(preview);
      wireBannerSpacingHandles(preview);
    }
    return;
  }
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
      if (!variation.logoData) variation.logoData = { x: 50, y: 50, w: 90 };
      const displaySrc = variation.logoSrcTight || variation.logoSrc;

      let wrap;
      wrap = createImageBox(dzone, preview, variation.logoData, {
        src: displaySrc,
        alt: variation.name,
        aboveFrame: variation.aboveFrame,
        onCommit: () => renderVarList(),
        onClick: () => {
          if (UI.hsActiveZone?.dzone === dzone) { hideHsToolbar(); return; }
          if (UI.hsActiveZone) {
            UI.hsActiveZone.dzone.classList.remove('selected');
            UI.hsActiveZone.wrap?.classList.remove('selected');
          }
          UI.hsActiveZone = { dzone, wrap, variation };
          dzone.classList.add('selected');
          // The purple "selected" outline lives on the image box itself
          // (.dz-logo-wrap.selected) — dzone's own .selected only tints its
          // background, so without this the wrap never shows anything but
          // its blue :hover outline, i.e. it looked permanently "unselected".
          wrap.classList.add('selected');
          showHsToolbar(dzone);
        },
        // Hover shortcuts — jump straight to the same toolbar+picker (swap) or
        // removal (remove) a plain click would reach, without the
        // intermediate select-then-click-Replace step.
        onSwap: () => {
          if (UI.hsActiveZone) {
            UI.hsActiveZone.dzone.classList.remove('selected');
            UI.hsActiveZone.wrap?.classList.remove('selected');
          }
          UI.hsActiveZone = { dzone, wrap, variation };
          dzone.classList.add('selected');
          wrap.classList.add('selected');
          showHsToolbar(dzone, true);
        },
        onRemove: () => {
          UI.hsActiveZone = { dzone, wrap, variation };
          removeActiveHsLogo();
        },
      });
      dzone.appendChild(wrap);
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

  const placeLogo = logo => {
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
  };

  dzone.addEventListener('dragover',  e => { e.preventDefault(); dzone.classList.add('drag-over'); });
  dzone.addEventListener('dragleave', e => { if (!dzone.contains(e.relatedTarget)) dzone.classList.remove('drag-over'); });
  dzone.addEventListener('drop', async e => {
    e.preventDefault();
    dzone.classList.remove('drag-over');

    const file = e.dataTransfer.files?.[0];
    if (file) {
      try {
        const logo = await uploadLogo(HS.projectId, file);
        HS.library.push(logo);
        buildLibStrip();
        placeLogo(logo);
      } catch (err) { console.error('Logo upload failed', err); }
      return;
    }

    if (!UI.hsDragLogoId) return;
    const logo = HS.library.find(l => l.id === UI.hsDragLogoId);
    if (!logo) return;
    UI.hsDragLogoId = null;
    placeLogo(logo);
  });

  preview.appendChild(dzone);

  if (isEditingActive) {
    wireElementDrag(preview, 'logos');
    paintTplSlotOverlays(preview, effState);
    paintTextLayerOverlays(preview, effState);
    wireCanvasTextEditing(preview);
    wireBannerHeightHandles(preview);
    wireBannerSpacingHandles(preview);
  }
}

window._hsRenderVariationPreview = renderVariationPreview;
