import '../style.css';
import { requireAuth } from '../auth.js';

await requireAuth();

import { S, setDragLogoId } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, applyColors } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  createProject, updateProject, loadProject,
  saveFlagConfig, loadFlagConfig,
  uploadLogo, loadLogosForProject, deleteLogo,
  loadOrderIntake,
} from '../supabase.js';
import { initDropZones, renderDropZones, hideZoneToolbar } from './drop-zones.js';

let isDirty = false;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function safeHex(h) { return /^#[0-9A-Fa-f]{3,6}$/.test(h) ? h : '#cccccc'; }

async function ensureProject() {
  if (S.projectId) return;
  S.projectId = await createProject(S.projectName);
  history.replaceState(null, '', '?project=' + S.projectId);
}

function markDirty() {
  isDirty = true;
  document.getElementById('saveDraftBtn')?.classList.add('dirty');
  ensureProject().catch(console.error);
}
function markClean() {
  isDirty = false;
  document.getElementById('saveDraftBtn')?.classList.remove('dirty');
}

initDropZones({
  ensureProject,
  markDirty,
  onLibraryUpdated: () => { renderLib(); },
});

// ── Internal step nav (steps 1–3 within this page) ────────

function goStep(n) {
  document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('visible', i === n - 1));
  document.querySelectorAll('.step-item').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i === n - 1) s.classList.add('active');
    else if (i < n - 1) s.classList.add('done');
  });
  if (n === 1) renderP1Colors();
  if (n === 2) setupColors();
  if (n === 3) setupLibrary();
  window.scrollTo(0, 0);
}
window.goStep = goStep;
window.tryGoStep = (n) => goStep(n);

// ── Step 1: Design style ───────────────────────────────────

function renderFlagGrid() {
  document.getElementById('flagGrid').innerHTML = FLAGS.map(f => `
    <div class="flag-card" id="fc-${f.id}" onclick="pickFlag('${f.id}')">
      <div class="flag-card-preview"><svg viewBox="${f.viewBox || '0 0 7519 4669'}" preserveAspectRatio="xMidYMid meet">${f.svgContent}</svg></div>
      <div><div class="flag-card-name">${f.name}</div><div class="flag-card-zones">${f.colorZones.map(z => z.label).join(', ')}</div></div>
    </div>`).join('');
}

