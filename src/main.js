import './style.css';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { S, _dragLogoId, setDragLogoId } from './state.js';
import { FLAGS, COLORS } from './data.js';
import { getFlag, applyColors, makeSvg, renderInto, getLogoData } from './render.js';
import {
  createProject, updateProject, loadProject,
  saveFlagConfig, loadFlagConfig,
  uploadLogo, loadLogosForProject, deleteLogo,
  generateShareToken, getFeedback, resolveFeedback, supabase,
  loadOrderIntake, sendProofReady,
} from './supabase.js';
import { loadAllFlags } from './svgLoader.js';

let activeFace = 'front';
let gFace = 'front';
let feedbackChannel = null;
let isDirty = false;

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function safeHex(h) { return /^#[0-9A-Fa-f]{3,6}$/.test(h) ? h : '#cccccc'; }

async function ensureProject() {
  if (S.projectId) return;
  try {
    S.projectId = await createProject(S.projectName);
    history.replaceState(null, '', '?project=' + S.projectId);
  } catch (err) {
    console.error('Could not create project', err);
  }
}

function markDirty() {
  isDirty = true;
  document.getElementById('saveDesignsBtn')?.classList.add('dirty');
  ensureProject();
}
function markClean() {
  isDirty = false;
  document.getElementById('saveDesignsBtn')?.classList.remove('dirty');
}

// ── NAV ───────────────────────────────────────────────────
function currentStep() {
  return [...document.querySelectorAll('.panel')].findIndex(p => p.classList.contains('visible')) + 1;
}

window.tryGoStep = (n) => { goStep(n); };

window.goStep = function goStep(n) {
  if (n !== 5 && feedbackChannel) { feedbackChannel.unsubscribe(); feedbackChannel = null; }
  document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('visible', i === n - 1));
  document.querySelectorAll('.step-item').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i === n - 1) s.classList.add('active');
    else if (i < n - 1) s.classList.add('done');
  });
  if (n === 1) renderP1Colors();
  if (n === 2) setupColors();
  if (n === 3) setupLibrary();
  if (n === 4) setupVariations();
  if (n === 5) setupGallery();
  window.scrollTo(0, 0);
};

// ── STEP 1 ────────────────────────────────────────────────
function renderFlagGrid() {
  document.getElementById('flagGrid').innerHTML = FLAGS.map(f => `
    <div class="flag-card" id="fc-${f.id}" onclick="pickFlag('${f.id}')">
      <div class="flag-card-preview"><svg viewBox="${f.viewBox || '0 0 7519 4669'}" preserveAspectRatio="xMidYMid meet">${f.svgContent}</svg></div>
      <div><div class="flag-card-name">${f.name}</div><div class="flag-card-zones">${f.colorZones.map(z => z.label).join(', ')}</div></div>
    </div>`).join('');
}

