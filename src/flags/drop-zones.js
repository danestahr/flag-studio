import { S, _dragLogoId, setDragLogoId } from '../state.js';
import { getFlag, applyColors, showGsTagVariant, resolveColors, extractFrameElements } from '../render.js';
import { uploadLogo } from '../supabase.js';
import { logoThumbHtml } from '../media-utils.js';
import { createImageBox } from '../image-box.js';

let _onLibraryUpdated = () => {};
let _ensureProject = async () => {};
// Multi-select: _selectedIds holds the ids of the currently selected logo
// layers (shift-click toggles membership); _ctx holds the shared render
// context for whichever zone is active (same for every selected layer, since
// they all live in one zone); _addActive is a separate transient mode for
// the "+ Logo" add-new flow (mutually exclusive with a real selection).
let _selectedIds = new Set();
let _addActive = false;
let _ctx = null;

// Set on every renderDropZones() call to open that zone's Text/Logo choice —
// there's no in-canvas "+" anymore, so callers outside this module (a header
// "+" button) trigger it via triggerAdd() instead.
let _addTrigger = null;

export function initDropZones({ ensureProject, markDirty, onLibraryUpdated } = {}) {
  _ensureProject = ensureProject || _ensureProject;
  _onLibraryUpdated = onLibraryUpdated || _onLibraryUpdated;
}

// Upload a file dropped from outside the app (Finder/Explorer) so it lands in
// the project's logo library, same as a manual library upload.
async function uploadDroppedFile(file) {
  await _ensureProject();
  const logo = await uploadLogo(S.projectId, file);
  S.library.push(logo);
  _onLibraryUpdated();
  return logo;
}

// Full-canvas "you can drop here" overlay while dragging a logo from the
// library strip — the placement zone is just a suggestion now, so the whole
// canvas is a valid drop target, not only the (invisible) zone rectangle.
function showDragOverlay(wrap) {
  if (wrap.querySelector(':scope > .dz-drop-overlay')) return;
  const ov = document.createElement('div');
  ov.className = 'dz-drop-overlay';
  ov.innerHTML = '<div class="dz-drop-overlay-label">Drop Logo</div>';
  wrap.appendChild(ov);
}
function hideDragOverlay(wrap) {
  wrap.querySelector(':scope > .dz-drop-overlay')?.remove();
}

export function triggerAdd(anchorEl) {
  _addTrigger?.(anchorEl);
}

export function hideZoneToolbar() {
  const tb = document.getElementById('dzToolbar');
  if (tb) tb.style.display = 'none';
  const picker = document.getElementById('dzLibPicker');
  if (picker) picker.style.display = 'none';
  _ctx?.dz?.querySelectorAll('.dz-logo-wrap').forEach(w => w.classList.remove('selected'));
  _selectedIds = new Set();
  _addActive = false;
  _ctx = null;
}

// Removes every selected logo (batch, when multi-selected).
function removeActiveLogo() {
  if (_addActive || !_selectedIds.size || !_ctx) return;
  const { logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _ctx;
  for (const id of _selectedIds) {
    const idx = logos.findIndex(l => l.id === id);
    if (idx >= 0) logos.splice(idx, 1);
  }
  hideZoneToolbar();
  renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
  onChange();
}

// Delete/Backspace removes the selected logo(s), unless the user is typing in
// a text field or editing a text layer (which has its own keydown handling).
document.addEventListener('keydown', e => {
  if (_addActive || !_selectedIds.size) return;
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (document.activeElement?.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  removeActiveLogo();
});

function positionToolbar(anchorEl, show = false) {
  const tb = document.getElementById('dzToolbar');
  if (!tb || !anchorEl) return;
  if (show) tb.style.display = 'flex';
  else if (tb.style.display === 'none') return;
  const rect = anchorEl.getBoundingClientRect();
  const tbH = tb.offsetHeight || 36;
  const topAbove = rect.top + window.scrollY - tbH - 8;
  const topBelow = rect.bottom + window.scrollY + 8;
  tb.style.top  = (rect.top > tbH + 20 ? topAbove : topBelow) + 'px';
  tb.style.left = Math.max(8, rect.left + window.scrollX) + 'px';
}

function renderLibPicker() {
  const picker = document.getElementById('dzLibPicker');
  if (!picker || !_ctx) return;
  const { logos } = _ctx;
  const isAdd = _addActive;
  // Replace/highlight only makes sense against a single selected layer —
  // hidden entirely when 2+ are selected (see showToolbar).
  const singleId = !isAdd && _selectedIds.size === 1 ? [..._selectedIds][0] : null;
  const layer = singleId ? logos.find(l => l.id === singleId) : null;

  picker.innerHTML = S.library.map(l => `
      <div class="dz-lp-item${layer?.logoId === l.id ? ' active' : ''}" data-lid="${l.id}" title="${l.name}">
        ${logoThumbHtml(l.src, l.name)}
      </div>`).join('') + `<div class="dz-lp-upload" id="dzLpUpload">+</div>`;

  picker.querySelectorAll('.dz-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      if (!_ctx) return;
      const { logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _ctx;
      const lid = el.dataset.lid;
      if (isAdd) {
        logos.push({ id: 'pl-' + Date.now(), logoId: lid, x: 50, y: 50, w: 75 });
      } else if (singleId) {
        const l = logos.find(l => l.id === singleId);
        if (l) l.logoId = lid;
      }
      hideZoneToolbar();
      renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
      onChange();
    });
  });

  picker.querySelector('#dzLpUpload')?.addEventListener('click', () => {
    document.getElementById('dzReplaceFile').click();
  });
}