window.pickFlag = function (id) {
  S.flagId = id;
  S.logoLayout = 'single';
  document.querySelectorAll('.flag-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('fc-' + id)?.classList.add('selected');
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
  const btn = document.getElementById('s1next');
  if (btn) btn.disabled = !ok;
  const hint = document.getElementById('s1hint');
  if (hint) hint.textContent = ok ? '' : !flag ? 'Pick colors and select a style' : 'Pick colors to continue';
}

window.p1ToggleCPop = function (zid) {
  const p = document.getElementById('p1cpop-' + zid);
  const open = p.classList.contains('open');
  document.querySelectorAll('.cpop').forEach(x => x.classList.remove('open'));
  if (!open) p.classList.add('open');
};
window.p1CSync   = (zid, h) => { document.getElementById('p1ch-' + zid).value = h; document.getElementById('p1cprev-' + zid).style.background = h; };
window.p1CSyncN  = (zid, h) => { const c = h.startsWith('#') ? h : '#' + h; if (/^#[0-9A-Fa-f]{6}$/.test(c)) { document.getElementById('p1cn-' + zid).value = c; document.getElementById('p1cprev-' + zid).style.background = c; } };
window.p1CApply  = function (zid) {
  const h = document.getElementById('p1ch-' + zid).value;
  const c = h.startsWith('#') ? h : '#' + h;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  document.getElementById('p1cpop-' + zid).classList.remove('open');
  pickColor(zid, c);
};

// ── Step 2: Colors ─────────────────────────────────────────

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
  if (!box) return;
  box.innerHTML = `<svg viewBox="${flag.viewBox || '0 0 7519 4669'}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${flag.svgContent}</svg>`;
  applyColors(box.querySelector('svg'), S.colors);
}

function checkColors() {
  const flag = getFlag();
  if (!flag) return;
  const btn = document.getElementById('s2next');
  if (btn) btn.disabled = !flag.colorZones.every(z => S.colors[z.id]);
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
window.cSync  = (z, h) => { document.getElementById('ch-' + z).value = h; document.getElementById('cprev-' + z).style.background = h; };
window.cSyncN = (z, h) => { const c = h.startsWith('#') ? h : '#' + h; if (/^#[0-9A-Fa-f]{6}$/.test(c)) { document.getElementById('cn-' + z).value = c; document.getElementById('cprev-' + z).style.background = c; } };
window.cApply = function (z) {
  const h = document.getElementById('ch-' + z).value;
  const c = h.startsWith('#') ? h : '#' + h;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  document.querySelectorAll(`#sg-${z} .swatch`).forEach(s => s.classList.remove('sel'));
  document.getElementById('csw-' + z)?.classList.add('sel');
  document.getElementById('cpop-' + z)?.classList.remove('open');
  pickColor(z, c);
};

// ── Step 3: Logo library ───────────────────────────────────

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
    syncSidebar();
  }
};

function renderLib() {
  const g = document.getElementById('libGrid');
  if (!g) return;
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
  Object.keys(S.baseAssignment).forEach(z => {
    const val = S.baseAssignment[z];
    const lid = typeof val === 'string' ? val : val?.id;
    if (lid === id) delete S.baseAssignment[z];
  });
  hideZoneToolbar();
  renderLib();
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
  if (!svg) return;
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  svg.innerHTML = flag.svgContent;
  applyColors(svg, S.colors);
  renderLib();
  renderDropZones('baseWrap', 'baseSvg', S.baseAssignment);
}

// ── Sidebar ────────────────────────────────────────────────

function syncSidebar() {
  const flag = getFlag();
  const sumStyle = document.getElementById('sumStyle');
  if (sumStyle) { sumStyle.textContent = flag?.name || '—'; sumStyle.style.color = flag ? 'var(--black)' : 'var(--gray-400)'; }
  const z0 = flag?.colorZones[0], z1 = flag?.colorZones[1];
  const h0 = z0 ? S.colors[z0.id] : null, h1 = z1 ? S.colors[z1.id] : null;
  const c0 = COLORS.find(c => c.hex === h0), c1 = COLORS.find(c => c.hex === h1);
  const sp = document.getElementById('sumP');
  if (sp) { sp.innerHTML = h0 ? `<span class="dot" style="background:${h0}"></span>${c0?.name || h0}` : '—'; sp.style.color = h0 ? 'var(--black)' : 'var(--gray-400)'; }
  const ss = document.getElementById('sumS');
  if (ss) { ss.innerHTML = h1 ? `<span class="dot" style="background:${h1}"></span>${c1?.name || h1}` : (z1 ? '—' : 'n/a'); ss.style.color = h1 ? 'var(--black)' : 'var(--gray-400)'; }
  const sumLC = document.getElementById('sumLC');
  if (sumLC) { sumLC.textContent = S.library.length || '—'; sumLC.style.color = S.library.length ? 'var(--black)' : 'var(--gray-400)'; }
}

window.setProjectName = function (val) {
  S.projectName = val;
  markDirty();
};

// ── Customer section ───────────────────────────────────────

function renderCustomerSection(intake) {
  const el = document.getElementById('customerSection');
  if (!el) return;
  const fmt = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const addr = [intake.address_line1, intake.address_line2, intake.city, intake.state_province, intake.postal_code, intake.country].filter(Boolean).join(', ');
  const colors = Array.isArray(intake.flag_colors) ? intake.flag_colors : [];
  el.innerHTML = `
    <div class="sdivider"></div>
    <div class="cs-wrap">
      <div class="cs-header" onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.cs-toggle').classList.toggle('open')">
        <span class="cs-title">Customer</span><span class="cs-toggle open">▾</span>
      </div>
      <div class="cs-body">
        <div class="cs-row"><span class="cs-label">Event</span><span class="cs-value">${esc(intake.event_name)}${intake.event_date ? ' · ' + fmt(intake.event_date) : ''}</span></div>
        <div class="cs-row"><span class="cs-label">Contact</span><span class="cs-value">${esc(intake.contact_name)}<br><span style="color:var(--gray-600)">${esc(intake.contact_email)}</span></span></div>
        <div class="cs-row"><span class="cs-label">Ship to</span><span class="cs-value">${esc(addr)}</span></div>
        <div class="cs-row"><span class="cs-label">Setup</span><span class="cs-value">${intake.flag_setup === 'different' ? 'Different front &amp; back' : 'Same front &amp; back'}</span></div>
        ${colors.length ? `<div class="cs-row"><span class="cs-label">Colors</span><div class="cs-colors">${colors.map(c => `<div class="cs-swatch" style="background:${safeHex(c.hex || c)}" title="${esc(c.name || c)}"></div>`).join('')}</div></div>` : ''}
        ${intake.design_notes ? `<div class="cs-row"><span class="cs-label">Notes</span><span class="cs-notes">${esc(intake.design_notes)}</span></div>` : ''}
      </div>
    </div>`;
  el.style.display = '';
}

// ── Save & navigate ────────────────────────────────────────

window.saveDraft = async function () {
  const btn = document.getElementById('saveDraftBtn');
  const status = document.getElementById('saveStatus');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Saving…';
  try {
    if (!S.projectId) {
      S.projectId = await createProject(S.projectName);
      history.replaceState(null, '', '?project=' + S.projectId);
    } else if (S.projectName !== undefined) {
      await updateProject(S.projectId, { name: S.projectName || null });
    }
    await saveFlagConfig(S.projectId, S);
    markClean();
    if (status) status.textContent = 'Saved';
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
  } catch (err) {
    console.error(err);
    if (status) status.textContent = 'Save failed';
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.goToVariations = async function () {
  await window.saveDraft();
  if (S.projectId) window.location.href = 'flags-variations.html?project=' + S.projectId;
};

// ── Init ──────────────────────────────────────────────────

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
    S.library = logos;
    if (flagCfg) {
      S.flagId = flagCfg.flag_id;
      S.colors = flagCfg.colors || {};
      const varData = flagCfg.variations || [];
      const varItems = Array.isArray(varData) ? varData : (varData.items || []);
      S.variations = varItems.map(v => ({ ...v, backAssignment: v.backAssignment || {} }));
      S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
      S.baseAssignment = flagCfg.base_assignment || {};
      S.sameLogoOnBothSides = flagCfg.same_logo_on_both_sides ?? true;
      S.activeVarId = S.variations[0]?.id || null;
      const flag = getFlag();
      if (flag?.logoZoneSets) flag.logoZones = flag.logoZoneSets[S.logoLayout] || flag.logoZones;
    } else if (intake) {
      if (intake.flag_style) S.flagId = intake.flag_style;
      const colors = Array.isArray(intake.flag_colors) ? intake.flag_colors : [];
      if (colors[0]?.hex) S.colors['zone-primary'] = colors[0].hex;
      if (colors[1]?.hex) S.colors['zone-secondary'] = colors[1].hex;
    }
    const nameInput = document.getElementById('projectNameInput');
    if (nameInput) nameInput.value = S.projectName;
    if (S.flagId) document.getElementById('fc-' + S.flagId)?.classList.add('selected');
    renderP1Colors();
    refreshFlagPreviews();
    checkStep1();
    syncSidebar();
    if (intake) renderCustomerSection(intake);
  } catch (err) {
    console.error('Could not load project', err);
  }
}
