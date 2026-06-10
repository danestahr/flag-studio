import { HS } from './state.js';
import { listHsDefaults, uploadHsDefault, deleteHsDefault, saveHsOneOffs } from '../supabase.js';
import { renderDefaultsList } from './variations.js';
import { logoThumbHtml } from '../media-utils.js';

// ── Defaults panel state ───────────────────────────────────

let _library = [];
let _loading = false;
let _pendingSelection = new Map(); // id → item, local to the open panel session

// ── Panel lifecycle ────────────────────────────────────────

export function openDefaultsPanel() {
  ensureDefaultsPanel();
  // Seed pending selection from the current project state
  _pendingSelection = new Map(HS.defaults.map(d => [d.id, d]));
  const panel = document.getElementById('hsDefaultsPanel');
  panel.style.display = '';
  document.body.classList.add('hs-defaults-open');
  loadLibrary();
}

window.openDefaultsPanel = openDefaultsPanel;

window.closeDefaultsPanel = function (commit = false) {
  if (commit) {
    // Preserve existing qty values; default new items to qty: 1
    const existing = new Map(HS.defaults.map(d => [d.id, d]));
    HS.defaults = Array.from(_pendingSelection.values()).map(item => ({
      ...item,
      qty: existing.get(item.id)?.qty ?? 1,
    }));
    renderDefaultsList();
    saveHsOneOffs(HS.projectId, HS.defaults).catch(err => console.error('Failed to save defaults', err));
  }
  const panel = document.getElementById('hsDefaultsPanel');
  if (panel) panel.style.display = 'none';
  document.body.classList.remove('hs-defaults-open');
};

function ensureDefaultsPanel() {
  if (document.getElementById('hsDefaultsPanel')) return;

  const overlay = document.createElement('div');
  overlay.id = 'hsDefaultsPanel';
  overlay.className = 'hs-defaults-overlay';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="hs-defaults-modal">
      <div class="hs-defaults-header">
        <div>
          <div class="hs-defaults-title">Default hole signs</div>
          <div class="hs-defaults-sub">Select signs to include in this project. The library is shared across all projects.</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button class="btn sm" onclick="document.getElementById('hsDefaultUploadFile').click()">+ Upload</button>
          <input type="file" id="hsDefaultUploadFile" accept="image/*,.pdf,.ai,.eps" multiple style="display:none">
          <button class="hs-defaults-close" onclick="closeDefaultsPanel()">✕</button>
        </div>
      </div>
      <div class="hs-defaults-body" id="hsDefaultsBody">
        <div class="hs-defaults-loading">Loading…</div>
      </div>
      <div class="hs-defaults-footer">
        <button class="btn sm" onclick="closeDefaultsPanel()">Cancel</button>
        <button class="btn sm primary" id="hsDefaultsAddBtn" onclick="closeDefaultsPanel(true)">Add to project</button>
      </div>
    </div>`;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) window.closeDefaultsPanel();
  });

  overlay.querySelector('#hsDefaultUploadFile').addEventListener('change', handleDefaultUpload);

  document.body.appendChild(overlay);
}

async function handleDefaultUpload(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const file of files) {
    try {
      const item = await uploadHsDefault(file);
      _library.push(item);
      renderLibrary();
    } catch (err) { console.error('Default upload failed', err); }
  }
}

async function loadLibrary() {
  if (_loading) return;
  _loading = true;
  const body = document.getElementById('hsDefaultsBody');
  if (body) body.innerHTML = '<div class="hs-defaults-loading">Loading…</div>';
  try {
    _library = await listHsDefaults();
    renderLibrary();
  } catch (err) {
    console.error('Failed to load defaults', err);
    if (body) body.innerHTML = '<div class="hs-defaults-loading" style="color:var(--red)">Failed to load. Try again.</div>';
  } finally {
    _loading = false;
  }
}

function updateAddBtn() {
  const btn = document.getElementById('hsDefaultsAddBtn');
  if (!btn) return;
  const n = _pendingSelection.size;
  btn.textContent = n === 0 ? 'Add to project' : `Add ${n} sign${n === 1 ? '' : 's'} to project`;
}

function renderLibrary() {
  const body = document.getElementById('hsDefaultsBody');
  if (!body) return;
  if (!_library.length) {
    body.innerHTML = '<div class="hs-defaults-empty">No default signs yet. Upload some to get started.</div>';
    updateAddBtn();
    return;
  }
  body.innerHTML = `
    <div class="hs-defaults-grid">
      ${_library.map(item => `
        <div class="hs-default-item${_pendingSelection.has(item.id) ? ' selected' : ''}"
             data-id="${item.id}">
          <div class="hs-default-img-wrap">
            ${logoThumbHtml(item.src, item.name)}
            <div class="hs-default-check">✓</div>
          </div>
          <div class="hs-default-footer">
            <span class="hs-default-name" title="${item.name}">${item.name}</span>
            <button class="hs-default-del" title="Delete from library"
              data-del-id="${item.id}">✕</button>
          </div>
        </div>`).join('')}
    </div>`;

  body.querySelectorAll('.hs-default-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.hs-default-del')) return;
      const id = el.dataset.id;
      const item = _library.find(l => l.id === id);
      if (!item) return;
      if (_pendingSelection.has(id)) {
        _pendingSelection.delete(id);
        el.classList.remove('selected');
      } else {
        _pendingSelection.set(id, item);
        el.classList.add('selected');
      }
      updateAddBtn();
    });
  });

  body.querySelectorAll('.hs-default-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.delId;
      const item = _library.find(l => l.id === id);
      if (!item) return;
      if (!confirm(`Delete "${item.name}" from the defaults library? This will remove it from all projects.`)) return;
      try {
        await deleteHsDefault(item.storagePath);
        _library = _library.filter(l => l.id !== id);
        _pendingSelection.delete(id);
        // Also remove from current project if it was selected
        HS.defaults = HS.defaults.filter(d => d.id !== id);
        renderDefaultsList();
        saveHsOneOffs(HS.projectId, HS.defaults).catch(() => {});
        renderLibrary();
      } catch (err) { console.error('Delete failed', err); }
    });
  });

  updateAddBtn();
}
