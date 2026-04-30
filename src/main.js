import './style.css';
import { S, _dragLogoId, setDragLogoId } from './state.js';
import { FLAGS, COLORS } from './data.js';
import { getFlag, applyColors, makeSvg, renderInto } from './render.js';
import { saveDraft as supabaseSaveDraft } from './supabase.js';

// ── NAV ───────────────────────────────────────────────────
function currentStep() {
  return [...document.querySelectorAll('.panel')].findIndex(p => p.classList.contains('visible')) + 1;
}

window.tryGoStep = (n) => { if (n > currentStep()) return; goStep(n); };

window.goStep = function goStep(n) {
  document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('visible', i === n - 1));
  document.querySelectorAll('.step-item').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i === n - 1) s.classList.add('active');
    else if (i < n - 1) s.classList.add('done');
  });
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
      <div class="flag-card-preview"><svg viewBox="${f.viewBox || '0 0 7519 4670'}" preserveAspectRatio="xMidYMid meet">${f.svgContent}</svg></div>
      <div><div class="flag-card-name">${f.name}</div><div class="flag-card-zones">${f.colorZones.map(z => z.label).join(', ')}</div></div>
    </div>`).join('');
}

window.pickFlag = function (id) {
  S.flagId = id;
  S.colors = {};
  document.querySelectorAll('.flag-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('fc-' + id).classList.add('selected');
  document.getElementById('s1next').disabled = false;
  document.getElementById('s1hint').textContent = '';
  syncSidebar();
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
  syncSidebar();
};

function refreshColorPrev() {
  const flag = getFlag();
  if (!flag) return;
  const box = document.getElementById('colorPrev');
  box.innerHTML = `<svg viewBox="${flag.viewBox || '0 0 7519 4670'}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${flag.svgContent}</svg>`;
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
window.handleUpload = function (e) {
  Array.from(e.target.files).forEach(file => {
    const r = new FileReader();
    r.onload = ev => {
      const id = 'l' + Date.now() + Math.random().toString(36).slice(2, 5);
      S.library.push({ id, name: file.name.replace(/\.[^.]+$/, ''), src: ev.target.result });
      renderLib();
      syncSidebar();
    };
    r.readAsDataURL(file);
  });
  e.target.value = '';
};

function renderLib() {
  const g = document.getElementById('libGrid');
  if (!S.library.length) { g.innerHTML = '<div class="lib-empty">No logos yet</div>'; return; }
  g.innerHTML = S.library.map(l => `
    <div class="lib-item" id="li-${l.id}" draggable="true"
      ondragstart="dragStart(event,'${l.id}')" ondragend="dragEnd('${l.id}')">
      <img src="${l.src}" alt="${l.name}">
      <div class="lib-item-name">${l.name}</div>
      <button class="lib-del" onclick="delLogo('${l.id}')">×</button>
    </div>`).join('');
}

window.delLogo = function (id) {
  S.library = S.library.filter(l => l.id !== id);
  [S.baseAssignment, ...S.variations.map(v => v.assignment)].forEach(a => {
    Object.keys(a).forEach(z => { if (a[z] === id) delete a[z]; });
  });
  renderLib();
  renderDropZones('baseWrap', 'baseSvg', S.baseAssignment);
  syncSidebar();
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
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4670');
  svg.innerHTML = flag.svgContent;
  applyColors(svg, S.colors);
  renderLib();
  renderDropZones('baseWrap', 'baseSvg', S.baseAssignment);
}

function renderDropZones(wrapId, svgId, assignment) {
  const flag = getFlag();
  if (!flag) return;
  const wrap = document.getElementById(wrapId);
  wrap.querySelectorAll('.dzone').forEach(d => d.remove());
  const svg = document.getElementById(svgId);
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4670');
  svg.innerHTML = flag.svgContent;
  applyColors(svg, S.colors);
  const cw = wrap.offsetWidth, ch = wrap.offsetHeight;

  flag.logoZones.forEach(zone => {
    const lid = assignment[zone.id];
    const logo = S.library.find(l => l.id === lid);
    const left = (zone.x / 1000) * cw, top = (zone.y / 750) * ch;
    const width = (zone.w / 1000) * cw, height = (zone.h / 750) * ch;

    const dz = document.createElement('div');
    dz.className = 'dzone' + (logo ? ' has-logo' : '');
    dz.dataset.zoneId = zone.id;
    dz.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;

    if (logo) {
      const img = document.createElement('img');
      img.className = 'placed-img';
      img.src = logo.src;
      img.alt = logo.name;
      dz.appendChild(img);
      const clr = document.createElement('button');
      clr.className = 'dz-clr';
      clr.textContent = '×';
      clr.onclick = ev => { ev.stopPropagation(); clearZone(wrapId, svgId, assignment, zone.id); };
      dz.appendChild(clr);
    } else {
      dz.innerHTML = `<div class="dz-icon">+</div><div class="dz-lbl">${zone.label}</div>`;
    }

    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('drag-over');
      const dragId = _dragLogoId;
      if (!dragId) return;
      assignment[zone.id] = dragId;
      setDragLogoId(null);
      renderDropZones(wrapId, svgId, assignment);
      if (wrapId === 'varWrap') refreshVarThumbs();
    });

    wrap.appendChild(dz);
  });
}

