import { HS, UI, HS_LAYER_ORDER, HS_LAYER_LABELS, getVariationLayer, setVariationLayer } from './state.js';
import { fillHsLogo, hideHsToolbar, prepareLogo, applyFillToVariation, addLogoLayer, activeLogoLayer, removeBgFromLogo, detectArtworkBounds, cropSvgToArtwork, hasSiblingInDirection, swapLogoWithSibling, moveLogoToEdge } from './logo-utils.js';
import { uploadLogo } from '../supabase.js';
import { buildLibStrip, renderVarList } from './variations.js';
import { renderVariationPreview } from './var-canvas.js';
import { logoThumbHtml } from '../media-utils.js';
import { positionFloatingToolbar } from '../dom-utils.js';

// ── Zone toolbar ───────────────────────────────────────────

// The layer-order (below-bg/below-frame/above-frame) toggle applies to
// whatever's actually selected: one specific logo layer, or — when a
// variation's zone is selected with no particular layer (sponsor text, or an
// empty zone) — the variation's own sponsorText tier (sponsorText has no
// per-item position array of its own, unlike logos).
function layerOrderTarget() {
  return activeLogoLayer() || UI.hsActiveZone?.variation || null;
}

export function removeActiveHsLogo() {
  const z = UI.hsActiveZone;
  if (!z) return;
  const v = z.variation;
  if (z.layerId) {
    // Remove only the selected layer — other logos on this variation stay.
    v.logos = (v.logos || []).filter(l => l.id !== z.layerId);
  } else {
    v.logos = [];
    delete v.sponsorText; delete v.artboardSrc;
  }
  hideHsToolbar();
  renderVarList();
  renderVariationPreview();
}

// renderVariationPreview() tears down and rebuilds the whole preview DOM
// (including .dzone/.dz-logo-wrap) on every call, so UI.hsActiveZone's
// references go stale immediately after — re-showing the toolbar against
// them would position it against a detached, zero-sized rect (effectively
// making it vanish). Re-acquire the freshly rebuilt dzone/wrap for the same
// variation+layer and keep it selected/toolbar-visible across the re-render.
export function reselectAfterRerender(v, layerId) {
  const dzone = document.querySelector('#hsSignPreview .dzone');
  if (!dzone) return;
  const wrap = layerId
    ? dzone.querySelector(`.dz-logo-wrap[data-layer-id="${layerId}"]`)
    : null;
  dzone.classList.add('selected');
  wrap?.classList.add('selected');
  UI.hsActiveZone = { dzone, wrap, variation: v, layerId };
  showHsToolbar(dzone);
}

