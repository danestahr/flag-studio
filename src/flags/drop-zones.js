import { S, _dragLogoId, setDragLogoId } from '../state.js';
import { getFlag, applyColors, getLogoData, renderInto } from '../render.js';
import { uploadLogo } from '../supabase.js';
import { logoThumbHtml } from '../media-utils.js';

let _activeZone = null;
let _ensureProject = async () => {};
let _markDirty = () => {};
let _onLibraryUpdated = () => {};

export function initDropZones({ ensureProject, markDirty, onLibraryUpdated }) {
  _ensureProject = ensureProject || _ensureProject;
  _markDirty = markDirty || _markDirty;
  _onLibraryUpdated = onLibraryUpdated || _onLibraryUpdated;
}

function refreshVarThumbs() {
  S.variations.forEach(v => {
    const el = document.getElementById('vt-' + v.id);
    if (!el) return;
    renderInto(el, v.assignment, 'front');
  });
}

function setDzSolo(wrapId, on) {
  const wrap = wrapId ? document.getElementById(wrapId) : null;
  if (wrap) wrap.classList.toggle('dz-solo', on);
}

function syncBadges(wrapId) {
  const wrap = wrapId ? document.getElementById(wrapId) : null;
  if (!wrap) return;
  const dzones = Array.from(wrap.querySelectorAll('.dzone'));
  wrap.querySelectorAll('.dz-badge').forEach((b, i) => {
    b.classList.toggle('active', dzones[i] === _activeZone?.dz);
  });
}

function renderLibPicker() {
  const picker = document.getElementById('dzLibPicker');
  if (!picker || !_activeZone) return;
  const { assignment, zoneId, wrapId, svgId, face } = _activeZone;
  const existing = getLogoData(assignment, zoneId);
  picker.innerHTML = S.library.length
    ? S.library.map(l => `
        <div class="dz-lp-item${existing?.id === l.id ? ' active' : ''}" data-lid="${l.id}" title="${l.name}">
          ${logoThumbHtml(l.src, l.name)}
        </div>`).join('') + `<div class="dz-lp-upload" id="dzLpUpload">+ Upload</div>`
    : `<div class="dz-lp-upload" id="dzLpUpload">+ Upload</div>`;

  picker.querySelectorAll('.dz-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      const lid = el.dataset.lid;
      assignment[zoneId] = { id: lid, x: existing?.x ?? 50, y: existing?.y ?? 50, w: existing?.w ?? 80 };
      hideZoneToolbar();
      renderDropZones(wrapId, svgId, assignment, face);
      refreshVarThumbs();
      _markDirty();
    });
  });
  picker.querySelector('#dzLpUpload')?.addEventListener('click', () => {
    document.getElementById('dzReplaceFile').click();
  });
}

function showZoneToolbar(dz, openPicker = false) {
  ensureToolbar();
  setDzSolo(_activeZone?.wrapId, true);
  syncBadges(_activeZone?.wrapId);
  const hasLogo = !!getLogoData(_activeZone?.assignment, _activeZone?.zoneId);
  document.getElementById('dzTbRemove').style.display = hasLogo ? '' : 'none';
  document.getElementById('dzTbSep').style.display    = hasLogo ? '' : 'none';
  document.getElementById('dzTbReplace').textContent  = hasLogo ? 'Replace ▾' : 'Choose logo ▾';

  const picker = document.getElementById('dzLibPicker');
  picker.style.display = openPicker ? 'block' : 'none';
  if (openPicker) renderLibPicker();

  const tb = document.getElementById('dzToolbar');
  tb.style.display = 'flex';
  const dzRect = dz.getBoundingClientRect();
  const tbH = tb.offsetHeight || 36;
  const topAbove = dzRect.top + window.scrollY - tbH - 6;
  const topBelow = dzRect.bottom + window.scrollY + 6;
  const top = dzRect.top > tbH + 20 ? topAbove : topBelow;
  tb.style.left = Math.max(8, dzRect.left + window.scrollX) + 'px';
  tb.style.top = top + 'px';
}

export function hideZoneToolbar() {
  const tb = document.getElementById('dzToolbar');
  if (tb) tb.style.display = 'none';
  const picker = document.getElementById('dzLibPicker');
  if (picker) picker.style.display = 'none';
  if (_activeZone?.dz) _activeZone.dz.classList.remove('selected');
  setDzSolo(_activeZone?.wrapId, false);
  syncBadges(_activeZone?.wrapId);
  _activeZone = null;
}