window.pickFlag = function (id) {
  S.flagId = id;
  document.querySelectorAll('.flag-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('fc-' + id).classList.add('selected');
  renderP1Colors();
  checkStep1();
  syncSidebar();
  markDirty();
};

const P1_ZONES = [
  { id: 'zone-primary',   label: 'Field color' },
  { id: 'zone-secondary', label: 'Stripe color' },
];

function renderP1Colors() {
  const container = document.getElementById('p1colorZones');
  if (!container) return;
  container.innerHTML = P1_ZONES.map(z => {
    const hex = S.colors[z.id];
    const col = COLORS.find(c => c.hex === hex);
    if (hex) {
      return `<div class="p1zone">
        <div class="zlabel">${z.label}</div>
        <div class="color-chip-picked">
          <span class="chip-dot" style="background:${hex};${hex === '#FFFFFF' ? 'border:1px solid var(--gray-200)' : ''}"></span>
          <span>${col?.name || hex}</span>
          <button class="chip-clear" onclick="clearColor('${z.id}')">×</button>
        </div>
      </div>`;
    }
    return `<div class="p1zone">
      <div class="zlabel">${z.label}</div>
      <div class="swatch-grid" id="p1sg-${z.id}">
        ${COLORS.map(c => `<div class="swatch ${c.hex === '#FFFFFF' ? 'ws' : ''}"
          style="background:${c.hex}" title="${c.name}"
          onclick="pickColor('${z.id}','${c.hex}')"></div>`).join('')}
        <div class="csw-wrap">
          <div class="csw" onclick="p1ToggleCPop('${z.id}')"></div>
          <div class="cpop" id="p1cpop-${z.id}">
            <div class="cpop-lbl">Custom color</div>
            <div class="cpop-prev" id="p1cprev-${z.id}" style="background:#1A4A2E"></div>
            <div class="cpop-row">
              <input type="color" id="p1cn-${z.id}" value="#1A4A2E" oninput="p1CSync('${z.id}',this.value)">
              <input type="text" class="hexin" id="p1ch-${z.id}" value="#1A4A2E" maxlength="7" placeholder="#000000" oninput="p1CSyncN('${z.id}',this.value)">
            </div>
            <button class="cpop-apply" onclick="p1CApply('${z.id}')">Apply</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

window.clearColor = function (zoneId) {
  delete S.colors[zoneId];
  renderP1Colors();
  refreshFlagPreviews();
  checkStep1();
  syncSidebar();
};

function refreshFlagPreviews() {
  FLAGS.forEach(f => {
    const card = document.getElementById('fc-' + f.id);
    if (!card) return;
    const svg = card.querySelector('svg');
    if (svg) applyColors(svg, S.colors);
  });
}

function checkStep1() {
  const flag = getFlag();
  const fieldOk = !!S.colors['zone-primary'];
  const stripeNeeded = flag?.colorZones.some(z => z.id === 'zone-secondary');
  const ok = !!flag && fieldOk && (!stripeNeeded || !!S.colors['zone-secondary']);
  document.getElementById('s1next').disabled = !ok;
  document.getElementById('s1hint').textContent = ok ? '' : !flag ? 'Pick colors and select a style' : 'Pick colors to continue';
}

window.p1ToggleCPop = function (zid) {
  const p = document.getElementById('p1cpop-' + zid);
  const open = p.classList.contains('open');
  document.querySelectorAll('.cpop').forEach(x => x.classList.remove('open'));
  if (!open) p.classList.add('open');
};
window.p1CSync = (zid, h) => {
  document.getElementById('p1ch-' + zid).value = h;
  document.getElementById('p1cprev-' + zid).style.background = h;
};
window.p1CSyncN = (zid, h) => {
  const c = h.startsWith('#') ? h : '#' + h;
  if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
    document.getElementById('p1cn-' + zid).value = c;
    document.getElementById('p1cprev-' + zid).style.background = c;
  }
};
window.p1CApply = function (zid) {
  const h = document.getElementById('p1ch-' + zid).value;
  const c = h.startsWith('#') ? h : '#' + h;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  document.getElementById('p1cpop-' + zid).classList.remove('open');
  pickColor(zid, c);
};

// ── STEP 2 ────────────────────────────────────────────────
function setupColors() {
  const flag = getFlag();
  if (!flag) return;
  document.getElementById('colorZones').innerHTML = flag.colorZones.map(z => `
    <div>
      <div class="zlabel">${z.label}</div>
      <div class="swatch-grid" id="sg-${z.id}">
        ${COLORS.map(c => `<div class="swatch ${c.hex === '#FFFFFF' ? 'ws' : ''} ${S.colors[z.id] === c.hex ? 'sel' : ''}"
          style="background:${c.hex}" data-hex="${c.hex}" title="${c.name}"
          onclick="pickColor('${z.id}','${c.hex}')"></div>`).join('')}
        <div class="csw-wrap">
          <div class="csw ${!COLORS.find(c => c.hex === S.colors[z.id]) && S.colors[z.id] ? 'sel' : ''}"
            id="csw-${z.id}" onclick="toggleCPop('${z.id}')"></div>
          <div class="cpop" id="cpop-${z.id}">
            <div class="cpop-lbl">Custom color</div>
            <div class="cpop-prev" id="cprev-${z.id}" style="background:${S.colors[z.id] || '#1A4A2E'}"></div>
            <div class="cpop-row">
              <input type="color" id="cn-${z.id}" value="${S.colors[z.id] || '#1A4A2E'}" oninput="cSync('${z.id}',this.value)">
              <input type="text" class="hexin" id="ch-${z.id}" value="${S.colors[z.id] || '#1A4A2E'}" maxlength="7" placeholder="#000000" oninput="cSyncN('${z.id}',this.value)">
            </div>
            <button class="cpop-apply" onclick="cApply('${z.id}')">Apply</button>
          </div>
        </div>
      </div>
    </div>`).join('');
  document.getElementById('colorPrevName').textContent = flag.name;
  refreshColorPrev();
  checkColors();
  document.addEventListener('click', closePops, { capture: true });
}

window.pickColor = function (zid, hex) {
  S.colors[zid] = hex;
  document.querySelectorAll(`#sg-${zid} .swatch`).forEach(s => s.classList.toggle('sel', s.dataset.hex === hex));
  const cs = document.getElementById('csw-' + zid);
  if (cs) cs.classList.toggle('sel', !COLORS.some(c => c.hex === hex));
  refreshColorPrev();
  checkColors();
  renderP1Colors();
  refreshFlagPreviews();
  checkStep1();
  syncSidebar();
  markDirty();
};

function refreshColorPrev() {
  const flag = getFlag();
  if (!flag) return;
  const box = document.getElementById('colorPrev');
  box.innerHTML = `<svg viewBox="${flag.viewBox || '0 0 7519 4669'}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${flag.svgContent}</svg>`;
  applyColors(box.querySelector('svg'), S.colors);
}

function checkColors() {
  const flag = getFlag();
  if (!flag) return;
  document.getElementById('s2next').disabled = !flag.colorZones.every(z => S.colors[z.id]);
}

window.toggleCPop = function (zid) {
  const p = document.getElementById('cpop-' + zid);
  const open = p.classList.contains('open');
  document.querySelectorAll('.cpop').forEach(x => x.classList.remove('open'));
  if (!open) p.classList.add('open');
};

function closePops(e) {
  if (!e.target.closest('.csw-wrap')) document.querySelectorAll('.cpop').forEach(x => x.classList.remove('open'));
}

window.cSync = (z, h) => { document.getElementById('ch-' + z).value = h; document.getElementById('cprev-' + z).style.background = h; };
window.cSyncN = (z, h) => { const c = h.startsWith('#') ? h : '#' + h; if (/^#[0-9A-Fa-f]{6}$/.test(c)) { document.getElementById('cn-' + z).value = c; document.getElementById('cprev-' + z).style.background = c; } };
window.cApply = function (z) {
  const h = document.getElementById('ch-' + z).value;
  const c = h.startsWith('#') ? h : '#' + h;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  document.querySelectorAll(`#sg-${z} .swatch`).forEach(s => s.classList.remove('sel'));
  document.getElementById('csw-' + z).classList.add('sel');
  document.getElementById('cpop-' + z).classList.remove('open');
  pickColor(z, c);
};

// ── STEP 3 ────────────────────────────────────────────────
window.handleUpload = async function (e) {
  const files = Array.from(e.target.files);
  e.target.value = '';

  for (const file of files) {
    const localSrc = await new Promise(res => {
      const r = new FileReader();
      r.onload = ev => res(ev.target.result);
      r.readAsDataURL(file);
    });
    const tempId = 'tmp-' + Date.now();
    S.library.push({ id: tempId, name: file.name.replace(/\.[^.]+$/, ''), src: localSrc, uploading: true });
    renderLib();
    renderVarStrip();
    syncSidebar();

    try {
      await ensureProject();
      const logo = await uploadLogo(S.projectId, file);
      const idx = S.library.findIndex(l => l.id === tempId);
      if (idx !== -1) S.library[idx] = logo;
    } catch (err) {
      console.error('Logo upload failed', err);
      S.library = S.library.filter(l => l.id !== tempId);
    }
    renderLib();
    renderVarStrip();
    syncSidebar();
  }
};

function renderLib() {
  const g = document.getElementById('libGrid');
  if (!S.library.length) { g.innerHTML = '<div class="lib-empty">No logos yet</div>'; return; }
  g.innerHTML = S.library.map(l => `
    <div class="lib-item ${l.uploading ? 'uploading' : ''}" id="li-${l.id}" draggable="${!l.uploading}"
      ondragstart="dragStart(event,'${l.id}')" ondragend="dragEnd('${l.id}')">
      <img src="${l.src}" alt="${l.name}">
      <div class="lib-item-name">${l.uploading ? '↑ uploading…' : l.name}</div>
      ${l.uploading ? '' : `<button class="lib-del" onclick="delLogo('${l.id}')">×</button>`}
    </div>`).join('');
}

window.delLogo = async function (id) {
  const logo = S.library.find(l => l.id === id);
  S.library = S.library.filter(l => l.id !== id);
  [S.baseAssignment, ...S.variations.map(v => v.assignment), ...S.variations.map(v => v.backAssignment || {})].forEach(a => {
    Object.keys(a).forEach(z => {
      const val = a[z];
      const lid = typeof val === 'string' ? val : val?.id;
      if (lid === id) delete a[z];
    });
  });
  hideZoneToolbar();
  renderLib();
  renderVarStrip();
  renderDropZones('baseWrap', 'baseSvg', S.baseAssignment);
  syncSidebar();
  if (logo?.storagePath) {
    try { await deleteLogo(logo.storagePath, logo.id); } catch (err) { console.error('Storage delete failed', err); }
  }
};

window.dragStart = function (e, id) {
  setDragLogoId(id);
  e.dataTransfer.effectAllowed = 'copy';
  document.getElementById('li-' + id)?.classList.add('dragging');
};
window.dragEnd = function (id) { document.getElementById('li-' + id)?.classList.remove('dragging'); };

function setupLibrary() {
  const flag = getFlag();
  if (!flag) return;
  const svg = document.getElementById('baseSvg');
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  svg.innerHTML = flag.svgContent;
  applyColors(svg, S.colors);
  renderLib();
  renderDropZones('baseWrap', 'baseSvg', S.baseAssignment);
}

// ── Zone toolbar (shared singleton) ───────────────────────
let _activeZone = null; // { dz, assignment, zoneId, wrapId, svgId, face }

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
    <input type="file" id="dzReplaceFile" accept="image/*" style="display:none">`;
  document.body.appendChild(t);

  document.getElementById('dzTbRemove').addEventListener('click', () => {
    if (!_activeZone) return;
    const { assignment, zoneId, wrapId, svgId, face } = _activeZone;
    delete assignment[zoneId];
    hideZoneToolbar();
    renderDropZones(wrapId, svgId, assignment, face);
    if (wrapId === 'varWrap') { refreshVarThumbs(); markDirty(); }
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
    await ensureProject();
    try {
      const logo = await uploadLogo(S.projectId, file);
      S.library.push(logo);
      assignment[zoneId] = { id: logo.id, x: existing?.x ?? 50, y: existing?.y ?? 50, w: existing?.w ?? 80 };
      hideZoneToolbar();
      renderLib();
      renderVarStrip();
      renderDropZones(wrapId, svgId, assignment, face);
      if (wrapId === 'varWrap') { refreshVarThumbs(); markDirty(); }
    } catch (err) { console.error('Upload failed', err); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#dzToolbar') && !e.target.closest('.dz-logo-wrap')) hideZoneToolbar();
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
          <img src="${l.src}" alt="${l.name}">
        </div>`).join('') + `<div class="dz-lp-upload" id="dzLpUpload">+ Upload</div>`
    : `<div class="dz-lp-upload" id="dzLpUpload">+ Upload</div>`;

  picker.querySelectorAll('.dz-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      const lid = el.dataset.lid;
      assignment[zoneId] = { id: lid, x: existing?.x ?? 50, y: existing?.y ?? 50, w: existing?.w ?? 80 };
      hideZoneToolbar();
      renderDropZones(wrapId, svgId, assignment, face);
      if (wrapId === 'varWrap') { refreshVarThumbs(); markDirty(); }
    });
  });
  picker.querySelector('#dzLpUpload')?.addEventListener('click', () => {
    document.getElementById('dzReplaceFile').click();
  });
}

