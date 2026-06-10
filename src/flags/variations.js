import '../style.css';
import { requireAuth } from '../auth.js';

await requireAuth();

import { S, setDragLogoId } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, applyColors, renderInto } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  loadProject, saveFlagConfig, loadFlagConfig,
  uploadLogo, loadLogosForProject, deleteLogo,
  getFeedback, resolveFeedback, supabase,
} from '../supabase.js';
import { initDropZones, renderDropZones, hideZoneToolbar } from './drop-zones.js';

let isDirty = false;
let activeFace = 'front';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markDirty() {
  isDirty = true;
  document.getElementById('saveDesignsBtn')?.classList.add('dirty');
}
function markClean() {
  isDirty = false;
  document.getElementById('saveDesignsBtn')?.classList.remove('dirty');
}

initDropZones({
  ensureProject: async () => {},
  markDirty,
  onLibraryUpdated: () => { renderVarStrip(); },
});

// ── Logo library (strip) ───────────────────────────────────

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
    renderVarStrip();
    try {
      const logo = await uploadLogo(S.projectId, file);
      const idx = S.library.findIndex(l => l.id === tempId);
      if (idx !== -1) S.library[idx] = logo;
    } catch (err) {
      console.error('Logo upload failed', err);
      S.library = S.library.filter(l => l.id !== tempId);
    }
    renderVarStrip();
  }
};

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
  renderVarStrip();
  renderVarCanvas();
  markDirty();
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

function renderVarStrip() {
  const strip = document.getElementById('varStrip');
  if (!strip) return;
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

// ── Variations ─────────────────────────────────────────────

function updateFaceTabs() {
  document.getElementById('singleCanvas').style.display = S.sameLogoOnBothSides ? '' : 'none';
  document.getElementById('dualCanvas').style.display   = S.sameLogoOnBothSides ? 'none' : '';
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
  } catch (err) { console.error('Could not resolve feedback:', err); }
};

window.toggleDiffSides = function (checked) {
  S.sameLogoOnBothSides = !checked;
  activeFace = 'front';
  updateFaceTabs();
  renderVarCanvas();
};

function syncLogoLayoutToggle() {
  const flag = getFlag();
  const row = document.getElementById('logoLayoutRow');
  if (!row) return;
  const hasOptions = !!(flag?.logoZoneSets);
  row.style.display = hasOptions ? '' : 'none';
  if (hasOptions) {
    const layout = S.logoLayout || 'single';
    flag.logoZones = flag.logoZoneSets[layout] || flag.logoZones;
    document.getElementById('layoutBtnSingle')?.classList.toggle('active', layout === 'single');
    document.getElementById('layoutBtnMulti')?.classList.toggle('active', layout === 'multi');
  }
}

window.setLogoLayout = function (layout) {
  const flag = getFlag();
  if (!flag?.logoZoneSets) return;
  S.logoLayout = layout;
  flag.logoZones = flag.logoZoneSets[layout] || flag.logoZones;
  document.getElementById('layoutBtnSingle')?.classList.toggle('active', layout === 'single');
  document.getElementById('layoutBtnMulti')?.classList.toggle('active', layout === 'multi');
  renderVarCanvas();
  refreshVarThumbs();
  markDirty();
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
  applyFlagZoom(Math.max(40, Math.min(400, parseInt(val, 10) || 100)));
};