function ensureToolbar() {
  if (document.getElementById('dzToolbar')) return;
  const t = document.createElement('div');
  t.id = 'dzToolbar';
  t.className = 'dz-toolbar';
  t.innerHTML = `
    <button class="dz-tb-btn" id="dzTbRemove">Remove</button>
    <div class="dz-tb-sep" id="dzTbSep"></div>
    <div style="position:relative">
      <button class="dz-tb-btn" id="dzTbReplace">Replace ▾</button>
      <div class="dz-lib-picker" id="dzLibPicker" style="display:none"></div>
    </div>
    <input type="file" id="dzReplaceFile" accept="image/*,.pdf,.ai,.eps" style="display:none">`;
  document.body.appendChild(t);

  document.getElementById('dzTbRemove').addEventListener('click', () => {
    if (!_activeZone) return;
    const { assignment, zoneId, wrapId, svgId, face } = _activeZone;
    delete assignment[zoneId];
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, assignment, face);
    refreshVarThumbs();
    _markDirty();
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
    if (!file || !_activeZone) return;
    const { assignment, zoneId, wrapId, svgId, face } = _activeZone;
    const existing = getLogoData(assignment, zoneId);
    await _ensureProject();
    try {
      const logo = await uploadLogo(S.projectId, file);
      S.library.push(logo);
      assignment[zoneId] = { id: logo.id, x: existing?.x ?? 50, y: existing?.y ?? 50, w: existing?.w ?? 80 };
      hideZoneToolbar();
      _onLibraryUpdated();
      renderDropZones(wrapId, svgId, assignment, face);
      refreshVarThumbs();
      _markDirty();
    } catch (err) { console.error('Upload failed', err); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#dzToolbar') && !e.target.closest('.dz-logo-wrap') && !e.target.closest('.dzone') && !e.target.closest('.dz-badge')) hideZoneToolbar();
  });
}

function setupLogoInteraction(logoWrap, resizeHandle, dz, assignment, zoneId, wrapId, svgId, face) {
  let dragging = false, startPX, startPY, startX, startY;

  logoWrap.addEventListener('pointerdown', e => {
    if (e.target === resizeHandle) return;
    dragging = true;
    dz.classList.add('dz-adjusting');
    setDzSolo(wrapId, true);
    logoWrap.setPointerCapture(e.pointerId);
    startPX = e.clientX; startPY = e.clientY;
    startX  = parseFloat(logoWrap.style.left);
    startY  = parseFloat(logoWrap.style.top);
    e.preventDefault();
  });

  logoWrap.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dzRect = dz.getBoundingClientRect();
    const dx = (e.clientX - startPX) / dzRect.width  * 100;
    const dy = (e.clientY - startPY) / dzRect.height * 100;
    const hw = parseFloat(logoWrap.style.width) / 2;
    let nx = Math.max(hw, Math.min(100 - hw, startX + dx));
    let ny = Math.max(5,  Math.min(95,        startY + dy));

    const snapX = 5 / dzRect.width  * 100;
    const snapY = 5 / dzRect.height * 100;
    const snapH = Math.abs(nx - 50) < snapX;
    const snapV = Math.abs(ny - 50) < snapY;
    if (snapH) nx = 50;
    if (snapV) ny = 50;
    dz.classList.toggle('snap-h', snapH);
    dz.classList.toggle('snap-v', snapV);

    logoWrap.style.left = nx + '%';
    logoWrap.style.top  = ny + '%';
  });

  logoWrap.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    dz.classList.remove('dz-adjusting', 'snap-h', 'snap-v');
    if (!_activeZone || _activeZone.dz !== dz) setDzSolo(wrapId, false);
    const nx = parseFloat(logoWrap.style.left);
    const ny = parseFloat(logoWrap.style.top);
    const prev = getLogoData(assignment, zoneId) || {};
    assignment[zoneId] = { ...prev, x: nx, y: ny };
    refreshVarThumbs();
    _markDirty();
  });

  let resizing = false, rStartX, rStartW, rDzW;

  resizeHandle.addEventListener('pointerdown', e => {
    resizing = true;
    dz.classList.add('dz-adjusting');
    setDzSolo(wrapId, true);
    resizeHandle.setPointerCapture(e.pointerId);
    rStartX = e.clientX;
    rStartW = parseFloat(logoWrap.style.width);
    rDzW    = dz.getBoundingClientRect().width;
    e.stopPropagation();
    e.preventDefault();
  });

  resizeHandle.addEventListener('pointermove', e => {
    if (!resizing) return;
    const delta = (e.clientX - rStartX) / rDzW * 100 * 2;
    const nw = Math.max(15, Math.min(100, rStartW + delta));
    logoWrap.style.width = nw + '%';
  });

  resizeHandle.addEventListener('pointerup', () => {
    if (!resizing) return;
    resizing = false;
    dz.classList.remove('dz-adjusting');
    if (!_activeZone || _activeZone.dz !== dz) setDzSolo(wrapId, false);
    const nw = parseFloat(logoWrap.style.width);
    const prev = getLogoData(assignment, zoneId) || {};
    assignment[zoneId] = { ...prev, w: nw };
    refreshVarThumbs();
    _markDirty();
  });
}