// Delete/Backspace removes the selected logo, unless the user is typing in a
// text field or editing a text layer (which has its own keydown handling).
document.addEventListener('keydown', e => {
  if (!UI.hsActiveZone) return;
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (document.activeElement?.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  removeActiveHsLogo();
});

export function ensureHsToolbar() {
  if (document.getElementById('hsZoneToolbar')) return;
  const t = document.createElement('div');
  t.id = 'hsZoneToolbar';
  t.className = 'dz-toolbar';
  t.innerHTML = `
    <button class="dz-tb-btn" id="hsTbFill" title="Fill zone"><i class="fa-solid fa-expand"></i></button>
    <div class="dz-tb-sep" id="hsTbFillSep"></div>
    <button class="dz-tb-btn" id="hsTbRemoveBg" title="Remove Background"><i class="fa-solid fa-wand-magic-sparkles"></i> Remove Background</button>
    <div class="dz-tb-sep" id="hsTbRemoveBgSep"></div>
    <button class="dz-tb-btn" id="hsTbLayerToBack" title="Move to back"><i class="fa-solid fa-arrows-down-to-line"></i></button>
    <button class="dz-tb-btn" id="hsTbLayerDown" title="Send backward"><i class="fa-solid fa-arrow-down"></i></button>
    <button class="dz-tb-btn" id="hsTbLayerUp" title="Bring forward"><i class="fa-solid fa-arrow-up"></i></button>
    <button class="dz-tb-btn" id="hsTbLayerToFront" title="Move to front"><i class="fa-solid fa-arrows-up-to-line"></i></button>
    <div class="dz-tb-sep" id="hsTbFrameSep"></div>
    <div style="position:relative">
      <button class="dz-tb-btn" id="hsTbReplace"><i class="fa-solid fa-arrows-rotate"></i> Replace ▾</button>
      <div class="dz-lib-picker" id="hsLibPicker" style="display:none"></div>
    </div>
    <div class="dz-tb-sep" id="hsTbSep"></div>
    <button class="dz-tb-btn" id="hsTbRemove" title="Remove"><i class="fa-solid fa-trash"></i></button>
    <input type="file" id="hsReplaceFile" accept="image/*,.pdf,.ai,.eps" style="display:none">
    <input type="file" id="hsArtboardFile" accept="image/*,.pdf,.ai,.eps" style="display:none">`;
  document.body.appendChild(t);

  document.getElementById('hsTbFill').addEventListener('click', fillHsLogo);

  document.getElementById('hsTbRemoveBg').addEventListener('click', async () => {
    const v = UI.hsActiveZone?.variation;
    const layer = activeLogoLayer();
    if (!v || !layer) return;
    const btn = document.getElementById('hsTbRemoveBg');
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Removing…';
    btn.disabled = true;
    // Spinner overlay on the placed logo (not the whole zone) while processing
    const logoWrap = UI.hsActiveZone?.wrap || UI.hsActiveZone?.dzone;
    const spinner = document.createElement('div');
    spinner.className = 'logo-processing-spinner';
    logoWrap?.appendChild(spinner);
    try {
      const oldId = layer.logoId;
      const logo = HS.library.find(l => l.id === oldId) || { src: layer.logoSrc, name: 'logo.png' };
      const newLogo = await removeBgFromLogo(logo, s => { btn.innerHTML = s === 'uploading' ? '<i class="fa-solid fa-arrow-up-from-bracket"></i> Uploading…' : '<i class="fa-solid fa-spinner fa-spin"></i> Removing…'; });
      // Replace in-place — no new library entry
      const origIdx = HS.library.findIndex(l => l.id === oldId);
      if (origIdx >= 0) HS.library.splice(origIdx, 1, newLogo);
      else HS.library.push(newLogo);
      HS.variations.forEach(vv => {
        (vv.logos || []).forEach(l => {
          if (l.logoId === oldId) {
            l.logoId = newLogo.id;
            l.logoSrc = newLogo.src;
            delete l.logoSrcTight; delete l.logoAspect; delete l.logoArtworkBounds;
          }
        });
      });
      // Shrink bounding box to actual pixel extents
      const bounds = await detectArtworkBounds(newLogo.src).catch(() => null);
      if (bounds) {
        const tight = await cropSvgToArtwork(newLogo.src, bounds).catch(() => null);
        if (tight) { layer.logoSrcTight = tight.url; layer.logoAspect = tight.aspect; layer.logoArtworkBounds = bounds; }
      }
      await prepareLogo(layer, newLogo.src);
      applyFillToVariation(v, layer);
      buildLibStrip();
      renderVarList();
      renderVariationPreview();
    } catch (err) { console.error('BG removal failed', err); }
    spinner.remove();
    btn.innerHTML = origHTML;
    btn.disabled = false;
    hideHsToolbar();
  });

  // Up/Down first try to swap with a same-tier sibling logo (see
  // swapLogoWithSibling/hasSiblingInDirection in logo-utils.js — multiple
  // logos on one variation can share a tier, and paint order within a tier is
  // v.logos array order) before falling through to crossing into the next/
  // previous global tier. To Front/To Back always jump straight to the
  // extreme tier *and* move the logo to the absolute edge of v.logos (via
  // moveLogoToEdge), so they're unambiguous even with siblings. None of this
  // sibling logic applies to the variation-level sponsor-text target (no
  // array of its own to reorder within) — `target !== v` gates it.
  document.getElementById('hsTbLayerToBack').addEventListener('click', () => {
    const target = layerOrderTarget();
    if (!target) return;
    const v = UI.hsActiveZone.variation;
    const layerId = UI.hsActiveZone.layerId;
    if (target !== v) moveLogoToEdge(v, target, 'back');
    setVariationLayer(target, HS_LAYER_ORDER[0]);
    renderVarList();
    renderVariationPreview();
    reselectAfterRerender(v, layerId);
  });

  document.getElementById('hsTbLayerToFront').addEventListener('click', () => {
    const target = layerOrderTarget();
    if (!target) return;
    const v = UI.hsActiveZone.variation;
    const layerId = UI.hsActiveZone.layerId;
    if (target !== v) moveLogoToEdge(v, target, 'front');
    setVariationLayer(target, HS_LAYER_ORDER[HS_LAYER_ORDER.length - 1]);
    renderVarList();
    renderVariationPreview();
    reselectAfterRerender(v, layerId);
  });

  document.getElementById('hsTbLayerUp').addEventListener('click', () => {
    const target = layerOrderTarget();
    if (!target) return;
    const v = UI.hsActiveZone.variation;
    const layerId = UI.hsActiveZone.layerId;
    if (target === v || !swapLogoWithSibling(v, target, 1)) {
      const idx = HS_LAYER_ORDER.indexOf(getVariationLayer(target));
      if (idx >= HS_LAYER_ORDER.length - 1) return;
      setVariationLayer(target, HS_LAYER_ORDER[idx + 1]);
    }
    renderVarList();
    renderVariationPreview();
    reselectAfterRerender(v, layerId);
  });

  document.getElementById('hsTbLayerDown').addEventListener('click', () => {
    const target = layerOrderTarget();
    if (!target) return;
    const v = UI.hsActiveZone.variation;
    const layerId = UI.hsActiveZone.layerId;
    if (target === v || !swapLogoWithSibling(v, target, -1)) {
      const idx = HS_LAYER_ORDER.indexOf(getVariationLayer(target));
      if (idx <= 0) return;
      setVariationLayer(target, HS_LAYER_ORDER[idx - 1]);
    }
    renderVarList();
    renderVariationPreview();
    reselectAfterRerender(v, layerId);
  });

  document.getElementById('hsTbRemove').addEventListener('click', removeActiveHsLogo);

  document.getElementById('hsTbReplace').addEventListener('click', e => {
    e.stopPropagation();
    const picker = document.getElementById('hsLibPicker');
    const open = picker.style.display !== 'none';
    picker.style.display = open ? 'none' : 'grid';
    if (!open) renderHsLibPicker();
  });

  document.getElementById('hsReplaceFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !UI.hsActiveZone) return;
    try {
      const logo = await uploadLogo(HS.projectId, file);
      HS.library.push(logo);
      buildLibStrip();
      const v = UI.hsActiveZone.variation;
      const layer = activeLogoLayer();
      hideHsToolbar();
      if (layer) {
        // A specific logo layer is selected — replace just that one in place.
        delete v.sponsorText;
        layer.logoId = logo.id;
        layer.logoSrc = logo.src;
        delete layer.logoSrcTight;
        renderVarList();
        renderVariationPreview();
        prepareLogo(layer, logo.src).then(() => {
          applyFillToVariation(v, layer);
          renderVarList();
          renderVariationPreview();
        }).catch(() => {});
      } else {
        // Nothing selected (empty zone, or sponsor text active) — add a new layer.
        const p = addLogoLayer(v, logo);
        renderVarList();
        renderVariationPreview();
        p.then(() => { renderVarList(); renderVariationPreview(); }).catch(() => {});
      }
    } catch (err) { console.error('Upload failed', err); }
  });

  document.getElementById('hsArtboardFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !UI.hsActiveZone) return;
    try {
      const logo = await uploadLogo(HS.projectId, file);
      HS.library.push(logo);
      const v = UI.hsActiveZone.variation;
      v.artboardSrc = logo.src;
      // Clear any logo/text content — artboard replaces it
      v.logos = [];
      delete v.sponsorText;
      hideHsToolbar();
      renderVarList();
      renderVariationPreview();
    } catch (err) { console.error('Artboard upload failed', err); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#hsZoneToolbar') && !e.target.closest('.dz-logo-wrap') && !e.target.closest('.dzone')) {
      hideHsToolbar();
    }
  });
}