function showZoneToolbar(dz, openPicker = false) {
  ensureToolbar();
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

function hideZoneToolbar() {
  const tb = document.getElementById('dzToolbar');
  if (tb) tb.style.display = 'none';
  const picker = document.getElementById('dzLibPicker');
  if (picker) picker.style.display = 'none';
  if (_activeZone?.dz) _activeZone.dz.classList.remove('selected');
  _activeZone = null;
}

// ── Drop zones ─────────────────────────────────────────────
function renderDropZones(wrapId, svgId, assignment, face = 'front') {
  const flag = getFlag();
  if (!flag) return;
  const wrap = document.getElementById(wrapId);
  wrap.querySelectorAll('.dzone').forEach(d => d.remove());
  const svg = document.getElementById(svgId);
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
  // Match wrap aspect ratio to viewBox so the SVG fills it exactly — no letterboxing
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

    // Centre guides (always present)
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
        if (_activeZone?.dz === dz) { hideZoneToolbar(); return; }
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
        if (_activeZone?.dz === dz) { hideZoneToolbar(); return; }
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
      if (wrapId === 'varWrap') { refreshVarThumbs(); markDirty(); }
    });

    wrap.appendChild(dz);
  });
}

function setupLogoInteraction(logoWrap, resizeHandle, dz, assignment, zoneId, wrapId, svgId, face) {
  // ── Drag to reposition ────────────────────────────────────
  let dragging = false, startPX, startPY, startX, startY;

  logoWrap.addEventListener('pointerdown', e => {
    if (e.target === resizeHandle) return;
    dragging = true;
    dz.classList.add('dz-adjusting');
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

    // Snap to centre guides within 5 px
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
    const nx = parseFloat(logoWrap.style.left);
    const ny = parseFloat(logoWrap.style.top);
    const prev = getLogoData(assignment, zoneId) || {};
    assignment[zoneId] = { ...prev, x: nx, y: ny };
    if (wrapId === 'varWrap') { refreshVarThumbs(); markDirty(); }
  });

  // ── Resize via corner handle ──────────────────────────────
  let resizing = false, rStartX, rStartW, rDzW;

  resizeHandle.addEventListener('pointerdown', e => {
    resizing = true;
    dz.classList.add('dz-adjusting');
    resizeHandle.setPointerCapture(e.pointerId);
    rStartX = e.clientX;
    rStartW = parseFloat(logoWrap.style.width);
    rDzW    = dz.getBoundingClientRect().width;
    e.stopPropagation();
    e.preventDefault();
  });

  resizeHandle.addEventListener('pointermove', e => {
    if (!resizing) return;
    const delta = (e.clientX - rStartX) / rDzW * 100 * 2; // ×2 because centred
    const nw = Math.max(15, Math.min(100, rStartW + delta));
    logoWrap.style.width = nw + '%';
  });

  resizeHandle.addEventListener('pointerup', () => {
    if (!resizing) return;
    resizing = false;
    dz.classList.remove('dz-adjusting');
    const nw = parseFloat(logoWrap.style.width);
    const prev = getLogoData(assignment, zoneId) || {};
    assignment[zoneId] = { ...prev, w: nw };
    if (wrapId === 'varWrap') { refreshVarThumbs(); markDirty(); }
  });
}