function clearZone(wrapId, svgId, assignment, zoneId) {
  delete assignment[zoneId];
  renderDropZones(wrapId, svgId, assignment);
  if (wrapId === 'varWrap') refreshVarThumbs();
}

// ── STEP 4 ────────────────────────────────────────────────
function setupVariations() {
  if (!S.variations.length) {
    S.variations.push({ id: 'v' + Date.now(), name: 'Variation 1', assignment: { ...S.baseAssignment } });
  }
  if (!S.activeVarId) S.activeVarId = S.variations[0].id;
  renderVarList();
  renderVarCanvas();
  renderVarStrip();
}

window.addVariation = function () {
  const n = S.variations.length + 1;
  const nv = { id: 'v' + Date.now(), name: 'Variation ' + n, assignment: {} };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  renderVarList();
  renderVarCanvas();
  syncSidebar();
};

window.dupVar = function (id) {
  const src = S.variations.find(v => v.id === id);
  if (!src) return;
  const nv = { id: 'v' + Date.now(), name: src.name + ' copy', assignment: { ...src.assignment } };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  renderVarList();
  renderVarCanvas();
  syncSidebar();
};

window.delVar = function (id) {
  if (S.variations.length <= 1) return;
  S.variations = S.variations.filter(v => v.id !== id);
  if (S.activeVarId === id) S.activeVarId = S.variations[0].id;
  renderVarList();
  renderVarCanvas();
  syncSidebar();
};

window.selectVar = function (id) { S.activeVarId = id; renderVarList(); renderVarCanvas(); };
window.renameVar = function (id, name) {
  const v = S.variations.find(v => v.id === id);
  if (v) v.name = name;
  if (S.activeVarId === id) document.getElementById('activeVarName').textContent = name;
};

function renderVarList() {
  document.getElementById('varList').innerHTML = S.variations.map(v => `
    <div class="var-card ${v.id === S.activeVarId ? 'active' : ''}" onclick="selectVar('${v.id}')">
      <div class="var-card-left">
        <div class="vthumb" id="vt-${v.id}"></div>
        <input class="vname" value="${v.name}" onclick="event.stopPropagation()"
          onchange="renameVar('${v.id}',this.value)">
      </div>
      <div class="var-btns">
        <button class="vbtn" title="Duplicate" onclick="event.stopPropagation();dupVar('${v.id}')">⧉</button>
        <button class="vbtn" title="Delete" onclick="event.stopPropagation();delVar('${v.id}')" ${S.variations.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>
    </div>`).join('');
  refreshVarThumbs();
}

function refreshVarThumbs() {
  S.variations.forEach(v => {
    const el = document.getElementById('vt-' + v.id);
    if (!el) return;
    renderInto(el, v.assignment);
  });
}

function renderVarCanvas() {
  const v = S.variations.find(v => v.id === S.activeVarId);
  if (!v) return;
  document.getElementById('activeVarName').textContent = v.name;
  const flag = getFlag();
  if (!flag) return;
  document.getElementById('varSvg').setAttribute('viewBox', flag.viewBox || '0 0 7519 4670');
  document.getElementById('varSvg').innerHTML = flag.svgContent;
  applyColors(document.getElementById('varSvg'), S.colors);
  document.getElementById('varWrap').querySelectorAll('.dzone').forEach(d => d.remove());
  renderDropZones('varWrap', 'varSvg', v.assignment);
}

