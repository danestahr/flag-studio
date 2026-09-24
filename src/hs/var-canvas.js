import { HS, UI, findLogo } from './state.js';
import { HS_H, HS_W } from '../hole-sign-data.js';
import { getEffectiveState, getEffectiveVariation } from './state.js';
import { getLogoZone, getTemplateLogoSlots, renderHoleSignInto } from '../hole-sign-render.js';
import { hideHsToolbar, addLogoLayer } from './logo-utils.js';
import { deselectTlSlots } from './template-logos.js';
import { stripSlotImages, paintTplSlotOverlays, paintTextLayerOverlays, rescaleTextOverlayFonts } from './design.js';
import { createImageBox, enterCropEditOn, refreshImageBoxClips, refreshTextLayerClips, refreshTlSlotClips } from '../image-box.js';
import { wireBannerHeightHandles, wireBannerSpacingHandles, wireCanvasTextEditing, wireElementDrag } from './banner.js';
import { removeActiveHsLogo, showHsToolbar, hideHsToolbarPanel, reselectAfterRerender } from './var-toolbar.js';
import { renderVarList, buildLibStrip } from './variations.js';
import { refreshHsVarSectionReset } from './var-editor.js';
import { uploadLogo } from '../supabase.js';
import { renderCanvasPanel } from '../canvas-panel.js';
import { commitActiveCanvasEdit } from '../dom-utils.js';

