import { S, _dragLogoId, setDragLogoId } from '../state.js';
import { getFlag, applyColors, showGsTagVariant } from '../render.js';
import { uploadLogo } from '../supabase.js';
import { logoThumbHtml } from '../media-utils.js';
import { isLightColor } from '../gsTag.js';

let _onLibraryUpdated = () => {};
// { layerId, logos, dz, wrapId, svgId, face, onChange }
// layerId === '_add_' means "add new logo" mode
let _activeLayer = null;

export function initDropZones({ ensureProject, markDirty, onLibraryUpdated } = {}) {
  _onLibraryUpdated = onLibraryUpdated || _onLibraryUpdated;
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
      const { layerId, logos, wrapId, svgId, face, onChange } = _activeLayer;
      const lid = el.dataset.lid;
      if (layerId === '_add_') {
        logos.push({ id: 'pl-' + Date.now(), logoId: lid, x: 50, y: 50, w: 60 });
      } else {
        const l = logos.find(l => l.id === layerId);
        if (l) l.logoId = lid;
      }
      hideZoneToolbar();
      renderDropZones(wrapId, svgId, logos, face, onChange);
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
    <div style="position:relative">
      <button class="dz-tb-btn" id="dzTbReplace">Replace ▾</button>
      <div class="dz-lib-picker" id="dzLibPicker" style="display:none"></div>
    </div>
    <input type="file" id="dzReplaceFile" accept="image/*,.pdf,.ai,.eps" style="display:none">`;
  document.body.appendChild(t);

  document.getElementById('dzTbBack').addEventListener('click', () => {
    if (!_activeLayer || _activeLayer.layerId === '_add_') return;
    const { layerId, logos, wrapId, svgId, face, onChange } = _activeLayer;
    const idx = logos.findIndex(l => l.id === layerId);
    if (idx > 0) { const [item] = logos.splice(idx, 1); logos.unshift(item); }
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, logos, face, onChange);
    onChange();
  });

  document.getElementById('dzTbFront').addEventListener('click', () => {
    if (!_activeLayer || _activeLayer.layerId === '_add_') return;
    const { layerId, logos, wrapId, svgId, face, onChange } = _activeLayer;
    const idx = logos.findIndex(l => l.id === layerId);
    if (idx < logos.length - 1) { const [item] = logos.splice(idx, 1); logos.push(item); }
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, logos, face, onChange);
    onChange();
  });

  document.getElementById('dzTbRemove').addEventListener('click', () => {
    if (!_activeLayer || _activeLayer.layerId === '_add_') return;
    const { layerId, logos, wrapId, svgId, face, onChange } = _activeLayer;
    const idx = logos.findIndex(l => l.id === layerId);
    if (idx >= 0) logos.splice(idx, 1);
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, logos, face, onChange);
    onChange();
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
    const { layerId, logos, wrapId, svgId, face, onChange } = _activeLayer;
    try {
      const logo = await uploadLogo(S.projectId, file);
      S.library.push(logo);
      if (layerId === '_add_') {
        logos.push({ id: 'pl-' + Date.now(), logoId: logo.id, x: 50, y: 50, w: 60 });
      } else {
        const l = logos.find(l => l.id === layerId);
        if (l) l.logoId = logo.id;
      }
      hideZoneToolbar();
      _onLibraryUpdated();
      renderDropZones(wrapId, svgId, logos, face, onChange);
      onChange();
    } catch (err) { console.error('Upload failed', err); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#dzToolbar') && !e.target.closest('.dz-logo-wrap') && !e.target.closest('.dzone')) {
      hideZoneToolbar();
    }
  });
}

function setupLogoInteraction(logoWrap, corners, dz, layer, logos, wrapId, svgId, face, onChange) {
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
    if (!dragging) return;
    const dzRect = dz.getBoundingClientRect();
    const dx = (e.clientX - startPX) / dzRect.width  * 100;
    const dy = (e.clientY - startPY) / dzRect.height * 100;
    const hw = layer.w / 2;
    let nx = Math.max(hw, Math.min(100 - hw, startX + dx));
    let ny = Math.max(5, Math.min(95, startY + dy));

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

  logoWrap.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    dz.classList.remove('dz-adjusting', 'snap-h', 'snap-v');
    const tb = document.getElementById('dzToolbar');
    if (tb) { tb.style.visibility = ''; positionToolbar(logoWrap); }
    onChange();
  });

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
      if (!resizing) return;
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
        layer.x = Math.max(nw / 2, Math.min(100 - nw / 2, rStartX0 - actualDw / 2));
        logoWrap.style.left = layer.x + '%';
      }
    });

    handle.addEventListener('pointerup', () => {
      if (!resizing) return;
      resizing = false;
      dz.classList.remove('dz-adjusting');
      const tb = document.getElementById('dzToolbar');
      if (tb) { tb.style.visibility = ''; positionToolbar(logoWrap); }
      onChange();
    });
  });

  logoWrap.addEventListener('click', e => {
    e.stopPropagation();
    dz.querySelectorAll('.dz-logo-wrap').forEach(w => w.classList.remove('selected'));
    logoWrap.classList.add('selected');
    _activeLayer = { layerId: layer.id, logos, dz, wrapId, svgId, face, onChange };
    showToolbar(logoWrap, false);
    document.getElementById('dzLibPicker').style.display = 'none';
  });
}

export function renderDropZones(wrapId, svgId, logos, face = 'front', onChange = () => {}, flagOverride = null, colorsOverride = null) {
  const flag = flagOverride || getFlag();
  if (!flag) return;
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;

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
  applyColors(svg, colors, flag.noColors);

  if (S.gsTag) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    const keyHex = colors[keyZone];
    const style = S.gsTagMode === 'light' ? 'Dark'
      : S.gsTagMode === 'dark' ? 'Light'
      : keyHex ? (isLightColor(keyHex) ? 'Light' : 'Dark')
      : (flag.tagKeyZone ? 'Light' : 'Dark');
    showGsTagVariant(svg, style, face);
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

  // Empty-state hint
  if (!logos.length) {
    const hint = document.createElement('div');
    hint.className = 'dz-empty-hint';
    hint.textContent = 'Drop a logo here';
    dz.appendChild(hint);
  }

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
    setupLogoInteraction(logoWrap, corners, dz, layer, logos, wrapId, svgId, face, onChange);
  });

  // "+" button — always visible bottom-right of zone
  const addBtn = document.createElement('button');
  addBtn.className = 'dz-add-btn';
  addBtn.title = 'Add logo';
  addBtn.textContent = '+';
  function openAddPicker(anchorEl) {
    _activeLayer = { layerId: '_add_', logos, dz, wrapId, svgId, face, onChange };
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

  addBtn.addEventListener('click', e => { e.stopPropagation(); openAddPicker(addBtn); });
  dz.appendChild(addBtn);

  // Click on zone background → open add picker
  dz.addEventListener('click', e => {
    if (e.target !== dz && !e.target.classList.contains('dz-empty-hint')) return;
    openAddPicker(dz);
  });

  // Drop from library strip
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const dragId = _dragLogoId;
    if (!dragId) return;
    logos.push({ id: 'pl-' + Date.now(), logoId: dragId, x: 50, y: 50, w: 60 });
    setDragLogoId(null);
    renderDropZones(wrapId, svgId, logos, face, onChange);
    onChange();
  });

  wrap.appendChild(dz);
}