// ── STEP 4 ────────────────────────────────────────────────
function updateFaceTabs() {
  const single = document.getElementById('singleCanvas');
  const dual   = document.getElementById('dualCanvas');
  if (single) single.style.display = S.sameLogoOnBothSides ? '' : 'none';
  if (dual)   dual.style.display   = S.sameLogoOnBothSides ? 'none' : '';
}

window.resolveEdit = async function () {
  const v = S.variations.find(v => v.id === S.activeVarId);
  if (!v || !S.projectId) return;
  try {
    await resolveFeedback(S.projectId, 'flags', v.id);
    const fb = S.feedback?.find(f => f.variation_id === v.id);
    if (fb) fb.resolved = true;
    renderVarList();
    renderVarCanvas();
  } catch (err) {
    console.error('Could not resolve feedback:', err);
  }
};

window.setFace = function (face) {
  activeFace = face;
  updateFaceTabs();
  renderVarCanvas();
};

let _flagZoom = 100;

function applyFlagZoom(pct) {
  _flagZoom = pct;
  const wrap = document.getElementById('flagZoomWrap');
  const label = document.getElementById('flagZoomValue');
  const reset = document.getElementById('flagZoomReset');
  if (wrap) wrap.style.width = pct + '%';
  if (label) label.textContent = pct + '%';
  if (reset) reset.style.display = pct === 100 ? 'none' : '';
}

window.setFlagZoom = function (val) {
  const pct = Math.max(40, Math.min(400, parseInt(val, 10) || 100));
  applyFlagZoom(pct);
};

(function wireFlagCanvasZoom() {
  const setup = () => {
    const scroll = document.getElementById('flagCanvasScroll');
    if (!scroll || scroll.__zoomWired) return;
    scroll.__zoomWired = true;
    scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const wrap = document.getElementById('flagZoomWrap');
      if (!wrap) return;

      const before = wrap.getBoundingClientRect();
      if (!before.width || !before.height) return;
      const fracX = (e.clientX - before.left) / before.width;
      const fracY = (e.clientY - before.top)  / before.height;

      const oldZoom = _flagZoom;
      const raw = -e.deltaY * 0.005;
      const factor = 1 + Math.max(-0.25, Math.min(0.25, raw));
      const newZoom = Math.max(40, Math.min(400, Math.round(oldZoom * factor)));
      if (newZoom === oldZoom) return;
      applyFlagZoom(newZoom);

      const after = wrap.getBoundingClientRect();
      const targetX = after.left + fracX * after.width;
      const targetY = after.top  + fracY * after.height;
      scroll.scrollLeft += targetX - e.clientX;
      scroll.scrollTop  += targetY - e.clientY;
    }, { passive: false });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();

window.toggleDiffSides = function (checked) {
  S.sameLogoOnBothSides = !checked;
  activeFace = 'front';
  updateFaceTabs();
  renderVarCanvas();
};

function setupVariations() {
  if (!S.variations.length) {
    S.variations.push({ id: 'v' + Date.now(), name: 'Variation 1', assignment: { ...S.baseAssignment }, backAssignment: {} });
  }
  S.variations.forEach(v => { if (!v.backAssignment) v.backAssignment = {}; });
  if (!S.activeVarId) S.activeVarId = S.variations[0].id;
  activeFace = 'front';
  const cb = document.getElementById('diffSidesCheck');
  if (cb) cb.checked = !S.sameLogoOnBothSides;
  updateFaceTabs();
  renderVarList();
  renderVarCanvas();
  renderVarStrip();
  document.getElementById('saveDesignsBtn')?.classList.toggle('dirty', isDirty);
  if (S.projectId) {
    getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderVarList(); renderVarCanvas(); }).catch(() => {});
  }
}

window.addVariation = function () {
  const n = S.variations.length + 1;
  const nv = { id: 'v' + Date.now(), name: 'Variation ' + n, assignment: {}, backAssignment: {} };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  renderVarList();
  renderVarCanvas();
  syncSidebar();
  markDirty();
};

window.dupVar = function (id) {
  const src = S.variations.find(v => v.id === id);
  if (!src) return;
  const nv = { id: 'v' + Date.now(), name: src.name + ' copy', assignment: { ...src.assignment }, backAssignment: { ...(src.backAssignment || {}) } };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  renderVarList();
  renderVarCanvas();
  syncSidebar();
  markDirty();
};

window.delVar = function (id) {
  if (S.variations.length <= 1) return;
  S.variations = S.variations.filter(v => v.id !== id);
  if (S.activeVarId === id) S.activeVarId = S.variations[0].id;
  renderVarList();
  renderVarCanvas();
  syncSidebar();
  markDirty();
};

window.selectVar = function (id) { S.activeVarId = id; renderVarList(); renderVarCanvas(); };
window.renameVar = function (id, name) {
  const v = S.variations.find(v => v.id === id);
  if (v) v.name = name;
  if (S.activeVarId === id) document.getElementById('activeVarName').textContent = name;
  markDirty();
};

window.setVarQty = function (id, val) {
  const v = S.variations.find(v => v.id === id);
  if (!v) return;
  const n = Math.max(1, parseInt(val, 10) || 1);
  v.qty = n;
  markDirty();
};