function showToolbar(anchorEl, isAdd) {
  ensureToolbar();
  const multi = !isAdd && _selectedIds.size > 1;
  const showOrder = !isAdd && (_ctx?.logos?.length > 1);
  document.getElementById('dzTbRemove').style.display = isAdd ? 'none' : '';
  document.getElementById('dzTbSep').style.display = isAdd ? 'none' : '';
  // Replace and Remove BG only make sense for a single selected image.
  document.getElementById('dzTbRemoveBg').style.display = (isAdd || multi) ? 'none' : '';
  document.getElementById('dzTbRemoveBgSep').style.display = (isAdd || multi) ? 'none' : '';
  document.getElementById('dzTbReplace').style.display = multi ? 'none' : '';
  document.getElementById('dzTbBack').style.display = showOrder ? '' : 'none';
  document.getElementById('dzTbFront').style.display = showOrder ? '' : 'none';
  document.getElementById('dzTbOrderSep').style.display = showOrder ? '' : 'none';
  document.getElementById('dzTbReplace').textContent  = isAdd ? 'Add logo ▾' : 'Replace ▾';

  const frameBtn = document.getElementById('dzTbFrame');
  const frameSep = document.getElementById('dzTbFrameSep');
  frameBtn.style.display = isAdd ? 'none' : '';
  frameSep.style.display = isAdd ? 'none' : '';
  if (!isAdd) {
    const firstLayer = _ctx?.logos?.find(l => _selectedIds.has(l.id));
    frameBtn.innerHTML = firstLayer?.aboveFrame
      ? '<i class="fa-solid fa-arrow-down"></i> Below Template'
      : '<i class="fa-solid fa-arrow-up"></i> Above Template';
  }

  const picker = document.getElementById('dzLibPicker');
  picker.style.display = 'none';
  positionToolbar(anchorEl, true);
}