(function wireFlagCanvasZoom() {
  const setup = () => {
    const scroll = document.getElementById('flagCanvasScroll');
    if (!scroll || scroll.__zoomWired) return;
    scroll.__zoomWired = true;
    scroll.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const wrap = document.getElementById('flagZoomWrap');
      if (!wrap) return;
      const before = wrap.getBoundingClientRect();
      if (!before.width || !before.height) return;
      const fracX = (e.clientX - before.left) / before.width;
      const fracY = (e.clientY - before.top)  / before.height;
      const oldZoom = _flagZoom;
      const factor = 1 + Math.max(-0.25, Math.min(0.25, -e.deltaY * 0.005));
      const newZoom = Math.max(40, Math.min(400, Math.round(oldZoom * factor)));
      if (newZoom === oldZoom) return;
      applyFlagZoom(newZoom);
      const after = wrap.getBoundingClientRect();
      scroll.scrollLeft += (after.left + fracX * after.width) - e.clientX;
      scroll.scrollTop  += (after.top  + fracY * after.height) - e.clientY;
    }, { passive: false });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();

function renderVarList() {
  const el = document.getElementById('varList');
  if (!el) return;
  el.innerHTML = S.variations.map(v => {
    const fb = S.feedback?.find(f => f.variation_id === v.id);
    const fbClass = fb?.status === 'needs_edits' && !fb?.resolved ? ' needs-edits' : fb?.status === 'approved' ? ' approved' : '';
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
  const nameEl = document.getElementById('activeVarName');
  if (nameEl) nameEl.textContent = v.name;
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

function setupVariations() {
  if (!S.variations.length) {
    S.variations.push({ id: 'v' + Date.now(), name: 'Variation 1', assignment: { ...S.baseAssignment }, backAssignment: {} });
  }
  S.variations.forEach(v => { if (!v.backAssignment) v.backAssignment = {}; });
  if (!S.activeVarId) S.activeVarId = S.variations[0].id;
  activeFace = 'front';
  const cb = document.getElementById('diffSidesCheck');
  if (cb) cb.checked = !S.sameLogoOnBothSides;
  syncLogoLayoutToggle();
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
  const nv = { id: 'v' + Date.now(), name: 'Variation ' + (S.variations.length + 1), assignment: {}, backAssignment: {} };
  S.variations.push(nv);
  S.activeVarId = nv.id;
  renderVarList();
  renderVarCanvas();
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
  markDirty();
};

window.delVar = function (id) {
  if (S.variations.length <= 1) return;
  S.variations = S.variations.filter(v => v.id !== id);
  if (S.activeVarId === id) S.activeVarId = S.variations[0].id;
  renderVarList();
  renderVarCanvas();
  markDirty();
};

window.selectVar = function (id) { S.activeVarId = id; renderVarList(); renderVarCanvas(); };

window.renameVar = function (id, name) {
  const v = S.variations.find(v => v.id === id);
  if (v) v.name = name;
  const nameEl = document.getElementById('activeVarName');
  if (S.activeVarId === id && nameEl) nameEl.textContent = name;
  markDirty();
};

window.setVarQty = function (id, val) {
  const v = S.variations.find(v => v.id === id);
  if (!v) return;
  v.qty = Math.max(1, parseInt(val, 10) || 1);
  markDirty();
};

// ── Project name ───────────────────────────────────────────

window.setProjectName = function (val) {
  S.projectName = val;
  markDirty();
};

// ── Save & navigate ────────────────────────────────────────

window.saveDraft = async function () {
  const btn = document.getElementById('saveDesignsBtn');
  const status = document.getElementById('saveStatus');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Saving…';
  try {
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

window.goToGallery = async function () {
  await window.saveDraft();
  if (S.projectId) window.location.href = 'flags-gallery.html?project=' + S.projectId;
};

// ── Init ──────────────────────────────────────────────────

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (!_urlProject) { window.location.href = '/'; }

await loadAllFlags(FLAGS);

try {
  const [project, logos, flagCfg] = await Promise.all([
    loadProject(_urlProject),
    loadLogosForProject(_urlProject),
    loadFlagConfig(_urlProject).catch(() => null),
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
  }
  const nameInput = document.getElementById('projectNameInput');
  if (nameInput) nameInput.value = S.projectName;

  // Subscribe to feedback updates
  S.feedback = await getFeedback(S.projectId, 'flags').catch(() => []);
  supabase
    .channel('fb-var-' + S.projectId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_feedback', filter: `project_id=eq.${S.projectId}` },
      () => getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderVarList(); renderVarCanvas(); }).catch(() => {}))
    .subscribe();

  setupVariations();
} catch (err) {
  console.error('Could not load project', err);
}