// ── Canvas sizing & zoom ───────────────────────────────────

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
    onApply: () => {
      const preview = document.getElementById('hsSignPreview');
      if (preview) { rescaleTextOverlayFonts(preview); refreshImageBoxClips(preview); refreshTextLayerClips(preview); refreshTlSlotClips(preview); }
    },
    // Global (project-wide, not scoped to whichever variation is active) —
    // the right-hand "Variations" list is where a specific variation's own
    // request lives now (its "View edits" link, see variations.js), so this
    // banner is just the project-wide entry point into that same sub-view.
    // Content/visibility is driven by updateHsEditRequestsBanner in
    // variations.js, not here — this only owns the markup shell.
    noteHtml: `
    <div id="hsVarEditNote" class="var-edit-note" style="display:none">
      <div class="var-edit-note-row">
        <div class="var-edit-note-body">
          <span class="var-edit-note-label">Edit requested:</span>
          <span id="hsVarEditNoteText"></span>
        </div>
        <button class="var-edit-viewall-btn" onclick="openHsEditRequests()">View all edits</button>
      </div>
    </div>`,
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
    onApply: () => {
      const preview = document.getElementById('hsStep1Preview');
      if (preview) { rescaleTextOverlayFonts(preview); refreshImageBoxClips(preview); refreshTextLayerClips(preview); refreshTlSlotClips(preview); }
    },
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

  // No sponsor logos yet and nothing selected to preview — prompt for a
  // logo upload instead of rendering the bare, un-personalized template.
  // Uploading (via #hsLogoFile, wired by renderLogoTray in buildLibStrip)
  // already auto-creates a variation per logo and selects it
  // (addVariationForLogo in variations.js), so the next renderVariationPreview()
  // call naturally replaces this prompt with the new variation.
  if (!activeVar && !HS.library.length) {
    preview.innerHTML = `
      <div class="hs-sign-empty">
        <span class="hs-sign-empty-icon"><i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i></span>
        <div class="hs-sign-empty-title">Upload sponsor logos to get started</div>
        <div class="hs-sign-empty-sub">Each logo becomes its own hole sign variation, ready to edit.</div>
        <button type="button" class="btn primary" onclick="document.getElementById('hsLogoFile').click()">Upload logos</button>
      </div>`;
    return;
  }

  const effState = getEffectiveState(activeVar);
  // UI.hsFullEditorOpen (not just HS.editingVarId matching) distinguishes an
  // explicit pencil-editor session from a quick-edit draft in progress (see
  // beginQuickEdit in var-editor.js) — both set HS.editingVarId/editingDraft
  // to the same variation, but only the former should unlock drag/resize.
  const isEditingActive = HS.editingVarId && HS.editingVarId === HS.activeVarId && UI.hsFullEditorOpen;
  // Quick-edit mode: a variation is selected but not (yet) in the full pencil
  // editor — template logo slots / background / text bands are still
  // click-to-edit, just with positions locked (no drag/resize).
  const showQuickEdit = !isEditingActive && !!activeVar;

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
    : (activeVar && !activeVar.logos?.length ? getEffectiveVariation(activeVar) : null);
  // Only hide text layers (and top/bottom band text) from the SVG when editing
  // or quick-editing (they become interactive DOM overlays). When just
  // viewing, let them render in the SVG directly.
  const showOverlays = isEditingActive || showQuickEdit;
  const hideTextLayers = showOverlays ? (effState.textLayers || []).map(l => l.id) : [];
  const hideText = showOverlays ? ['top', 'bottom'] : [];
  const bgState = { ...(showOverlays ? stripSlotImages(effState) : effState), hideTextLayers, hideText };
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

    // Same problem one layer down: the background color and image are two
    // separate paint steps within makeHoleSignSvg's own output (color always
    // absolute-back, image on top of it), but here they're baked into the
    // same bgSvgEl — a single DOM element can't let a *third* thing (a
    // variation logo's .dz-logo-ghost, sent "Below Background") slot in
    // between them. Pull ONLY the color group out into its own overlay
    // (.dz-bg-color-layer, z-index:-3) and the image group into its own
    // overlay above it (.dz-bg-image-overlay, z-index:-1, straddling the
    // ghost at z-index:-2) — leaving bgSvgEl itself (still holding every
    // other non-frame piece: free text layers, docked banner captions,
    // sponsor fallback text) at its normal stacking position, so an uploaded
    // background image doesn't paint over it the way dragging the whole
    // bgSvgEl down with the color layer used to.
    const colorGroup = bgSvgEl.querySelector('.hs-bg-color');
    if (colorGroup) {
      const colorSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      colorSvg.setAttribute('viewBox', `0 0 ${HS_W} ${HS_H}`);
      colorSvg.setAttribute('class', 'dz-bg-color-layer');
      colorSvg.appendChild(colorGroup);
      preview.insertBefore(colorSvg, bgSvgEl);
    }
    const imageGroup = bgSvgEl.querySelector('.hs-bg-image');
    if (imageGroup) {
      const imageSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      imageSvg.setAttribute('viewBox', `0 0 ${HS_W} ${HS_H}`);
      imageSvg.setAttribute('class', 'dz-bg-image-overlay');
      imageSvg.appendChild(imageGroup);
      preview.appendChild(imageSvg);
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
      // Same handoff banner.js's own band-to-band clicks perform explicitly
      // (see startEdit/selectZone there) — this zone isn't focusable, so a
      // native click here never blurs an in-progress text-band edit on its
      // own, leaving HS.editingDraft dangling (and getEffectiveState reading
      // its now-stale content) until something else happens to commit it.
      commitActiveCanvasEdit(abZone);
      if (UI.hsActiveZone?.dzone === abZone) { hideHsToolbar(); UI.hsActiveZone = null; return; }
      // Store the real persisted variation, not the getEffectiveVariation()
      // copy — toolbar actions (e.g. aboveFrame toggle) mutate this object
      // in place, and mutating the copy's primitive fields would silently
      // never reach HS.variations.
      UI.hsActiveZone = { dzone: abZone, variation: activeVar };
      showHsToolbar(abZone);
    });
    preview.appendChild(abZone);
    if (isEditingActive) {
      paintTplSlotOverlays(preview, effState);
      paintTextLayerOverlays(preview, effState);
      wireCanvasTextEditing(preview);
      wireBannerHeightHandles(preview);
      wireBannerSpacingHandles(preview);
    } else if (showQuickEdit) {
      // Same coupling as the non-artboard branch below: showOverlays (above)
      // already stripped the frame's slot images from the SVG in favor of a
      // DOM overlay — that overlay has to actually get painted here, or an
      // artboard variation's template logo/text simply vanishes while just
      // viewing it (not editing) on the canvas.
      paintTplSlotOverlays(preview, effState, { locked: true, variation: activeVar });
      paintTextLayerOverlays(preview, effState, { locked: true, variation: activeVar });
      wireCanvasTextEditing(preview, { locked: true });
    }
    refreshHsVarSectionReset();
    return;
  }
  if (!variation) return;
  const lz = getLogoZone(effState, effState.templateStyle);
  const dzone = document.createElement('div');
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  dzone.style.cssText = `position:absolute;left:${pct(lz.x, HS_W)};top:${pct(lz.y, HS_H)};width:${pct(lz.w, HS_W)};height:${pct(lz.h, HS_H)};`;

  const selectLogoLayer = (dz, wrap, layerId) => {
    if (UI.hsActiveZone) {
      UI.hsActiveZone.dzone.classList.remove('selected');
      UI.hsActiveZone.wrap?.classList.remove('selected');
    }
    // Store the real persisted variation — see comment above for why.
    UI.hsActiveZone = { dzone: dz, wrap, variation: activeVar, layerId };
    dz.classList.add('selected');
    // The purple "selected" outline lives on the image box itself
    // (.dz-logo-wrap.selected) — dzone's own .selected only tints its
    // background, so without this the wrap never shows anything but its
    // blue :hover outline, i.e. it looked permanently "unselected".
    wrap?.classList.add('selected');
  };

  if (isFullGraphic) {
    // Full-graphic: image fills the canvas via the SVG renderer; dzone is just an
    // invisible interaction surface for drop and toolbar (no handles or guides).
    // Only one logo is ever addressable here (see addLogoLayer's isFullGraphic
    // branch in logo-utils.js) — there's no meaningful way to select among
    // several full-bleed images stacked identically over the whole canvas.
    const soleLayer = variation.logos?.[0] || null;
    dzone.className = 'dzone dzone-full-graphic' + (soleLayer ? ' has-logo' : '');
    dzone.style.cursor = 'pointer';
    dzone.addEventListener('click', e => {
      e.stopPropagation();
      // See the matching comment on abZone's click handler above.
      commitActiveCanvasEdit(dzone);
      if (UI.hsActiveZone?.dzone === dzone) { hideHsToolbar(); return; }
      selectLogoLayer(dzone, null, soleLayer?.id ?? null);
      showHsToolbar(dzone, !soleLayer);
    });
  } else {
    const logos = variation.logos || [];
    dzone.className = 'dzone' + (logos.length ? ' has-logo' : ' hs-logo-placeholder');
    dzone.style.cursor = 'pointer';

    // Clicking empty space inside the zone (a click on a placed logo's own
    // .dz-logo-wrap stops propagation before it reaches here — see
    // createImageBox) no longer opens the add/replace picker — that read as
    // an accidental "add a new image" prompt on a stray tap. Sponsor text
    // (shown in this zone whenever it has no logo) is reachable this way
    // whether or not it's already set — same "click the element on canvas to
    // edit/add it" affordance as everything else, now that the sidebar menu
    // no longer carries its own dedicated row. Adding a logo still goes only
    // through an explicit action (drag from the library strip).
    dzone.addEventListener('click', e => {
      e.stopPropagation();
      // See the matching comment on abZone's click handler above.
      commitActiveCanvasEdit(dzone);
      if (UI.hsActiveZone?.dzone === dzone && !UI.hsActiveZone.layerId) { hideHsToolbar(); return; }
      if (!logos.length) {
        selectLogoLayer(dzone, null, null);
        hideHsToolbar();
        window.startEditVar?.(activeVar.id);
        window.openHsVarMenu?.('sponsor');
      }
    });

    logos.forEach(layer => {
      if (layer.loading) {
        const lwrap = document.createElement('div');
        lwrap.className = 'dz-logo-wrap dz-logo-wrap-loading';
        lwrap.style.cssText = `left:${layer.x}%;top:${layer.y}%;width:${layer.w}%;`;
        lwrap.innerHTML = '<div class="logo-processing-spinner"></div>';
        dzone.appendChild(lwrap);
        return;
      }
      const displaySrc = layer.logoSrcTight || layer.logoSrc;
      let wrap;
      wrap = createImageBox(dzone, preview, layer, {
        src: displaySrc,
        alt: variation.name,
        aboveFrame: layer.aboveFrame,
        belowBackground: layer.belowBackground,
        cropped: !!layer.cropped,
        zoneSignW: lz.w,
        zoneSignH: lz.h,
        onCropChange: () => renderVarList(),
        // Double-clicking an image that isn't cropped yet — enable it, then
        // rebuild the canvas and resume straight into crop-edit mode on the
        // fresh box (createImageBox can't switch a live box's visual from a
        // plain <img> to the cropbox one, so this has to be a full rebuild).
        onEnableCrop: () => {
          layer.cropped = true;
          renderVariationPreview();
          renderVarList();
          const freshWrap = document.getElementById('hsSignPreview')?.querySelector(`.dz-logo-wrap[data-layer-id="${layer.id}"]`);
          enterCropEditOn(freshWrap);
        },
        // Duck the toolbar out of the way while dragging/resizing, and bring
        // it back — freshly repositioned against the box's final size/place —
        // once released. Same hide-then-reappear pattern as the text-layer
        // toolbar in hs/design.js, rather than leaving it visibly stale over
        // a box that's moved/resized out from under it.
        onStart: () => hideHsToolbarPanel(),
        onCommit: () => { renderVarList(); if (UI.hsActiveZone?.layerId === layer.id) showHsToolbar(dzone); },
        onClick: () => {
          if (UI.hsActiveZone?.layerId === layer.id) { hideHsToolbar(); return; }
          // Selecting this image and selecting a text layer/template-logo
          // slot are mutually exclusive on this canvas — same reasoning as
          // the matching drop in design.js's template-logo onClick.
          if (UI.activeTextLayerId) {
            UI.activeTextLayerId = null;
            document.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.remove('selected'));
            window.closeTextLayerToolbar?.();
          }
          deselectTlSlots();
          selectLogoLayer(dzone, wrap, layer.id);
          showHsToolbar(dzone);
        },
        // Hover shortcut — jump straight to removal a plain click would
        // reach, without the intermediate select-then-click-Remove step.
        // Swap/reorder now live only in the zone toolbar, not on the image.
        onRemove: () => { selectLogoLayer(dzone, wrap, layer.id); removeActiveHsLogo(); },
      });
      wrap.dataset.layerId = layer.id; // looked up by reselectAfterRerender in var-toolbar.js
      dzone.appendChild(wrap);
    });
  }

  const refreshThumbAndPreview = () => {
    const thumb = document.getElementById('hsvt-' + activeVar?.id);
    if (thumb) renderHoleSignInto(thumb, getEffectiveState(activeVar), getEffectiveVariation(activeVar));
    renderVariationPreview();
  };

  // Dragging a logo from the library onto the canvas always ADDS a new,
  // independent layer — see addLogoLayer in logo-utils.js. Once it's placed
  // (the promise resolves), immediately select it and pop the zone toolbar
  // open — same as clicking it — so front/back, replace, remove-bg etc. are
  // right there instead of requiring a separate click after the drop.
  const dropLogo = logo => {
    const p = addLogoLayer(activeVar, logo, { isFullGraphic });
    renderVariationPreview(); // shows the pushed layer's loading spinner
    p.then(layer => {
      refreshThumbAndPreview();
      reselectAfterRerender(activeVar, layer.id);
    }).catch(() => renderVariationPreview());
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
        dropLogo(logo);
      } catch (err) { console.error('Logo upload failed', err); }
      return;
    }

    if (!UI.hsDragLogoId) return;
    const logo = findLogo(UI.hsDragLogoId);
    if (!logo) return;
    UI.hsDragLogoId = null;
    dropLogo(logo);
  });

  if (isEditingActive) {
    // Full editor: template-logo slots are themselves interactive
    // (createImageBox, `.dz-logo-wrap[data-tl-idx]`) and meant to sit above
    // variation content regardless of DOM order — see style.css's explicit
    // z-index:4 on that selector — so append order here doesn't matter; keep
    // dzone first for readability.
    preview.appendChild(dzone);
    wireElementDrag(preview, 'logos');
    paintTplSlotOverlays(preview, effState);
    paintTextLayerOverlays(preview, effState);
    wireCanvasTextEditing(preview);
    wireBannerHeightHandles(preview);
    wireBannerSpacingHandles(preview);
  } else if (showQuickEdit) {
    // Quick-edit: template logo slots / text bands / free text layers are
    // still click-to-edit (swap image, edit text), but no drag/resize — no
    // wireElementDrag, no banner height/spacing handles, positions stay put.
    // These locked overlays carry no z-index of their own (plain DOM order
    // decides who's on top), so appending dzone AFTER them — instead of
    // before, as the interactive branch above does — keeps the *sponsor*
    // logo/text reachable even when a template logo slot is sized large
    // enough to otherwise sit on top of and fully cover it. This page's
    // whole purpose is assigning per-variation content, so that should win a
    // click over the secondary, click-to-quick-swap template logo — which
    // stays reachable in any region the sponsor content doesn't cover.
    paintTplSlotOverlays(preview, effState, { locked: true, variation: activeVar });
    paintTextLayerOverlays(preview, effState, { locked: true, variation: activeVar });
    wireCanvasTextEditing(preview, { locked: true });
    preview.appendChild(dzone);
  } else {
    preview.appendChild(dzone);
  }
  refreshHsVarSectionReset();
}

window._hsRenderVariationPreview = renderVariationPreview;