function renderVarList() {
  document.getElementById('varList').innerHTML = S.variations.map(v => {
    const fb = S.feedback?.find(f => f.variation_id === v.id);
    const fbClass = fb?.status === 'needs_edits' && !fb?.resolved ? ' needs-edits'
      : fb?.status === 'approved' ? ' approved' : '';
    const statusTile = fb?.status === 'approved'
      ? '<span class="var-status-tile approved">✓ Approved</span>'
      : (fb?.status === 'needs_edits' && !fb?.resolved)
        ? '<span class="var-status-tile needs-edits">Needs edits</span>'
        : '<span class="var-status-tile not-reviewed">Not reviewed</span>';
    const qty = v.qty ?? 1;
    return `
    <div class="var-card${v.id === S.activeVarId ? ' active' : ''}${fbClass}" onclick="selectVar('${v.id}')">
      <div class="var-card-left">
        <div class="vthumb" id="vt-${v.id}"></div>
        <div style="display:flex;flex-direction:column;gap:3px;min-width:0;flex:1">
          <input class="vname" value="${esc(v.name)}" onclick="event.stopPropagation()"
            onchange="renameVar('${v.id}',this.value)">
          ${statusTile}
          <div class="var-qty-row" onclick="event.stopPropagation()">
            <label class="var-qty-label">Qty</label>
            <input class="var-qty-input" type="number" min="1" step="1" value="${qty}"
              onchange="setVarQty('${v.id}', this.value)">
          </div>
        </div>
      </div>
      <div class="var-btns">
        <button class="vbtn" title="Duplicate" onclick="event.stopPropagation();dupVar('${v.id}')">⧉</button>
        <button class="vbtn" title="Delete" onclick="event.stopPropagation();delVar('${v.id}')" ${S.variations.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>
    </div>`;
  }).join('');
  refreshVarThumbs();
}

function refreshVarThumbs() {
  S.variations.forEach(v => {
    const el = document.getElementById('vt-' + v.id);
    if (!el) return;
    renderInto(el, v.assignment, 'front');
  });
}

function renderVarCanvas() {
  const v = S.variations.find(v => v.id === S.activeVarId);
  if (!v) return;
  document.getElementById('activeVarName').textContent = v.name;
  const flag = getFlag();
  if (!flag) return;
  if (!v.backAssignment) v.backAssignment = {};

  updateFaceTabs();

  if (S.sameLogoOnBothSides) {
    document.getElementById('varSvg').setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
    document.getElementById('varWrap').querySelectorAll('.dzone').forEach(d => d.remove());
    renderDropZones('varWrap', 'varSvg', v.assignment, 'front');
  } else {
    const vb = flag.viewBox || '0 0 7519 4669';
    document.getElementById('varSvgFront').setAttribute('viewBox', vb);
    document.getElementById('varWrapFront').querySelectorAll('.dzone').forEach(d => d.remove());
    renderDropZones('varWrapFront', 'varSvgFront', v.assignment, 'front');

    document.getElementById('varSvgBack').setAttribute('viewBox', vb);
    document.getElementById('varWrapBack').querySelectorAll('.dzone').forEach(d => d.remove());
    renderDropZones('varWrapBack', 'varSvgBack', v.backAssignment, 'back');
  }

  const fb = S.feedback?.find(f => f.variation_id === v.id);
  const noteEl = document.getElementById('varEditNote');
  const noteTextEl = document.getElementById('varEditNoteText');
  const resolveBtn = document.getElementById('varEditResolveBtn');
  const resolvedTag = document.getElementById('varEditResolvedTag');
  if (noteEl && noteTextEl) {
    if (fb?.status === 'needs_edits') {
      noteTextEl.textContent = fb.note || 'Client requested edits for this variation.';
      noteEl.style.display = '';
      noteEl.classList.toggle('resolved', !!fb.resolved);
      if (resolveBtn) resolveBtn.style.display = fb.resolved ? 'none' : '';
      if (resolvedTag) resolvedTag.style.display = fb.resolved ? '' : 'none';
    } else {
      noteEl.style.display = 'none';
    }
  }
}

function renderVarStrip() {
  const strip = document.getElementById('varStrip');
  const uploadBtn = strip.querySelector('.var-upload-btn');
  const fileInput = strip.querySelector('#varFile');
  strip.innerHTML = '';
  if (uploadBtn) strip.appendChild(uploadBtn);
  if (fileInput) strip.appendChild(fileInput);
  S.library.forEach(l => {
    const el = document.createElement('div');
    el.className = `var-lib-item${l.uploading ? ' uploading' : ''}`;
    el.draggable = !l.uploading;
    el.title = l.name;
    el.setAttribute('ondragstart', `dragStart(event,'${l.id}')`);
    el.setAttribute('ondragend', `dragEnd('${l.id}')`);
    el.innerHTML = `<img src="${l.src}" alt="${l.name}">${l.uploading ? '' : `<button class="var-lib-del" title="Delete" onclick="event.stopPropagation();delLogo('${l.id}')">×</button>`}`;
    strip.appendChild(el);
  });
}

// ── STEP 5 ────────────────────────────────────────────────
function setupGallery() {
  S.gIndex = 0;
  gFace = 'front';
  const dual = !S.sameLogoOnBothSides;
  document.getElementById('gSingleView').style.display = dual ? 'none' : '';
  document.getElementById('gDualView').style.display  = dual ? '' : 'none';
  document.getElementById('gFtFront')?.classList.add('active');
  document.getElementById('gFtBack')?.classList.remove('active');
  if (S.shareToken) {
    const url = `${window.location.origin}/review.html?token=${S.shareToken}`;
    const input = document.getElementById('shareLinkInput');
    if (input) input.value = url;
  }
  if (S.projectId) {
    getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderGSlide(); }).catch(() => {});
    if (feedbackChannel) feedbackChannel.unsubscribe();
    feedbackChannel = supabase
      .channel('feedback-' + S.projectId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_feedback', filter: `project_id=eq.${S.projectId}` },
        () => { getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderGSlide(); }).catch(() => {}); }
      )
      .subscribe();
  }
  renderGStrip();
  renderGSlide();
}

window.setGFace = function (face) {
  gFace = face;
  document.getElementById('gFtFront')?.classList.toggle('active', face === 'front');
  document.getElementById('gFtBack')?.classList.toggle('active', face === 'back');
  renderGSlide();
};

function renderGStrip() {
  document.getElementById('gStrip').innerHTML = S.variations.map((v, i) => `
    <div class="gthumb ${i === S.gIndex ? 'active' : ''}" id="gt-${i}" onclick="gGoTo(${i})">
      <div id="gti-${i}" style="width:100%;height:100%"></div>
    </div>`).join('');
  S.variations.forEach((v, i) => {
    const el = document.getElementById('gti-' + i);
    if (el) renderInto(el, v.assignment, 'front');
  });
}