function ensureToolbar() {
  if (document.getElementById('dzToolbar')) return;
  const t = document.createElement('div');
  t.id = 'dzToolbar';
  t.className = 'dz-toolbar';
  t.innerHTML = `
    <button class="dz-tb-btn" id="dzTbBack" title="Send to back"><i class="fa-solid fa-arrow-down"></i> Back</button>
    <button class="dz-tb-btn" id="dzTbFront" title="Bring to front"><i class="fa-solid fa-arrow-up"></i> Front</button>
    <div class="dz-tb-sep" id="dzTbOrderSep"></div>
    <button class="dz-tb-btn" id="dzTbFrame" title="Move relative to the template's border/tag frame"></button>
    <div class="dz-tb-sep" id="dzTbFrameSep"></div>
    <button class="dz-tb-btn" id="dzTbRemove">Remove</button>
    <div class="dz-tb-sep" id="dzTbSep"></div>
    <button class="dz-tb-btn" id="dzTbRemoveBg" title="Remove background"><i class="fa-solid fa-wand-magic-sparkles"></i> Remove BG</button>
    <div class="dz-tb-sep" id="dzTbRemoveBgSep"></div>
    <div style="position:relative">
      <button class="dz-tb-btn" id="dzTbReplace">Replace ▾</button>
      <div class="dz-lib-picker" id="dzLibPicker" style="display:none"></div>
    </div>
    <input type="file" id="dzReplaceFile" accept="image/*,.pdf,.ai,.eps" style="display:none">`;
  document.body.appendChild(t);

  // Send-to-back/bring-to-front move every selected layer as a block,
  // preserving their relative order, so a multi-selection reorders together.
  document.getElementById('dzTbBack').addEventListener('click', () => {
    if (_addActive || !_selectedIds.size || !_ctx) return;
    const { logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _ctx;
    const selected = logos.filter(l => _selectedIds.has(l.id));
    const rest = logos.filter(l => !_selectedIds.has(l.id));
    logos.length = 0;
    logos.push(...selected, ...rest);
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
    onChange();
  });

  document.getElementById('dzTbFront').addEventListener('click', () => {
    if (_addActive || !_selectedIds.size || !_ctx) return;
    const { logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _ctx;
    const selected = logos.filter(l => _selectedIds.has(l.id));
    const rest = logos.filter(l => !_selectedIds.has(l.id));
    logos.length = 0;
    logos.push(...rest, ...selected);
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
    onChange();
  });

  document.getElementById('dzTbFrame').addEventListener('click', () => {
    if (_addActive || !_selectedIds.size || !_ctx) return;
    const { logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _ctx;
    const firstLayer = logos.find(l => _selectedIds.has(l.id));
    const newVal = !firstLayer?.aboveFrame;
    logos.forEach(l => { if (_selectedIds.has(l.id)) l.aboveFrame = newVal; });
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
    onChange();
  });

  document.getElementById('dzTbRemove').addEventListener('click', removeActiveLogo);

  document.getElementById('dzTbRemoveBg').addEventListener('click', async () => {
    if (_addActive || _selectedIds.size !== 1 || !_ctx) return;
    const layerId = [..._selectedIds][0];
    const { logos, dz, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _ctx;
    const layer = logos.find(l => l.id === layerId);
    const logo = layer && S.library.find(l => l.id === layer.logoId);
    if (!logo) return;
    const btn = document.getElementById('dzTbRemoveBg');
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Removing…';
    const logoWrap = dz.querySelector(`.dz-logo-wrap[data-layer-id="${layerId}"]`) || dz;
    const spinner = document.createElement('div');
    spinner.className = 'logo-processing-spinner';
    logoWrap.appendChild(spinner);
    try {
      const { removeBackground } = await import('@imgly/background-removal');
      btn.innerHTML = '<i class="fa-solid fa-arrow-up-from-bracket"></i> Uploading…';
      const blob = await removeBackground(logo.src);
      const file = new File([blob], logo.name.replace(/\.[^.]+$/, '') + ' (no bg).png', { type: 'image/png' });
      const newLogo = await uploadLogo(S.projectId, file);
      S.library.push(newLogo);
      layer.logoId = newLogo.id;
      spinner.remove();
      hideZoneToolbar();
      _onLibraryUpdated();
      renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
      onChange();
    } catch (err) {
      console.error('Background removal failed', err);
      spinner.remove();
      btn.innerHTML = origHTML;
      btn.disabled = false;
    }
  });

  document.getElementById('dzTbReplace').addEventListener('click', e => {
    e.stopPropagation();
    if (!_addActive && _selectedIds.size !== 1) return;
    const picker = document.getElementById('dzLibPicker');
    const open = picker.style.display !== 'none';
    picker.style.display = open ? 'none' : 'block';
    if (!open) renderLibPicker();
  });

  document.getElementById('dzReplaceFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !_ctx) return;
    const { logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _ctx;
    try {
      const logo = await uploadLogo(S.projectId, file);
      S.library.push(logo);
      if (_addActive) {
        logos.push({ id: 'pl-' + Date.now(), logoId: logo.id, x: 50, y: 50, w: 75 });
      } else if (_selectedIds.size === 1) {
        const l = logos.find(l => l.id === [..._selectedIds][0]);
        if (l) l.logoId = logo.id;
      }
      hideZoneToolbar();
      _onLibraryUpdated();
      renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
      onChange();
    } catch (err) { console.error('Upload failed', err); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#dzToolbar') && !e.target.closest('.dz-logo-wrap') && !e.target.closest('.dzone')) {
      hideZoneToolbar();
    }
  });
}

export function renderDropZones(wrapId, svgId, logos, face = 'front', onChange = () => {}, flagOverride = null, colorsOverride = null, gsTagOpts = null) {
  const flag = flagOverride || getFlag();
  if (!flag) return;
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap._dzReadonly = false;

  wrap.querySelectorAll('.dzone, .dz-badge, .dz-frame-overlay').forEach(d => d.remove());
  const svg = document.getElementById(svgId);
  if (!svg) return;

  const ns = 'http://www.w3.org/2000/svg';
  const [vbW, vbH] = (flag.viewBox || '0 0 7519 4669').split(' ').slice(2).map(Number);
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  if (face === 'back') {
    svg.innerHTML = '';
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', `translate(${vbW},0) scale(-1,1)`);
    g.innerHTML = flag.svgContent;
    svg.appendChild(g);
  } else {
    svg.innerHTML = flag.svgContent;
  }
  const colors = colorsOverride || S.colors;
  applyColors(svg, colors, flag.noColors, flag);

  const gst = gsTagOpts ?? { enabled: S.gsTag, mode: S.gsTagMode };
  if (gst.enabled) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    showGsTagVariant(svg, face, gst.mode, resolveColors(colors, flag)[keyZone]);
  }

  // Relocate the template's frame (border + GS tag) into its own overlay
  // svg, appended after the logo layer, so it defaults to painting above
  // logos here just like it does in the baked export (makeSvg) — see
  // .dz-frame-overlay / .above-frame in style.css for the z-index rule that
  // lets an individual logo opt back above it.
  const frameEls = extractFrameElements(svg);
  // The border zone is drawn full-bleed (it's meant to run past the trim
  // line so a print with no white edge after cutting) — thicker than the
  // grey guide margin itself, so once the border lands in this elevated
  // overlay it paints straight over the guide. Move the guide in after it,
  // same as it already sits topmost in the plain (non-drop-zone) preview.
  const bleedEl = svg.querySelector('[id="Bleed"], [id="bleed"]');
  if (frameEls.length || bleedEl) {
    const frameSvg = document.createElementNS(ns, 'svg');
    frameSvg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
    frameSvg.setAttribute('class', 'dz-frame-overlay');
    // Match the main svg's own fill="none" (set in applyColors) — some
    // templates' relocated content (e.g. a stroke-only accent nested in
    // Bleed) has no fill of its own and relies on inheriting that default;
    // without it here, a plain <svg> falls back to the CSS-initial fill
    // (black), turning an invisible line into a solid shape.
    frameSvg.setAttribute('fill', 'none');
    const holder = document.createElementNS(ns, 'g');
    if (face === 'back') holder.setAttribute('transform', `translate(${vbW},0) scale(-1,1)`);
    frameEls.forEach(el => holder.appendChild(el));
    if (bleedEl) holder.appendChild(bleedEl);
    frameSvg.appendChild(holder);
    wrap.appendChild(frameSvg);
  }

  wrap.style.aspectRatio = vbW + ' / ' + vbH;

  const zone = flag.logoZones[0];
  if (!zone) return;

  const zoneX = face === 'back' ? vbW - zone.x - zone.w : zone.x;
  const dz = document.createElement('div');
  dz.className = 'dzone' + (logos.length ? ' has-logo' : '');
  dz.style.cssText = [
    `left:${(zoneX / vbW) * 100}%;`,
    `top:${(zone.y / vbH) * 100}%;`,
    `width:${(zone.w / vbW) * 100}%;`,
    `height:${(zone.h / vbH) * 100}%;`,
    'overflow:visible;',
  ].join('');

  // Crosshair guides
  const gh = document.createElement('div'); gh.className = 'dz-guide-h'; dz.appendChild(gh);
  const gv = document.createElement('div'); gv.className = 'dz-guide-v'; dz.appendChild(gv);

  // Logo layers
  logos.forEach(layer => {
    const logo = S.library.find(l => l.id === layer.logoId);
    if (!logo) return;

    let logoWrap; // closed over by onClick below; assigned from createImageBox's return
    logoWrap = createImageBox(dz, wrap, layer, {
      src: logo.src,
      alt: logo.name,
      aboveFrame: layer.aboveFrame,
      onStart: () => {
        const tb = document.getElementById('dzToolbar');
        if (tb) tb.style.visibility = 'hidden';
      },
      onCommit: () => {
        const tb = document.getElementById('dzToolbar');
        if (tb) { tb.style.visibility = ''; positionToolbar(logoWrap); }
        onChange();
      },
      onClick: e => {
        if (e.shiftKey) {
          if (_selectedIds.has(layer.id)) _selectedIds.delete(layer.id);
          else _selectedIds.add(layer.id);
        } else {
          _selectedIds = new Set([layer.id]);
        }
        _addActive = false;
        _ctx = { logos, dz, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts };
        dz.querySelectorAll('.dz-logo-wrap').forEach(w => {
          w.classList.toggle('selected', _selectedIds.has(w.dataset.layerId));
        });
        if (!_selectedIds.size) { hideZoneToolbar(); return; }
        showToolbar(logoWrap, false);
        document.getElementById('dzLibPicker').style.display = 'none';
      },
      // Hover shortcuts — select just this one layer and jump straight to the
      // same toolbar+picker (swap) or removal (remove) a plain click would
      // reach, without the intermediate select-then-click-Replace step.
      onSwap: () => {
        _selectedIds = new Set([layer.id]);
        _addActive = false;
        _ctx = { logos, dz, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts };
        dz.querySelectorAll('.dz-logo-wrap').forEach(w => {
          w.classList.toggle('selected', _selectedIds.has(w.dataset.layerId));
        });
        showToolbar(logoWrap, false);
        document.getElementById('dzLibPicker').style.display = 'block';
        renderLibPicker();
      },
      onRemove: () => {
        _selectedIds = new Set([layer.id]);
        _addActive = false;
        _ctx = { logos, dz, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts };
        removeActiveLogo();
      },
    });
    logoWrap.dataset.layerId = layer.id;
    dz.appendChild(logoWrap);
  });

  function openAddPicker(anchorEl) {
    _selectedIds = new Set();
    _addActive = true;
    _ctx = { logos, dz, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts };
    if (!S.library.length) {
      ensureToolbar();
      document.getElementById('dzReplaceFile').click();
      return;
    }
    showToolbar(anchorEl, true);
    const picker = document.getElementById('dzLibPicker');
    picker.style.display = 'block';
    renderLibPicker();
  }

  function closeAddChoiceMenu() {
    document.getElementById('dzAddChoiceMenu')?.remove();
  }

  // "+" offers a Text/Logo choice; Logo re-uses the existing library picker
  // (which itself opens the file browser directly when the library is empty).
  // Triggered from outside the canvas now (see triggerAdd export below), not
  // from an in-canvas button, so the flag itself stays free of add-content UI.
  function openAddChoiceMenu(anchorEl) {
    closeAddChoiceMenu();
    const menu = document.createElement('div');
    menu.id = 'dzAddChoiceMenu';
    menu.className = 'dz-add-choice-menu';
    menu.innerHTML = `
      <button class="var-add-opt" data-choice="text">T+ Text</button>
      <button class="var-add-opt" data-choice="logo">⊕ Logo</button>`;
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    menu.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    menu.style.left = (rect.left + window.scrollX) + 'px';
    menu.querySelector('[data-choice="text"]').addEventListener('click', e => {
      e.stopPropagation();
      closeAddChoiceMenu();
      window.addFlagText?.();
    });
    menu.querySelector('[data-choice="logo"]').addEventListener('click', e => {
      e.stopPropagation();
      closeAddChoiceMenu();
      openAddPicker(anchorEl);
    });
    setTimeout(() => {
      document.addEventListener('click', function onDocClick(ev) {
        if (!menu.contains(ev.target) && ev.target !== anchorEl) {
          closeAddChoiceMenu();
          document.removeEventListener('click', onDocClick);
        }
      });
    }, 0);
  }

  _addTrigger = anchorEl => openAddChoiceMenu(anchorEl);

  // Drop from library strip — wired once per wrap (it persists across
  // re-renders; only dz/svg get torn down) and reads the latest render's
  // context off the wrap itself so the closure never goes stale.
  wrap._dzDropCtx = { logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts };
  if (!wrap._dzDropWired) {
    wrap._dzDropWired = true;
    wrap.addEventListener('dragover', e => {
      if (wrap._dzReadonly) return;
      e.preventDefault(); showDragOverlay(wrap);
    });
    wrap.addEventListener('dragleave', e => {
      if (wrap.contains(e.relatedTarget)) return;
      hideDragOverlay(wrap);
    });
    wrap.addEventListener('drop', async e => {
      if (wrap._dzReadonly) return;
      e.preventDefault();
      hideDragOverlay(wrap);
      const ctx = wrap._dzDropCtx;
      if (!ctx) return;

      const file = e.dataTransfer.files?.[0];
      if (file) {
        try {
          const logo = await uploadDroppedFile(file);
          ctx.logos.push({ id: 'pl-' + Date.now(), logoId: logo.id, x: 50, y: 50, w: 75 });
          renderDropZones(ctx.wrapId, ctx.svgId, ctx.logos, ctx.face, ctx.onChange, ctx.flagOverride, ctx.colorsOverride, ctx.gsTagOpts);
          ctx.onChange();
        } catch (err) { console.error('Logo upload failed', err); }
        return;
      }

      const dragId = _dragLogoId;
      if (!dragId) return;
      ctx.logos.push({ id: 'pl-' + Date.now(), logoId: dragId, x: 50, y: 50, w: 75 });
      setDragLogoId(null);
      renderDropZones(ctx.wrapId, ctx.svgId, ctx.logos, ctx.face, ctx.onChange, ctx.flagOverride, ctx.colorsOverride, ctx.gsTagOpts);
      ctx.onChange();
    });
  }

  wrap.appendChild(dz);
}