function renderVarStrip() {
  const strip = document.getElementById('varStrip');
  if (!S.library.length) {
    strip.innerHTML = '<span style="font-size:13px;color:var(--gray-400)">Upload logos in step 3 first.</span>';
    return;
  }
  strip.innerHTML = S.library.map(l => `
    <div class="var-lib-item" draggable="true" title="${l.name}"
      ondragstart="dragStart(event,'${l.id}')" ondragend="dragEnd('${l.id}')">
      <img src="${l.src}" alt="${l.name}">
    </div>`).join('');
}

// ── STEP 5 ────────────────────────────────────────────────
function setupGallery() {
  S.gIndex = 0;
  renderGStrip();
  renderGSlide();
}

function renderGStrip() {
  document.getElementById('gStrip').innerHTML = S.variations.map((v, i) => `
    <div class="gthumb ${i === S.gIndex ? 'active' : ''}" id="gt-${i}" onclick="gGoTo(${i})">
      <div id="gti-${i}" style="width:100%;height:100%"></div>
    </div>`).join('');
  S.variations.forEach((v, i) => {
    const el = document.getElementById('gti-' + i);
    if (el) renderInto(el, v.assignment);
  });
}

function renderGSlide() {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const flag = getFlag();
  renderInto(document.getElementById('gFlag'), v.assignment);
  document.getElementById('gName').textContent = v.name;
  document.getElementById('gCount').textContent = `${S.gIndex + 1} / ${S.variations.length}`;
  document.getElementById('gPrev').disabled = S.gIndex === 0;
  document.getElementById('gNext').disabled = S.gIndex === S.variations.length - 1;
  document.querySelectorAll('.gthumb').forEach((t, i) => t.classList.toggle('active', i === S.gIndex));

  const zoneRows = (flag?.logoZones || []).map(z => {
    const lid = v.assignment[z.id];
    const logo = S.library.find(l => l.id === lid);
    return `<div class="drow"><span class="dkey">${z.label}</span><span class="dval">
      ${logo ? `<img src="${logo.src}" style="width:20px;height:20px;object-fit:contain;border-radius:3px">${logo.name}` : '<span style="color:var(--gray-400)">Empty</span>'}
    </span></div>`;
  }).join('');

  const colorRows = (flag?.colorZones || []).map(z => {
    const hex = S.colors[z.id] || '#ccc';
    const col = COLORS.find(c => c.hex === hex);
    return `<div class="drow"><span class="dkey">${z.label}</span><span class="dval"><span class="dot" style="background:${hex}"></span>${col?.name || hex}</span></div>`;
  }).join('');

  document.getElementById('gDetails').innerHTML = `
    <div class="drow"><span class="dkey">Style</span><span class="dval">${flag?.name || '—'}</span></div>
    ${colorRows}${zoneRows}`;
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

window.expSVG = function () {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const svg = makeSvg(v.assignment, 1000, 750);
  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  dl(URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' })), slug(v.name) + '.svg');
};

window.expPNG = function () {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const btn = document.getElementById('expPng');
  btn.textContent = '…'; btn.disabled = true;
  svgToPng(v.assignment, 2000, 1500, url => {
    dl(url, slug(v.name) + '.png');
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PNG';
    btn.disabled = false;
  });
};

window.expAllPNG = async function () {
  for (let i = 0; i < S.variations.length; i++) {
    const v = S.variations[i];
    await new Promise(res => svgToPng(v.assignment, 2000, 1500, url => { dl(url, slug(v.name) + '.png'); res(); }));
    await new Promise(r => setTimeout(r, 500));
  }
};

function svgToPng(assignment, w, h, cb) {
  const svg = makeSvg(assignment, w, h);
  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const url = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    c.toBlob(b => cb(URL.createObjectURL(b)), 'image/png');
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert('PNG export failed — ensure logos are local file uploads.'); };
  img.src = url;
}

window.submitQuote = function () {
  alert(`Quote submitted for ${S.variations.length} variation(s). Our team will follow up within 1 business day.`);
};

// ── SAVE DRAFT ────────────────────────────────────────────
window.saveDraft = async function () {
  const btn = document.getElementById('saveDraftBtn');
  const status = document.getElementById('saveStatus');
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    const id = await supabaseSaveDraft(S);
    S.orderId = id;
    status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 3000);
  } catch (err) {
    console.error(err);
    status.textContent = 'Save failed';
  } finally {
    btn.disabled = false;
  }
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
renderFlagGrid();