function renderGSlide() {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const flag = getFlag();
  const atStart = S.gIndex === 0;
  const atEnd   = S.gIndex === S.variations.length - 1;
  const count   = `${S.gIndex + 1} / ${S.variations.length}`;

  if (S.sameLogoOnBothSides) {
    renderInto(document.getElementById('gFlag'), v.assignment, gFace);
    document.getElementById('gName').textContent  = v.name;
    document.getElementById('gCount').textContent = count;
    document.getElementById('gPrev').disabled = atStart;
    document.getElementById('gNext').disabled = atEnd;
  } else {
    renderInto(document.getElementById('gFlagFront'), v.assignment,          'front');
    renderInto(document.getElementById('gFlagBack'),  v.backAssignment || {}, 'back');
    document.getElementById('gNameD').textContent  = v.name;
    document.getElementById('gCountD').textContent = count;
    document.getElementById('gPrevD').disabled = atStart;
    document.getElementById('gNextD').disabled = atEnd;
  }

  document.querySelectorAll('.gthumb').forEach((t, i) => t.classList.toggle('active', i === S.gIndex));

  const zoneRows = (flag?.logoZones || []).map(z => {
    const lid = v.assignment[z.id];
    const logo = S.library.find(l => l.id === lid);
    return `<div class="drow"><span class="dkey">${z.label}</span><span class="dval">
      ${logo ? `<img src="${logo.src}" style="width:20px;height:20px;object-fit:contain;border-radius:3px">${esc(logo.name)}` : '<span style="color:var(--gray-400)">Empty</span>'}
    </span></div>`;
  }).join('');

  const colorRows = (flag?.colorZones || []).map(z => {
    const hex = S.colors[z.id] || '#ccc';
    const col = COLORS.find(c => c.hex === hex);
    return `<div class="drow"><span class="dkey">${z.label}</span><span class="dval"><span class="dot" style="background:${hex}"></span>${col?.name || hex}</span></div>`;
  }).join('');

  const fbEntry = S.feedback?.find(f => f.variation_id === v.id);
  const fbBadge = fbEntry
    ? (fbEntry.status === 'approved'
        ? '<span class="rv-badge approved">Approved</span>'
        : fbEntry.status === 'needs_edits'
          ? '<span class="rv-badge needs-edits">Needs edits</span>'
          : '<span class="rv-badge pending">Pending</span>')
    : '<span class="rv-badge pending">Pending</span>';

  document.getElementById('gDetails').innerHTML = `
    <div class="drow"><span class="dkey">Style</span><span class="dval">${flag?.name || '—'}</span></div>
    ${colorRows}${zoneRows}
    <div class="drow"><span class="dkey">Review</span><span class="dval">${fbBadge}</span></div>`;
}

window.gNav = function (d) { S.gIndex = Math.max(0, Math.min(S.variations.length - 1, S.gIndex + d)); renderGSlide(); };
window.gGoTo = function (i) { S.gIndex = i; renderGSlide(); };

// ── EXPORT ────────────────────────────────────────────────
function slug(s) { return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''); }

function dl(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const FLAG_DPI = 300;

async function rasterizeSvg(assignment, face) {
  const flag = getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const pxW = vbW;
  const pxH = vbH;
  const svg = makeSvg(assignment, pxW, pxH, face);

  // Inline all external image hrefs so the canvas renderer can paint them
  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const mime = mimeMap[ext] ?? (res.headers.get('content-type') ?? 'image/png').split(';')[0];
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is on failure */ }
  }));

  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = pxW; c.height = pxH;
      c.getContext('2d').drawImage(img, 0, 0, pxW, pxH);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => blob ? resolve({ blob, pxW, pxH }) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

window.expPDF = async function () {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const flag = getFlag();
  if (!flag) return;
  const btn = document.getElementById('expPdf');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const faceAssignment = (gFace === 'back' && !S.sameLogoOnBothSides) ? (v.backAssignment || {}) : v.assignment;
    const { blob } = await rasterizeSvg(faceAssignment, gFace);
    const pngBytes = await blob.arrayBuffer();
    const [, , vbW, vbH] = (flag.viewBox || '0 0 7519 4669').split(' ').map(Number);
    const ptW = (vbW / FLAG_DPI) * 72;
    const ptH = (vbH / FLAG_DPI) * 72;
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([ptW, ptH]);
    const pngImage = await pdfDoc.embedPng(pngBytes);
    page.drawImage(pngImage, { x: 0, y: 0, width: ptW, height: ptH });
    const pdfBytes = await pdfDoc.save();
    dl(URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' })),
      slug(v.name) + (gFace === 'back' ? '-back' : '') + '.pdf');
  } catch (err) {
    console.error('PDF export failed', err);
    alert('PDF export failed.');
  } finally {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PDF';
    btn.disabled = false;
  }
};

window.expPNG = async function () {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const btn = document.getElementById('expPng');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const faceAssignment = (gFace === 'back' && !S.sameLogoOnBothSides) ? (v.backAssignment || {}) : v.assignment;
    const { blob } = await rasterizeSvg(faceAssignment, gFace);
    dl(URL.createObjectURL(blob), slug(v.name) + (gFace === 'back' ? '-back' : '') + '.png');
  } catch (err) {
    console.error('PNG export failed', err);
    alert('PNG export failed.');
  } finally {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PNG';
    btn.disabled = false;
  }
};

window.expAllPNG = async function () {
  for (const v of S.variations) {
    try {
      const { blob } = await rasterizeSvg(v.assignment, 'front');
      dl(URL.createObjectURL(blob), slug(v.name) + '.png');
      await new Promise(r => setTimeout(r, 400));
      if (!S.sameLogoOnBothSides) {
        const { blob: blobB } = await rasterizeSvg(v.backAssignment || {}, 'back');
        dl(URL.createObjectURL(blobB), slug(v.name) + '-back.png');
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) { console.error('PNG export failed for', v.name, err); }
  }
};

// ── PRINT DOWNLOAD (zip of front+back per variation) ─────────
async function rasterizeForPrint(assignment, face) {
  // Same as rasterizeSvg but strips the `Bleed` group (the grey print-bleed area)
  // from the SVG before drawing, since the print file shouldn't include it.
  const flag = getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const pxW = vbW;
  const pxH = vbH;
  const svg = makeSvg(assignment, pxW, pxH, face);

  // Remove the grey bleed area for the print output
  for (const gid of ['Bleed', 'bleed']) {
    const el = svg.querySelector(`#${gid}`);
    if (el) el.parentNode?.removeChild(el);
  }

  // Inline external image hrefs as data URIs (so canvas can paint them)
  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml' };
      const mime = mimeMap[ext] ?? (res.headers.get('content-type') ?? 'image/png').split(';')[0];
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is on failure */ }
  }));

  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = pxW; c.height = pxH;
      c.getContext('2d').drawImage(img, 0, 0, pxW, pxH);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => blob ? resolve({ blob, pxW, pxH }) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