export function renderHsLibPicker() {
  const picker = document.getElementById('hsLibPicker');
  if (!picker || !UI.hsActiveZone) return;
  const selectedLayer = activeLogoLayer();
  const libHtml = HS.library.length
    ? HS.library.map(l => `
        <div class="dz-lp-item${selectedLayer?.logoId === l.id ? ' active' : ''}" data-lid="${l.id}" title="${l.name}">
          ${logoThumbHtml(l.src, l.name)}
        </div>`).join('')
    : '';
  picker.innerHTML = `
    ${libHtml}
    <div class="dz-lp-upload dz-lp-action" id="hsLpUpload">+ Upload image</div>
    <div class="dz-lp-upload dz-lp-action" id="hsLpText">+ Type text</div>
    <div class="dz-lp-upload dz-lp-action dz-lp-artboard" id="hsLpArtboard">+ Upload full design</div>`;

  picker.querySelectorAll('.dz-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      const logo = HS.library.find(l => l.id === el.dataset.lid);
      if (!logo || !UI.hsActiveZone) return;
      const v = UI.hsActiveZone.variation;
      const layer = activeLogoLayer();
      hideHsToolbar();
      if (layer) {
        // A specific logo layer is selected — replace just that one in place.
        delete v.sponsorText;
        layer.logoId = logo.id;
        layer.logoSrc = logo.src;
        delete layer.logoSrcTight;
        renderVarList();
        renderVariationPreview();
        prepareLogo(layer, logo.src).then(() => {
          applyFillToVariation(v, layer);
          renderVarList();
          renderVariationPreview();
        }).catch(() => {});
      } else {
        // Nothing selected (empty zone, or sponsor text active) — add a new layer.
        const p = addLogoLayer(v, logo);
        renderVarList();
        renderVariationPreview();
        p.then(() => { renderVarList(); renderVariationPreview(); }).catch(() => {});
      }
    });
  });

  picker.querySelector('#hsLpUpload')?.addEventListener('click', () => {
    document.getElementById('hsReplaceFile').click();
  });

  picker.querySelector('#hsLpArtboard')?.addEventListener('click', () => {
    document.getElementById('hsArtboardFile').click();
  });

  picker.querySelector('#hsLpText')?.addEventListener('click', () => {
    if (!UI.hsActiveZone) return;
    const v = UI.hsActiveZone.variation;
    v.logos = [];
    if (!v.sponsorText || !v.sponsorText.text || !v.sponsorText.text.trim()) {
      v.sponsorText = {
        text: v.name || 'Sponsor name',
        font: HS.topText?.font || 'dm-serif',
        size: 300,
        color: HS.topText?.color || '#111110',
      };
    }
    hideHsToolbar();
    // Open the variation editor directly at the sponsor text section so the
    // user can edit the text immediately without extra clicks.
    window.startEditVar?.(v.id);
    window.openHsVarMenu?.('sponsor');
  });
}