export function renderDropZones(wrapId, svgId, assignment, face = 'front') {
  const flag = getFlag();
  if (!flag) return;
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap.querySelectorAll('.dzone, .dz-badge').forEach(d => d.remove());
  const svg = document.getElementById(svgId);
  if (!svg) return;
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  const [vbW, vbH] = (flag.viewBox || '0 0 7519 4669').split(' ').slice(2).map(Number);
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
  applyColors(svg, S.colors);
  wrap.style.aspectRatio = vbW + ' / ' + vbH;

  flag.logoZones.forEach(zone => {
    const ld = getLogoData(assignment, zone.id);
    const logo = ld ? S.library.find(l => l.id === ld.id) : null;
    const zoneX = face === 'back' ? vbW - zone.x - zone.w : zone.x;
    const left   = (zoneX  / vbW) * 100;
    const top    = (zone.y / vbH) * 100;
    const width  = (zone.w / vbW) * 100;
    const height = (zone.h / vbH) * 100;

    const dz = document.createElement('div');
    dz.className = 'dzone' + (logo ? ' has-logo' : '');
    dz.dataset.zoneId = zone.id;
    dz.style.cssText = `left:${left}%;top:${top}%;width:${width}%;height:${height}%;`;

    const gh = document.createElement('div'); gh.className = 'dz-guide-h'; dz.appendChild(gh);
    const gv = document.createElement('div'); gv.className = 'dz-guide-v'; dz.appendChild(gv);

    if (logo && ld) {
      const logoWrap = document.createElement('div');
      logoWrap.className = 'dz-logo-wrap';
      logoWrap.style.left  = ld.x + '%';
      logoWrap.style.top   = ld.y + '%';
      logoWrap.style.width = ld.w + '%';

      const img = document.createElement('img');
      img.className = 'placed-img';
      img.src = logo.src;
      img.alt = logo.name;
      img.draggable = false;
      logoWrap.appendChild(img);

      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'dz-resize';
      logoWrap.appendChild(resizeHandle);

      dz.appendChild(logoWrap);
      setupLogoInteraction(logoWrap, resizeHandle, dz, assignment, zone.id, wrapId, svgId, face);

      logoWrap.addEventListener('click', e => {
        e.stopPropagation();
        if (_activeZone?.dz === dz) return;
        if (_activeZone) _activeZone.dz.classList.remove('selected');
        _activeZone = { dz, assignment, zoneId: zone.id, wrapId, svgId, face };
        dz.classList.add('selected');
        showZoneToolbar(dz);
      });
    }

    if (!logo) {
      dz.style.cursor = 'pointer';
      dz.addEventListener('click', e => {
        e.stopPropagation();
        if (_activeZone?.dz === dz) return;
        if (_activeZone) _activeZone.dz.classList.remove('selected');
        _activeZone = { dz, assignment, zoneId: zone.id, wrapId, svgId, face };
        dz.classList.add('selected');
        showZoneToolbar(dz, true);
      });
    }

    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('drag-over');
      const dragId = _dragLogoId;
      if (!dragId) return;
      const prev = getLogoData(assignment, zone.id);
      assignment[zone.id] = { id: dragId, x: prev?.x ?? 50, y: prev?.y ?? 50, w: prev?.w ?? 80 };
      setDragLogoId(null);
      renderDropZones(wrapId, svgId, assignment, face);
      refreshVarThumbs();
      _markDirty();
    });

    wrap.appendChild(dz);
  });

  if (flag.logoZones.length > 1) {
    const dzones = Array.from(wrap.querySelectorAll('.dzone'));
    flag.logoZones.forEach((zone, i) => {
      const badge = document.createElement('button');
      badge.className = 'dz-badge';
      badge.textContent = i + 1;
      badge.title = zone.label || `Zone ${i + 1}`;
      const zoneX = face === 'back' ? vbW - zone.x - zone.w : zone.x;
      badge.style.left = (zoneX / vbW * 100).toFixed(3) + '%';
      badge.style.top  = (zone.y / vbH * 100).toFixed(3) + '%';
      badge.addEventListener('click', e => {
        e.stopPropagation();
        const dz = dzones[i];
        if (_activeZone) _activeZone.dz.classList.remove('selected');
        setDzSolo(wrapId, false);
        _activeZone = { dz, assignment, zoneId: zone.id, wrapId, svgId, face };
        dz.classList.add('selected');
        showZoneToolbar(dz);
      });
      wrap.appendChild(badge);
    });
  }
}