async function pngBlobToPdfBlob(pngBlob, vbW, vbH) {
  const FLAG_DPI = 300;
  const ptW = (vbW / FLAG_DPI) * 72;
  const ptH = (vbH / FLAG_DPI) * 72;
  const pngBytes = await pngBlob.arrayBuffer();
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([ptW, ptH]);
  const png = await pdfDoc.embedPng(pngBytes);
  page.drawImage(png, { x: 0, y: 0, width: ptW, height: ptH });
  return new Blob([await pdfDoc.save()], { type: 'application/pdf' });
}

window.downloadForPrint = async function (format) {
  if (!S.variations.length) { alert('No variations to export.'); return; }
  if (format !== 'pdf' && format !== 'png') return;

  const btnPdf = document.getElementById('expPrintPdfBtn');
  const btnPng = document.getElementById('expPrintPngBtn');
  const status = document.getElementById('expPrintStatus');
  const activeBtn = format === 'pdf' ? btnPdf : btnPng;
  const originalLabel = activeBtn?.textContent;
  if (btnPdf) btnPdf.disabled = true;
  if (btnPng) btnPng.disabled = true;
  if (activeBtn) activeBtn.textContent = 'Preparing…';
  const setStatus = msg => { if (status) status.textContent = msg; };

  try {
    const zip = new JSZip();
    const [, , vbW, vbH] = (getFlag()?.viewBox || '0 0 7519 4669').split(' ').map(Number);

    for (let i = 0; i < S.variations.length; i++) {
      const v = S.variations[i];
      setStatus(`Rendering ${i + 1} of ${S.variations.length}: ${v.name}…`);

      const frontAssign = v.assignment;
      const backAssign  = S.sameLogoOnBothSides ? v.assignment : (v.backAssignment || {});

      const { blob: frontPng } = await rasterizeForPrint(frontAssign, 'front');
      const { blob: backPng }  = await rasterizeForPrint(backAssign,  'back');

      const safe = slug(v.name) || 'variation-' + (i + 1);
      if (format === 'png') {
        zip.file(`${safe}/${safe}-front.png`, frontPng);
        zip.file(`${safe}/${safe}-back.png`,  backPng);
      } else {
        const frontPdf = await pngBlobToPdfBlob(frontPng, vbW, vbH);
        const backPdf  = await pngBlobToPdfBlob(backPng,  vbW, vbH);
        zip.file(`${safe}/${safe}-front.pdf`, frontPdf);
        zip.file(`${safe}/${safe}-back.pdf`,  backPdf);
      }
    }

    setStatus('Zipping…');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const flag = getFlag();
    const zipName = `flags-${slug(flag?.name || S.flagId || 'export')}-${format}.zip`;
    dl(URL.createObjectURL(zipBlob), zipName);
    setStatus(`Done — ${S.variations.length} variation${S.variations.length === 1 ? '' : 's'} exported.`);
  } catch (err) {
    console.error('Print export failed', err);
    setStatus('Export failed: ' + (err.message || err));
    alert('Print export failed. See console for details.');
  } finally {
    if (btnPdf) btnPdf.disabled = false;
    if (btnPng) btnPng.disabled = false;
    if (activeBtn && originalLabel) activeBtn.textContent = originalLabel;
  }
};

// ── SHARE ─────────────────────────────────────────────────
window.openShareModal = async function () {
  const status = document.getElementById('shareStatus');
  const btn = document.querySelector('#shareSection .btn.primary');
  if (!S.projectId) { status.textContent = 'Save your project first.'; return; }
  btn.disabled = true;
  status.textContent = 'Generating link…';
  try {
    if (!S.shareToken) {
      S.shareToken = await generateShareToken(S.projectId);
    }
    const url = `${window.location.origin}/review.html?token=${S.shareToken}`;
    document.getElementById('shareLinkInput').value = url;
    status.textContent = '';

    const emailInput = document.getElementById('shareEmailInput');
    emailInput.value = '';
    loadOrderIntake(S.projectId).then(intake => {
      if (intake?.contact_email) emailInput.value = intake.contact_email;
    }).catch(() => {});

    document.getElementById('shareNotifyStatus').textContent = '';
    document.getElementById('shareModalOverlay').style.display = 'flex';
  } catch (err) {
    console.error(err);
    status.textContent = 'Could not generate link.';
  } finally {
    btn.disabled = false;
  }
};

window.closeShareModal = function (e) {
  if (e && e.target !== document.getElementById('shareModalOverlay')) return;
  document.getElementById('shareModalOverlay').style.display = 'none';
};

window.copyShareLink = function () {
  const url = document.getElementById('shareLinkInput').value;
  navigator.clipboard.writeText(url).then(() => {
    const status = document.getElementById('shareNotifyStatus');
    status.textContent = 'Link copied!';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
};

window.notifyCustomer = async function () {
  const email = document.getElementById('shareEmailInput').value.trim();
  const url = document.getElementById('shareLinkInput').value;
  const status = document.getElementById('shareNotifyStatus');
  if (!email) { status.textContent = 'Enter an email address.'; return; }
  const btn = document.querySelector('.share-modal .btn.primary');
  btn.disabled = true;
  status.textContent = 'Sending…';
  try {
    const intake = await loadOrderIntake(S.projectId).catch(() => null);
    await sendProofReady({
      contactName: intake?.contact_name || '',
      contactEmail: email,
      eventName: intake?.event_name || 'your event',
      reviewUrl: url,
    });
    status.style.color = 'var(--green, #2d9d5c)';
    status.textContent = 'Notification sent!';
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 3000);
  } catch (err) {
    console.error(err);
    status.style.color = 'var(--red, #c0392b)';
    status.textContent = `Failed to send: ${err.message || err}`;
  } finally {
    btn.disabled = false;
  }
};

// ── SAVE ──────────────────────────────────────────────────
window.saveDraft = async function () {
  const btn = document.getElementById('saveDraftBtn');
  const status = document.getElementById('saveStatus');
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    if (!S.projectId) {
      S.projectId = await createProject(S.projectName);
      history.replaceState(null, '', '?project=' + S.projectId);
    } else if (S.projectName !== undefined) {
      await updateProject(S.projectId, { name: S.projectName || null });
    }
    await saveFlagConfig(S.projectId, S);
    markClean();
    resolveFeedback(S.projectId, 'flags')
      .then(() => getFeedback(S.projectId, 'flags'))
      .then(fb => { S.feedback = fb; renderVarList(); renderVarCanvas(); })
      .catch(() => {});
    status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 3000);
  } catch (err) {
    console.error(err);
    status.textContent = 'Save failed';
  } finally {
    btn.disabled = false;
  }
};