// Hides just the toolbar panel — unlike hideHsToolbar(), it leaves the
// current selection (UI.hsActiveZone, the .selected outline/handles) intact.
// Used to duck the toolbar out of the way for the duration of a drag/resize
// on the selected image, mirroring how the text-layer toolbar disappears
// while its element is being dragged and reappears on release.
export function hideHsToolbarPanel() {
  const tb = document.getElementById('hsZoneToolbar');
  if (tb) tb.style.display = 'none';
}

export function showHsToolbar(dz, openPicker = false) {
  ensureHsToolbar();
  const v = UI.hsActiveZone?.variation;
  const hasLogo = !!activeLogoLayer();
  const hasText = !!(v?.sponsorText?.text && v.sponsorText.text.trim());
  const hasArtboard = !!v?.artboardSrc;
  const hasContent = hasLogo || hasText || hasArtboard;
  document.getElementById('hsTbFill').style.display         = hasLogo ? '' : 'none';
  document.getElementById('hsTbFillSep').style.display      = hasLogo ? '' : 'none';
  document.getElementById('hsTbRemoveBg').style.display     = hasLogo ? '' : 'none';
  document.getElementById('hsTbRemoveBgSep').style.display  = hasLogo ? '' : 'none';
  document.getElementById('hsTbRemove').style.display       = hasContent ? '' : 'none';
  document.getElementById('hsTbSep').style.display          = hasContent ? '' : 'none';
  document.getElementById('hsTbReplace').innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> '
    + (hasLogo ? 'Replace ▾' : hasArtboard ? 'Replace design ▾' : hasText ? 'Change ▾' : 'Add logo or text ▾');

  // The layer controls only affect makeHoleSignSvg's logo/sponsor-text
  // block — not the full-canvas artboard upload, which bypasses it entirely.
  const showFrameToggle = hasLogo || hasText;
  const layerToBackBtn = document.getElementById('hsTbLayerToBack');
  const layerUpBtn = document.getElementById('hsTbLayerUp');
  const layerDownBtn = document.getElementById('hsTbLayerDown');
  const layerToFrontBtn = document.getElementById('hsTbLayerToFront');
  layerToBackBtn.style.display  = showFrameToggle ? '' : 'none';
  layerUpBtn.style.display      = showFrameToggle ? '' : 'none';
  layerDownBtn.style.display    = showFrameToggle ? '' : 'none';
  layerToFrontBtn.style.display = showFrameToggle ? '' : 'none';
  document.getElementById('hsTbFrameSep').style.display = showFrameToggle ? '' : 'none';
  if (showFrameToggle) {
    const target = layerOrderTarget();
    const v = UI.hsActiveZone?.variation;
    const idx = HS_LAYER_ORDER.indexOf(getVariationLayer(target));
    // A specific logo layer (not the variation-level sponsor-text target) can
    // still have somewhere to go even at a boundary tier, if a same-tier
    // sibling logo exists to swap/reorder past — see the sibling-aware click
    // handlers above.
    const isLogo = target !== v;
    const atBottom = idx <= 0;
    const atTop = idx >= HS_LAYER_ORDER.length - 1;
    const list = v?.logos || [];
    const arrIdx = isLogo ? list.indexOf(target) : -1;
    layerDownBtn.disabled = atBottom && !(isLogo && hasSiblingInDirection(v, target, -1));
    layerUpBtn.disabled = atTop && !(isLogo && hasSiblingInDirection(v, target, 1));
    layerToBackBtn.disabled = atBottom && !(isLogo && arrIdx > 0);
    layerToFrontBtn.disabled = atTop && !(isLogo && arrIdx < list.length - 1);
    layerUpBtn.title = !layerUpBtn.disabled
      ? (atTop ? 'Bring forward (past a same-tier logo)' : `Bring forward (${HS_LAYER_LABELS[HS_LAYER_ORDER[idx + 1]]})`)
      : 'Already frontmost';
    layerDownBtn.title = !layerDownBtn.disabled
      ? (atBottom ? 'Send backward (past a same-tier logo)' : `Send backward (${HS_LAYER_LABELS[HS_LAYER_ORDER[idx - 1]]})`)
      : 'Already backmost';
  }

  const picker = document.getElementById('hsLibPicker');
  picker.style.display = openPicker ? 'grid' : 'none';
  if (openPicker) renderHsLibPicker();

  const tb = document.getElementById('hsZoneToolbar');
  tb.style.display = 'flex';
  // Anchor to the actual selected logo image (.dz-logo-wrap), not the whole
  // placement zone — the zone is often much bigger than the logo placed
  // inside it, which would otherwise leave the toolbar floating far from the
  // image it's acting on. Falls back to the zone itself when nothing more
  // specific is selected (empty zone, full-graphic, or artboard upload).
  const anchorEl = UI.hsActiveZone?.wrap || dz;
  const container = anchorEl.closest('.hs-design-preview-col');
  positionFloatingToolbar(tb, anchorEl, container, { gap: 6, toDocument: true });
}
