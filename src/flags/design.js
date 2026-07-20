import '../style.css';
import '../icons.js';
import { requireAuth } from '../auth.js';

await requireAuth();

import { S, setDragLogoId, DEFAULT_COLORS } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, applyColors, showGsTagVariant, resolveColors } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  createProject, updateProject, loadProject,
  saveFlagConfig, loadFlagConfig,
  uploadLogo, loadLogosForProject, deleteLogo,
  loadOrderIntake,
} from '../supabase.js';
import { initDropZones, renderDropZones, hideZoneToolbar } from './drop-zones.js';
import { eyedropperBtn, pickEyedropperColor } from '../eyedropper.js';
import { esc } from '../dom-utils.js';
import { renderSidebar, setSidebarProjectName } from '../sidebar.js';
import { renderCanvasPanel } from '../canvas-panel.js';

let isDirty = false;
let _baseZoom = 100;
let _flagExpZoom = 100;
function safeHex(h) { return /^#[0-9A-Fa-f]{3,6}$/.test(h) ? h : '#cccccc'; }

renderCanvasPanel(document.getElementById('flagExpCanvasPanel'), {
  panelId: 'flagExpCanvasPanel',
  scrollId: 'flagExpScroll',
  wrapId: 'flagExpZoomWrap',
  zoomValueId: 'flagExpZoomValue',
  zoomResetId: 'flagExpZoomReset',
  aspect: 7519 / 4669,
  getZoom: () => _flagExpZoom,
  setZoom: v => { _flagExpZoom = v; },
  headerName: '—',
  headerNameId: 'flagExpName',
  canvasContentHtml: '<div class="flag-exp-preview" id="flagExpPreview"><div class="flag-exp-placeholder">Select a style →</div></div>',
});

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
  // No visible Save Draft button — every step change persists instead.
  if (S.projectId) window.saveDraft?.().catch(() => {});
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
      <div class="flag-card-name">${f.name}</div>
    </div>`).join('');
}

function showFlagExpanded(id) {
  const flag = FLAGS.find(f => f.id === id);
  if (!flag) return;
  document.getElementById('flagExpName').textContent = flag.name;
  document.querySelectorAll('.flag-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('fc-' + id)?.classList.add('selected');
  refreshFlagExpanded();
}

function refreshFlagExpanded() {
  const preview = document.getElementById('flagExpPreview');
  if (!preview) return;
  const flag = getFlag();
  if (!flag) {
    preview.innerHTML = '<div class="flag-exp-placeholder">Select a style →</div>';
    return;
  }
  preview.innerHTML = `<svg viewBox="${flag.viewBox || '0 0 7519 4669'}" width="100%" height="100%">${flag.svgContent}</svg>`;
  const svg = preview.querySelector('svg');
  applyColors(svg, S.colors, flag.noColors, flag);
  if (S.gsTag) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    showGsTagVariant(svg, 'front', S.gsTagMode, resolveColors(S.colors, flag)[keyZone]);
  }
}

window.pickFlag = function (id) {
  if (S.flagId === id) return;
  S.flagId = id;
  S.logoLayout = 'single';
  showFlagExpanded(id);
  renderP1Colors();
  checkStep1();
  syncSidebar();
  markDirty();
};

// Custom-hex row (always visible, not a popover) + preset swatch grid for a
// Step-1 zone. The leading swatch is a real <input type=color> once a color
// is set (click it to reopen the native picker); before that it's a
// decorative rainbow/plus circle that opens a hidden color input.
function p1ZonePickerHtml(zid, hex) {
  const swatch = hex
    ? `<input type="color" id="p1cn-${zid}" value="${hex}" oninput="p1CSync('${zid}',this.value)" onchange="p1CApply('${zid}')">`
    : `<div class="csw" onclick="document.getElementById('p1cn-${zid}').click()"></div>
       <input type="color" id="p1cn-${zid}" value="#1A4A2E" oninput="p1CSync('${zid}',this.value)" onchange="p1CApply('${zid}')" style="position:absolute;opacity:0;width:0;height:0">`;
  return `<div class="ve-custom-row">
      ${swatch}
      <input type="text" class="hexin" id="p1ch-${zid}" value="${hex || ''}" maxlength="7" placeholder="#000000" oninput="p1CSyncN('${zid}',this.value)" onkeydown="if(event.key==='Enter')p1CApply('${zid}')">
      ${eyedropperBtn(`p1Eyedrop('${zid}')`)}
    </div>
    <div class="swatch-grid" id="p1sg-${zid}">
      ${COLORS.map(c => `<div class="swatch ${c.hex === '#FFFFFF' ? 'ws' : ''} ${hex === c.hex ? 'sel' : ''}"
        style="background:${c.hex}" title="${c.name}"
        onclick="pickColor('${zid}','${c.hex}')"></div>`).join('')}
    </div>`;
}

function borderMatchLabel(flag) {
  return flag.colorZones.some(z => z.id === 'zone-secondary') ? 'Secondary Color' : 'Primary Color';
}

function borderToggleHtml(flag) {
  const matches = !('zone-border' in S.colors);
  return `<label class="gs-tag-label" style="margin-bottom:8px">
    <input type="checkbox" class="gs-toggle-input" ${matches ? 'checked' : ''} onchange="toggleBorderMatch(this.checked)">
    <span class="gs-toggle-switch"></span>
    <span class="gs-toggle-text">Match ${borderMatchLabel(flag)}</span>
  </label>`;
}

function renderP1Colors() {
  const container = document.getElementById('p1colorZones');
  if (!container) return;
  const flag = getFlag();

  if (flag?.noColors) {
    container.innerHTML = '<div class="p1zone"><div class="zlabel" style="color:var(--gray-400);font-style:italic">Colors are fixed for this template</div></div>';
    return;
  }

  // Always show pickers — use flag's zones when available, else generic defaults
  const zones = flag?.colorZones || [
    { id: 'zone-primary', label: 'Primary Color' },
    { id: 'zone-secondary', label: 'Secondary Color' },
  ];

  container.innerHTML = zones.map(z => {
    const label = z.label || (z.id === 'zone-primary' ? 'Primary Color' : 'Color');
    if (z.id === 'zone-border') {
      const matches = !('zone-border' in S.colors);
      const body = matches ? '' : p1ZonePickerHtml('zone-border', S.colors['zone-border']);
      return `<div class="p1zone"><div class="zlabel">${label}</div>${borderToggleHtml(flag)}${body}</div>`;
    }
    return `<div class="p1zone"><div class="zlabel">${label}</div>${p1ZonePickerHtml(z.id, S.colors[z.id])}</div>`;
  }).join('');
}

window.toggleGsTag = function (checked) {
  S.gsTag = checked;
  document.getElementById('gsTagModeWrap').style.display = checked ? 'flex' : 'none';
  const text = document.getElementById('gsTagToggleText');
  if (text) text.textContent = checked ? 'On' : 'Off';
  refreshFlagPreviews();
  refreshColorPrev();
  markDirty();
};

window.setGsTagMode = function (mode) {
  S.gsTagMode = mode;
  document.querySelectorAll('.gs-mode-btn').forEach(b => b.classList.toggle('active', b.id === 'gsMode-' + mode));
  refreshFlagPreviews();
  refreshColorPrev();
  markDirty();
};

function syncGsTagUI() {
  const check = document.getElementById('gsTagCheck');
  if (check) check.checked = S.gsTag;
  const text = document.getElementById('gsTagToggleText');
  if (text) text.textContent = S.gsTag ? 'On' : 'Off';
  const wrap = document.getElementById('gsTagModeWrap');
  if (wrap) wrap.style.display = S.gsTag ? 'flex' : 'none';
  document.querySelectorAll('.gs-mode-btn').forEach(b => b.classList.toggle('active', b.id === 'gsMode-' + (S.gsTagMode || 'auto')));
}

function refreshFlagPreviews() {
  FLAGS.forEach(f => {
    const card = document.getElementById('fc-' + f.id);
    if (!card) return;
    const svg = card.querySelector('svg');
    if (!svg) return;
    applyColors(svg, S.colors, f.noColors, f);
    if (S.gsTag) {
      const keyZone = f.tagKeyZone || 'zone-primary';
      showGsTagVariant(svg, 'front', S.gsTagMode, resolveColors(S.colors, f)[keyZone]);
    }
  });
}

function checkStep1() {
  // Colors are optional — resolveColors() fills unpicked zones with defaults,
  // so only a style selection is required to continue.
  const flag = getFlag();
  const btn = document.getElementById('s1next');
  if (btn) btn.disabled = !flag;
  const hint = document.getElementById('s1hint');
  if (hint) hint.textContent = flag ? '' : 'Pick a style';
  const gsTagSection = document.getElementById('gsTagSection');
  if (gsTagSection) gsTagSection.style.display = flag?.noGsTag ? 'none' : '';
}

window.p1CSync  = (zid, h) => { const inp = document.getElementById('p1ch-' + zid); if (inp) inp.value = h; };
window.p1CSyncN = (zid, h) => { const c = h.startsWith('#') ? h : '#' + h; if (/^#[0-9A-Fa-f]{6}$/.test(c)) { const inp = document.getElementById('p1cn-' + zid); if (inp) inp.value = c; } };
window.p1CApply = function (zid) {
  const h = document.getElementById('p1ch-' + zid).value;
  const c = h.startsWith('#') ? h : '#' + h;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  pickColor(zid, c);
};
window.p1Eyedrop = async function (zid) {
  const hex = await pickEyedropperColor();
  if (hex) pickColor(zid, hex);
};

// ── Step 2: Colors ─────────────────────────────────────────

function s2ZonePickerHtml(zid) {
  const hex = S.colors[zid];
  const swatch = hex
    ? `<input type="color" id="cn-${zid}" value="${hex}" oninput="cSync('${zid}',this.value)" onchange="cApply('${zid}')">`
    : `<div class="csw" onclick="document.getElementById('cn-${zid}').click()"></div>
       <input type="color" id="cn-${zid}" value="#1A4A2E" oninput="cSync('${zid}',this.value)" onchange="cApply('${zid}')" style="position:absolute;opacity:0;width:0;height:0">`;
  return `<div class="ve-custom-row">
      ${swatch}
      <input type="text" class="hexin" id="ch-${zid}" value="${hex || ''}" maxlength="7" placeholder="#000000" oninput="cSyncN('${zid}',this.value)" onkeydown="if(event.key==='Enter')cApply('${zid}')">
      ${eyedropperBtn(`cEyedrop('${zid}')`)}
    </div>
    <div class="swatch-grid" id="sg-${zid}">
      ${COLORS.map(c => `<div class="swatch ${c.hex === '#FFFFFF' ? 'ws' : ''} ${hex === c.hex ? 'sel' : ''}"
        style="background:${c.hex}" data-hex="${c.hex}" title="${c.name}"
        onclick="pickColor('${zid}','${c.hex}')"></div>`).join('')}
    </div>`;
}

window.toggleBorderMatch = function (matches) {
  if (matches) {
    delete S.colors['zone-border'];
  } else if (!('zone-border' in S.colors)) {
    S.colors['zone-border'] = null; // independent mode — nothing chosen yet, show the picker
  }
  renderP1Colors();
  setupColors();
  refreshFlagPreviews();
  refreshColorPrev();
  checkStep1();
  checkColors();
  syncSidebar();
  markDirty();
};

function setupColors() {
  const flag = getFlag();
  if (!flag) return;
  if (flag.noColors) {
    document.getElementById('colorZones').innerHTML = '<div style="color:var(--gray-400);font-size:13px;padding:.5rem 0">Colors are fixed for this template — nothing to configure.</div>';
    document.getElementById('colorPrevName').textContent = flag.name;
    refreshColorPrev();
    checkColors();
    return;
  }
  document.getElementById('colorZones').innerHTML = flag.colorZones.map(z => {
    const label = z.label || (z.id === 'zone-primary' ? 'Primary Color' : 'Color');
    if (z.id === 'zone-border') {
      const matches = !('zone-border' in S.colors);
      const body = matches ? '' : s2ZonePickerHtml('zone-border');
      return `<div class="p1zone"><div class="zlabel">${label}</div>${borderToggleHtml(flag)}${body}</div>`;
    }
    return `<div class="p1zone"><div class="zlabel">${label}</div>${s2ZonePickerHtml(z.id)}</div>`;
  }).join('');
  document.getElementById('colorPrevName').textContent = flag.name;
  refreshColorPrev();
  checkColors();
}

window.pickColor = function (zid, hex) {
  S.colors[zid] = hex;
  // Full re-render (not just toggling .sel on the changed swatch) since the
  // border zone's preview can depend on whichever zone was just picked.
  renderP1Colors();
  setupColors();
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
  const svg = box.querySelector('svg');
  applyColors(svg, S.colors, flag.noColors, flag);
  if (S.gsTag) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    showGsTagVariant(svg, 'front', S.gsTagMode, resolveColors(S.colors, flag)[keyZone]);
  }
  refreshFlagExpanded();
}

function checkColors() {
  // Colors are optional — resolveColors() fills unpicked zones with defaults.
  const flag = getFlag();
  const btn = document.getElementById('s2next');
  if (btn) btn.disabled = !flag;
}

window.cSync  = (z, h) => { const inp = document.getElementById('ch-' + z); if (inp) inp.value = h; };
window.cSyncN = (z, h) => { const c = h.startsWith('#') ? h : '#' + h; if (/^#[0-9A-Fa-f]{6}$/.test(c)) { const inp = document.getElementById('cn-' + z); if (inp) inp.value = c; } };
window.cApply = function (z) {
  const h = document.getElementById('ch-' + z).value;
  const c = h.startsWith('#') ? h : '#' + h;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  pickColor(z, c);
};
window.cEyedrop = async function (z) {
  const hex = await pickEyedropperColor();
  if (hex) pickColor(z, hex);
};

// Native <input type=color> pickers only reliably fire `change` once their
// own popover fully closes, and that's browser-dependent — so as a backstop,
// commit any hex text field that's been edited (via oninput while dragging
// in the picker) but hasn't been applied yet the moment the user clicks
// anywhere outside that zone's own picker block. Keeps the swatch/chip from
// ever silently lagging behind what's actually in the text field.
document.addEventListener('click', e => {
  document.querySelectorAll('.p1zone .hexin').forEach(input => {
    const zoneEl = input.closest('.p1zone');
    if (zoneEl?.contains(e.target)) return;
    const zid = input.id.replace(/^p1ch-|^ch-/, '');
    const h = input.value;
    const c = h.startsWith('#') ? h : '#' + h;
    if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
    if (c.toLowerCase() === (S.colors[zid] || '').toLowerCase()) return;
    if (input.id.startsWith('p1ch-')) window.p1CApply(zid); else window.cApply(zid);
  });
}, true);

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
      <div class="lib-item-name">${l.uploading ? '<i class="fa-solid fa-upload" aria-hidden="true"></i> uploading…' : l.name}</div>
      ${l.uploading ? '' : `<button class="lib-del" onclick="delLogo('${l.id}')"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`}
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
  renderCanvasPanel(document.getElementById('baseCanvasPanel'), {
    panelId: 'baseCanvasPanel',
    scrollId: 'baseCanvasScroll',
    wrapId: 'baseZoomWrap',
    zoomValueId: 'baseZoomValue',
    zoomResetId: 'baseZoomReset',
    aspect: 7519 / 4669,
    getZoom: () => _baseZoom,
    setZoom: v => { _baseZoom = v; },
    headerName: 'Base assignment',
    canvasContentHtml: '<div class="flag-wrap" id="baseWrap"><svg class="bsvg" id="baseSvg" viewBox="0 0 1000 750" preserveAspectRatio="xMidYMid meet"></svg></div>',
    description: "Drag from library into a zone. Logos placed in the grey bleed margin will be trimmed off and won't appear on the printed flag.",
  });
  const svg = document.getElementById('baseSvg');
  if (!svg) return;
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  svg.innerHTML = flag.svgContent;
  applyColors(svg, S.colors, flag.noColors, flag);
  renderLib();
  renderDropZones('baseWrap', 'baseSvg', [], 'front', () => {});
}

// ── Sidebar ────────────────────────────────────────────────

function syncSidebar() {
  // Summary section removed — nothing to sync
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
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="save-spin"></span>'; }
  try {
    if (!S.projectId) {
      S.projectId = await createProject(S.projectName);
      history.replaceState(null, '', '?project=' + S.projectId);
    } else if (S.projectName !== undefined) {
      await updateProject(S.projectId, { name: S.projectName || null });
    }
    await saveFlagConfig(S.projectId, S);
    markClean();
    if (btn) {
      btn.innerHTML = '<span class="save-check"><i class="fa-solid fa-check" aria-hidden="true"></i></span>';
      setTimeout(() => { btn.innerHTML = 'Save draft'; btn.disabled = false; }, 1500);
    }
  } catch (err) {
    console.error(err);
    if (btn) { btn.innerHTML = 'Save draft'; btn.disabled = false; }
  }
};

window.goToVariations = async function () {
  await window.saveDraft();
  if (S.projectId) window.location.href = 'flags-variations.html?project=' + S.projectId;
};

// ── Init ──────────────────────────────────────────────────

renderSidebar(document.getElementById('sidebar'), {
  projectType: 'Tournament Flags',
  activeStep: 1,
  customerSection: true,
  projectId: new URLSearchParams(window.location.search).get('project'),
  steps: [
    { id: 'navDesign', label: 'Design', desc: 'Style, colors & logos' },
    {
      id: 'navVariations', label: 'Variations', desc: 'Build combinations',
      onClick: async () => {
        const p = new URLSearchParams(window.location.search).get('project');
        if (!p) return;
        await window.saveDraft?.();
        window.location.href = 'flags-variations.html?project=' + p;
      },
    },
    {
      id: 'navGallery', label: 'Gallery', desc: 'Review & export',
      onClick: async () => {
        const p = new URLSearchParams(window.location.search).get('project');
        if (!p) return;
        await window.saveDraft?.();
        window.location.href = 'flags-gallery.html?project=' + p;
      },
    },
  ],
});

await loadAllFlags(FLAGS);
renderFlagGrid();
renderP1Colors();
syncGsTagUI();

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
      S.colors = (flagCfg.colors && Object.keys(flagCfg.colors).length) ? flagCfg.colors : { ...DEFAULT_COLORS };
      const varData = flagCfg.variations || [];
      const varItems = Array.isArray(varData) ? varData : (varData.items || []);
      S.variations = varItems.map(v => ({ ...v, backAssignment: v.backAssignment || {} }));
      S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
      S.gsTag = Array.isArray(varData) ? true : (varData.gsTag ?? true);
      S.gsTagMode = Array.isArray(varData) ? 'auto' : (varData.gsTagMode ?? 'auto');
      S.gsTagColor = Array.isArray(varData) ? '#ffffff' : (varData.gsTagColor ?? '#ffffff');
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
    setSidebarProjectName(S.projectName, S.projectId);
    if (!S.flagId) S.flagId = 'plain';
    showFlagExpanded(S.flagId);
    renderP1Colors();
    refreshFlagPreviews();
    checkStep1();
    syncSidebar();
    syncGsTagUI();
    if (intake) renderCustomerSection(intake);
  } catch (err) {
    console.error('Could not load project', err);
  }
}