// ── PROJECT NAME ──────────────────────────────────────────
window.setProjectName = function (val) {
  S.projectName = val;
  markDirty();
};

// ── SIDEBAR ───────────────────────────────────────────────
function syncSidebar() {
  const flag = getFlag();
  document.getElementById('sumStyle').textContent = flag?.name || '—';
  document.getElementById('sumStyle').style.color = flag ? 'var(--black)' : 'var(--gray-400)';
  const z0 = flag?.colorZones[0];
  const z1 = flag?.colorZones[1];
  const h0 = z0 ? S.colors[z0.id] : null, h1 = z1 ? S.colors[z1.id] : null;
  const c0 = COLORS.find(c => c.hex === h0), c1 = COLORS.find(c => c.hex === h1);
  const sp = document.getElementById('sumP');
  sp.innerHTML = h0 ? `<span class="dot" style="background:${h0}"></span>${c0?.name || h0}` : '—';
  sp.style.color = h0 ? 'var(--black)' : 'var(--gray-400)';
  const ss = document.getElementById('sumS');
  ss.innerHTML = h1 ? `<span class="dot" style="background:${h1}"></span>${c1?.name || h1}` : (z1 ? '—' : 'n/a');
  ss.style.color = h1 ? 'var(--black)' : 'var(--gray-400)';
  document.getElementById('sumVC').textContent = S.variations.length || '—';
  document.getElementById('sumVC').style.color = S.variations.length ? 'var(--black)' : 'var(--gray-400)';
  document.getElementById('sumLC').textContent = S.library.length || '—';
  document.getElementById('sumLC').style.color = S.library.length ? 'var(--black)' : 'var(--gray-400)';
}

// ── INIT ──────────────────────────────────────────────────
await loadAllFlags(FLAGS);
renderFlagGrid();
renderP1Colors();

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (_urlProject) {
  try {
    const [project, logos, flagCfg, intake] = await Promise.all([
      loadProject(_urlProject),
      loadLogosForProject(_urlProject),
      loadFlagConfig(_urlProject).catch(() => null),
      loadOrderIntake(_urlProject).catch(() => null),
    ]);
    S.projectId = project.id;
    S.projectName = project.name || '';
    S.shareToken = project.share_token || null;
    S.library = logos;
    if (flagCfg) {
      S.flagId = flagCfg.flag_id;
      S.colors = flagCfg.colors || {};
      S.variations = (flagCfg.variations || []).map(v => ({ ...v, backAssignment: v.backAssignment || {} }));
      S.baseAssignment = flagCfg.base_assignment || {};
      S.sameLogoOnBothSides = flagCfg.same_logo_on_both_sides ?? true;
      S.activeVarId = S.variations[0]?.id || null;
    } else if (intake) {
      // Pre-populate from customer order when no draft exists yet
      if (intake.flag_style) S.flagId = intake.flag_style;
      const colors = Array.isArray(intake.flag_colors) ? intake.flag_colors : [];
      if (colors[0]?.hex) S.colors['zone-primary'] = colors[0].hex;
      if (colors[1]?.hex) S.colors['zone-secondary'] = colors[1].hex;
    }
    document.getElementById('projectNameInput').value = S.projectName;
    if (S.flagId) document.getElementById('fc-' + S.flagId)?.classList.add('selected');
    renderP1Colors();
    refreshFlagPreviews();
    checkStep1();
    syncSidebar();
    if (S.variations.length) goStep(4);
    if (intake) renderCustomerSection(intake);
  } catch (err) {
    console.error('Could not load project', err);
  }
}

function renderCustomerSection(intake) {
  const el = document.getElementById('customerSection');
  if (!el) return;
  const fmt = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
  const addr = [intake.address_line1, intake.address_line2, intake.city, intake.state_province, intake.postal_code, intake.country].filter(Boolean).join(', ');
  const colors = Array.isArray(intake.flag_colors) ? intake.flag_colors : [];
  el.innerHTML = `
    <div class="sdivider"></div>
    <div class="cs-wrap">
      <div class="cs-header" onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.cs-toggle').classList.toggle('open')">
        <span class="cs-title">Customer</span>
        <span class="cs-toggle open">▾</span>
      </div>
      <div class="cs-body">
        <div class="cs-row">
          <span class="cs-label">Event</span>
          <span class="cs-value">${esc(intake.event_name)}${intake.event_date ? ' · ' + fmt(intake.event_date) : ''}</span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Contact</span>
          <span class="cs-value">${esc(intake.contact_name)}<br><span style="color:var(--gray-600)">${esc(intake.contact_email)}</span></span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Ship to</span>
          <span class="cs-value">${esc(addr)}</span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Setup</span>
          <span class="cs-value">${intake.flag_setup === 'different' ? 'Different front &amp; back' : 'Same front &amp; back'}</span>
        </div>
        ${colors.length ? `<div class="cs-row"><span class="cs-label">Colors</span><div class="cs-colors">${colors.map(c => `<div class="cs-swatch" style="background:${safeHex(c.hex || c)}" title="${esc(c.name || c)}"></div>`).join('')}</div></div>` : ''}
        ${intake.design_notes ? `<div class="cs-row"><span class="cs-label">Notes</span><span class="cs-notes">${esc(intake.design_notes)}</span></div>` : ''}
      </div>
    </div>`;
  el.style.display = '';
}
