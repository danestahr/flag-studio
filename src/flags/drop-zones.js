import { S, _dragLogoId, setDragLogoId } from '../state.js';
import { getFlag, applyColors, showGsTagVariant, resolveColors } from '../render.js';
import { uploadLogo } from '../supabase.js';
import { logoThumbHtml } from '../media-utils.js';

let _onLibraryUpdated = () => {};
// { layerId, logos, dz, wrapId, svgId, face, onChange }
// layerId === '_add_' means "add new logo" mode
let _activeLayer = null;

// Set on every renderDropZones() call to open that zone's Text/Logo choice —
// there's no in-canvas "+" anymore, so callers outside this module (a header
// "+" button) trigger it via triggerAdd() instead.
let _addTrigger = null;

export function initDropZones({ ensureProject, markDirty, onLibraryUpdated } = {}) {
  _onLibraryUpdated = onLibraryUpdated || _onLibraryUpdated;
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
  _activeLayer?.dz?.querySelectorAll('.dz-logo-wrap').forEach(w => w.classList.remove('selected'));
  _activeLayer = null;
}

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
  if (!picker || !_activeLayer) return;
  const { layerId, logos } = _activeLayer;
  const isAdd = layerId === '_add_';
  const layer = logos.find(l => l.id === layerId);

  picker.innerHTML = S.library.map(l => `
      <div class="dz-lp-item${!isAdd && layer?.logoId === l.id ? ' active' : ''}" data-lid="${l.id}" title="${l.name}">
        ${logoThumbHtml(l.src, l.name)}
      </div>`).join('') + `<div class="dz-lp-upload" id="dzLpUpload">+</div>`;

  picker.querySelectorAll('.dz-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      if (!_activeLayer) return;
      const { layerId, logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _activeLayer;
      const lid = el.dataset.lid;
      if (layerId === '_add_') {
        logos.push({ id: 'pl-' + Date.now(), logoId: lid, x: 50, y: 50, w: 75 });
      } else {
        const l = logos.find(l => l.id === layerId);
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
  const showOrder = !isAdd && (_activeLayer?.logos?.length > 1);
  document.getElementById('dzTbRemove').style.display = isAdd ? 'none' : '';
  document.getElementById('dzTbSep').style.display = isAdd ? 'none' : '';
  document.getElementById('dzTbRemoveBg').style.display = isAdd ? 'none' : '';
  document.getElementById('dzTbRemoveBgSep').style.display = isAdd ? 'none' : '';
  document.getElementById('dzTbBack').style.display = showOrder ? '' : 'none';
  document.getElementById('dzTbFront').style.display = showOrder ? '' : 'none';
  document.getElementById('dzTbOrderSep').style.display = showOrder ? '' : 'none';
  document.getElementById('dzTbReplace').textContent  = isAdd ? 'Add logo ▾' : 'Replace ▾';

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
    <button class="dz-tb-btn" id="dzTbBack" title="Send to back">↙ Back</button>
    <button class="dz-tb-btn" id="dzTbFront" title="Bring to front">↗ Front</button>
    <div class="dz-tb-sep" id="dzTbOrderSep"></div>
    <button class="dz-tb-btn" id="dzTbRemove">Remove</button>
    <div class="dz-tb-sep" id="dzTbSep"></div>
    <button class="dz-tb-btn" id="dzTbRemoveBg" title="Remove background">✦ Remove BG</button>
    <div class="dz-tb-sep" id="dzTbRemoveBgSep"></div>
    <div style="position:relative">
      <button class="dz-tb-btn" id="dzTbReplace">Replace ▾</button>
      <div class="dz-lib-picker" id="dzLibPicker" style="display:none"></div>
    </div>
    <input type="file" id="dzReplaceFile" accept="image/*,.pdf,.ai,.eps" style="display:none">`;
  document.body.appendChild(t);

  document.getElementById('dzTbBack').addEventListener('click', () => {
    if (!_activeLayer || _activeLayer.layerId === '_add_') return;
    const { layerId, logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _activeLayer;
    const idx = logos.findIndex(l => l.id === layerId);
    if (idx > 0) { const [item] = logos.splice(idx, 1); logos.unshift(item); }
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
    onChange();
  });

  document.getElementById('dzTbFront').addEventListener('click', () => {
    if (!_activeLayer || _activeLayer.layerId === '_add_') return;
    const { layerId, logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _activeLayer;
    const idx = logos.findIndex(l => l.id === layerId);
    if (idx < logos.length - 1) { const [item] = logos.splice(idx, 1); logos.push(item); }
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
    onChange();
  });

  document.getElementById('dzTbRemove').addEventListener('click', () => {
    if (!_activeLayer || _activeLayer.layerId === '_add_') return;
    const { layerId, logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _activeLayer;
    const idx = logos.findIndex(l => l.id === layerId);
    if (idx >= 0) logos.splice(idx, 1);
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, logos, face, onChange, flagOverride, colorsOverride, gsTagOpts);
    onChange();
  });

  document.getElementById('dzTbRemoveBg').addEventListener('click', async () => {
    if (!_activeLayer || _activeLayer.layerId === '_add_') return;
    const { layerId, logos, dz, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _activeLayer;
    const layer = logos.find(l => l.id === layerId);
    const logo = layer && S.library.find(l => l.id === layer.logoId);
    if (!logo) return;
    const btn = document.getElementById('dzTbRemoveBg');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    const logoWrap = dz.querySelector(`.dz-logo-wrap[data-layer-id="${layerId}"]`) || dz;
    const spinner = document.createElement('div');
    spinner.className = 'logo-processing-spinner';
    logoWrap.appendChild(spinner);
    try {
      const { removeBackground } = await import('@imgly/background-removal');
      btn.textContent = '↑';
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
      btn.textContent = origText;
      btn.disabled = false;
    }
  });

  document.getElementById('dzTbReplace').addEventListener('click', e => {
    e.stopPropagation();
    const picker = document.getElementById('dzLibPicker');
    const open = picker.style.display !== 'none';
    picker.style.display = open ? 'none' : 'block';
    if (!open) renderLibPicker();
  });

  document.getElementById('dzReplaceFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !_activeLayer) return;
    const { layerId, logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts } = _activeLayer;
    try {
      const logo = await uploadLogo(S.projectId, file);
      S.library.push(logo);
      if (layerId === '_add_') {
        logos.push({ id: 'pl-' + Date.now(), logoId: logo.id, x: 50, y: 50, w: 75 });
      } else {
        const l = logos.find(l => l.id === layerId);
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

// The logo's x/y/w are stored as % of its zone box, but a logo should be
// draggable anywhere across the whole flag canvas (not boxed into its zone) —
// the flag's own overflow:hidden wrap is what clips it once it bleeds past the
// canvas edge. Convert the canvas bounds into that zone-relative % space.
function canvasBoundsInZonePct(dz, wrapId) {
  const dzRect = dz.getBoundingClientRect();
  const wrapRect = document.getElementById(wrapId).getBoundingClientRect();
  return {
    minX: (wrapRect.left - dzRect.left) / dzRect.width  * 100,
    maxX: (wrapRect.right - dzRect.left) / dzRect.width  * 100,
    minY: (wrapRect.top  - dzRect.top)  / dzRect.height * 100,
    maxY: (wrapRect.bottom - dzRect.top) / dzRect.height * 100,
  };
}

function setupLogoInteraction(logoWrap, corners, dz, layer, logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts) {
  const isCorner = el => corners.some(c => c.el === el);
  let dragging = false, startPX, startPY, startX, startY;

  logoWrap.addEventListener('pointerdown', e => {
    if (isCorner(e.target)) return;
    dragging = true;
    dz.classList.add('dz-adjusting');
    logoWrap.setPointerCapture(e.pointerId);
    startPX = e.clientX; startPY = e.clientY;
    startX = layer.x; startY = layer.y;
    const tb = document.getElementById('dzToolbar');
    if (tb) tb.style.visibility = 'hidden';
    e.preventDefault();
  });

  logoWrap.addEventListener('pointermove', e => {
    // hasPointerCapture guards against a dropped/lost pointerup (e.g. the OS or
    // browser interrupts the gesture) leaving `dragging` stuck true — without it,
    // the next hover-only pointermove would move the logo using the stale start point.
    if (!dragging || !logoWrap.hasPointerCapture(e.pointerId)) return;
    const dzRect = dz.getBoundingClientRect();
    const dx = (e.clientX - startPX) / dzRect.width  * 100;
    const dy = (e.clientY - startPY) / dzRect.height * 100;
    const bounds = canvasBoundsInZonePct(dz, wrapId);
    let nx = Math.max(bounds.minX, Math.min(bounds.maxX, startX + dx));
    let ny = Math.max(bounds.minY, Math.min(bounds.maxY, startY + dy));

    const snapPxX = 5 / dzRect.width  * 100;
    const snapPxY = 5 / dzRect.height * 100;
    const snapH = Math.abs(nx - 50) < snapPxX;
    const snapV = Math.abs(ny - 50) < snapPxY;
    if (snapH) nx = 50;
    if (snapV) ny = 50;
    dz.classList.toggle('snap-h', snapH);
    dz.classList.toggle('snap-v', snapV);

    layer.x = nx; layer.y = ny;
    logoWrap.style.left = nx + '%';
    logoWrap.style.top  = ny + '%';
  });

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    dz.classList.remove('dz-adjusting', 'snap-h', 'snap-v');
    const tb = document.getElementById('dzToolbar');
    if (tb) { tb.style.visibility = ''; positionToolbar(logoWrap); }
    onChange();
  };
  logoWrap.addEventListener('pointerup', stopDragging);
  logoWrap.addEventListener('pointercancel', stopDragging);

  corners.forEach(({ pos, el: handle }) => {
    const isLeft = pos === 'tl' || pos === 'bl';
    const isTop  = pos === 'tl' || pos === 'tr';
    // unit vector pointing outward from center for this corner
    const dirX = isLeft ? -1 : 1;
    const dirY = isTop  ? -1 : 1;
    let resizing = false, rStartX, rStartY, rStartW, rStartX0, rDzW, rDzH;

    handle.addEventListener('pointerdown', e => {
      resizing = true;
      dz.classList.add('dz-adjusting');
      handle.setPointerCapture(e.pointerId);
      rStartX = e.clientX;
      rStartY = e.clientY;
      rStartW = layer.w;
      rStartX0 = layer.x;
      const dzRect = dz.getBoundingClientRect();
      rDzW = dzRect.width;
      rDzH = dzRect.height;
      const tb = document.getElementById('dzToolbar');
      if (tb) tb.style.visibility = 'hidden';
      e.stopPropagation();
      e.preventDefault();
    });

    handle.addEventListener('pointermove', e => {
      // hasPointerCapture guards against a dropped/lost pointerup leaving `resizing`
      // stuck true — without it, merely hovering the handle afterward would resize
      // the logo using the stale rStartX/rStartY from the original drag.
      if (!resizing || !handle.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - rStartX;
      const dy = e.clientY - rStartY;
      // dead-zone: ignore micro-movements
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      // project displacement onto outward direction; both axes contribute
      const rawDx = dx / rDzW * 100 * 2;
      const rawDy = dy / rDzH * 100 * 2;
      const dw = dirX * rawDx + dirY * rawDy;
      const nw = Math.max(10, Math.min(150, rStartW + dw));
      const actualDw = nw - rStartW;
      layer.w = nw;
      logoWrap.style.width = nw + '%';
      if (isLeft) {
        const bounds = canvasBoundsInZonePct(dz, wrapId);
        layer.x = Math.max(bounds.minX, Math.min(bounds.maxX, rStartX0 - actualDw / 2));
        logoWrap.style.left = layer.x + '%';
      }
    });

    const stopResizing = () => {
      if (!resizing) return;
      resizing = false;
      dz.classList.remove('dz-adjusting');
      const tb = document.getElementById('dzToolbar');
      if (tb) { tb.style.visibility = ''; positionToolbar(logoWrap); }
      onChange();
    };
    handle.addEventListener('pointerup', stopResizing);
    handle.addEventListener('pointercancel', stopResizing);
  });

  logoWrap.addEventListener('click', e => {
    e.stopPropagation();
    dz.querySelectorAll('.dz-logo-wrap').forEach(w => w.classList.remove('selected'));
    logoWrap.classList.add('selected');
    _activeLayer = { layerId: layer.id, logos, dz, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts };
    showToolbar(logoWrap, false);
    document.getElementById('dzLibPicker').style.display = 'none';
  });
}

export function renderDropZones(wrapId, svgId, logos, face = 'front', onChange = () => {}, flagOverride = null, colorsOverride = null, gsTagOpts = null) {
  const flag = flagOverride || getFlag();
  if (!flag) return;
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap._dzReadonly = false;

  wrap.querySelectorAll('.dzone, .dz-badge').forEach(d => d.remove());
  const svg = document.getElementById(svgId);
  if (!svg) return;

  const [vbW, vbH] = (flag.viewBox || '0 0 7519 4669').split(' ').slice(2).map(Number);
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  if (face === 'back') {
    svg.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
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

    const logoWrap = document.createElement('div');
    logoWrap.className = 'dz-logo-wrap';
    logoWrap.dataset.layerId = layer.id;
    logoWrap.style.left  = layer.x + '%';
    logoWrap.style.top   = layer.y + '%';
    logoWrap.style.width = layer.w + '%';

    const img = document.createElement('img');
    img.className = 'placed-img';
    img.src = logo.src;
    img.alt = logo.name;
    img.draggable = false;
    logoWrap.appendChild(img);

    const corners = ['tl','tr','bl','br'].map(pos => {
      const h = document.createElement('div');
      h.className = `dz-resize dz-resize-${pos}`;
      logoWrap.appendChild(h);
      return { pos, el: h };
    });

    dz.appendChild(logoWrap);
    setupLogoInteraction(logoWrap, corners, dz, layer, logos, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts);
  });

  function openAddPicker(anchorEl) {
    _activeLayer = { layerId: '_add_', logos, dz, wrapId, svgId, face, onChange, flagOverride, colorsOverride, gsTagOpts };
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
    wrap.addEventListener('drop', e => {
      if (wrap._dzReadonly) return;
      e.preventDefault();
      hideDragOverlay(wrap);
      const dragId = _dragLogoId;
      if (!dragId) return;
      const ctx = wrap._dzDropCtx;
      if (!ctx) return;
      ctx.logos.push({ id: 'pl-' + Date.now(), logoId: dragId, x: 50, y: 50, w: 75 });
      setDragLogoId(null);
      renderDropZones(ctx.wrapId, ctx.svgId, ctx.logos, ctx.face, ctx.onChange, ctx.flagOverride, ctx.colorsOverride, ctx.gsTagOpts);
      ctx.onChange();
    });
  }

  wrap.appendChild(dz);
}
