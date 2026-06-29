import { HS, UI, getEffectiveState, getEffectiveVariation } from './state.js';
import { goStep, updateSidebar } from './app.js';
import { cloneTemplateLogos, loadCustomTemplates } from './design.js';
import { saveDraftInternal } from './export.js';
import { applyFillToVariation, hideHsToolbar, prepareLogo, removeBgFromLogo } from './logo-utils.js';
import { HS_TEMPLATES } from '../hole-sign-data.js';
import { logoThumbHtml } from '../media-utils.js';
import { escXml, renderHoleSignInto } from '../hole-sign-render.js';
import { deleteLogo, uploadLogo, saveHsOneOffs } from '../supabase.js';
import { applyHsZoom, renderVariationPreview, wireCanvasZoom } from './var-canvas.js';
import { renderEditor } from './var-editor.js';
import { openDefaultsPanel } from './defaults.js';

// ── Step 2: Variations ─────────────────────────────────────

export function renderStep2() {
  const panel = document.getElementById('panel-2');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="ptitle">Variations</div>
        <div class="psub">Upload sponsor logos and build one variation per sponsor. <strong>Each sign is printed front and back</strong> with the same design.</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn sm" onclick="tryGoStep(1)">← Design</button>
        <button class="btn sm primary" onclick="goStep(3)">Gallery & export →</button>
        <button class="btn sm" id="saveDraftBtn" onclick="saveDraft()">Save draft</button>
      </div>
    </div>
    <div class="var-strip-wrap">
      <div class="var-strip-label">Logo library</div>
      <div class="var-strip" id="hsLibStrip">
        <button class="var-upload-btn" title="Upload logo" onclick="document.getElementById('hsLogoFile').click()">+</button>
        <input type="file" id="hsLogoFile" accept="image/*,.pdf,.ai,.eps" multiple style="display:none">
      </div>
    </div>
    <div class="s4layout">
      <div class="var-canvas-panel">
        <div class="canvas-zoom-row">
          <span class="canvas-zoom-value" id="hsZoomValue">100%</span>
          <button class="canvas-zoom-reset" id="hsZoomReset" onclick="setHsZoom(100)" style="display:none">Reset</button>
          <span class="canvas-zoom-hint">⌘ + scroll to zoom</span>
        </div>
        <div class="canvas-scroll" id="hsCanvasScroll">
          <div class="canvas-scroll-inner">
            <div class="canvas-zoom-wrap" id="hsZoomWrap">
              <div class="hs-sign-preview" id="hsSignPreview"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="var-list-panel">
        <div class="var-list-header">
          <div class="var-list-title">Variations</div>
          <div class="add-var-wrap" id="addVarWrap">
            <button class="add-var-trigger" onclick="toggleAddVarMenu(event)">+ Add ▾</button>
            <div class="add-var-dropdown" id="addVarDropdown">
              <button class="add-var-opt" onclick="addEmptyHsVar();closeAddVarMenu()">New variation</button>
              <button class="add-var-opt" onclick="openDefaultsPanel();closeAddVarMenu()">Default sign</button>
              <button class="add-var-opt add-var-opt-upload" onclick="document.getElementById('hsCustomArtboardFile').click();closeAddVarMenu()">Upload custom design</button>
            </div>
            <input type="file" id="hsCustomArtboardFile" accept="image/*" style="display:none">
          </div>
        </div>
        <div class="var-list" id="hsVarList"></div>
      </div>
    </div>`;

  document.getElementById('hsLogoFile').addEventListener('change', handleHsLogoUpload);
  document.getElementById('hsCustomArtboardFile').addEventListener('change', handleHsArtboardUpload);
  wireCanvasZoom('hsCanvasScroll', 'hsZoomWrap', () => UI.hsZoom, applyHsZoom);
  applyHsZoom(UI.hsZoom);

  buildLibStrip();
  renderVarList();
  if (HS.variations.length && !HS.activeVarId) {
    HS.activeVarId = HS.variations[0].id;
  }
  if (HS.activeVarId) {
    selectVariation(HS.activeVarId);
  } else {
    renderVariationPreview();
  }
}

// ── Add-variation dropdown ─────────────────────────────────

window.toggleAddVarMenu = function (e) {
  e.stopPropagation();
  const dd = document.getElementById('addVarDropdown');
  if (!dd) return;
  const open = dd.classList.contains('open');
  dd.classList.toggle('open', !open);
  if (!open) {
    const close = () => { dd.classList.remove('open'); document.removeEventListener('click', close, true); };
    setTimeout(() => document.addEventListener('click', close, true), 0);
  }
};

window.closeAddVarMenu = function () {
  document.getElementById('addVarDropdown')?.classList.remove('open');
};

async function handleHsArtboardUpload(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  // Add a placeholder tile immediately so the user sees the card appear right away
  const varId = 'v-' + Date.now();
  const newVar = {
    id: varId,
    name: file.name.replace(/\.[^.]+$/, ''),
    artboardSrc: null,
    loading: true,
    logoId: null, logoSrc: null,
  };
  HS.variations.push(newVar);
  HS.activeVarId = varId;
  updateSidebar();
  renderVarList();

  try {
    const logo = await uploadLogo(HS.projectId, file);
    HS.library.push(logo);
    newVar.artboardSrc = logo.src;
    delete newVar.loading;
    buildLibStrip();
    renderVarList();
    renderVariationPreview();
  } catch (err) {
    console.error('Custom artboard upload failed', err);
    // Remove the placeholder on failure
    const idx = HS.variations.findIndex(v => v.id === varId);
    if (idx >= 0) HS.variations.splice(idx, 1);
    HS.activeVarId = HS.variations[HS.variations.length - 1]?.id ?? null;
    renderVarList();
  }
}

export function buildLibStrip() {
  const strip = document.getElementById('hsLibStrip');
  if (!strip) return;
  while (strip.children.length > 2) strip.removeChild(strip.lastChild);
  HS.library.forEach(logo => {
    const el = document.createElement('div');
    el.className = 'var-lib-item';
    el.title = logo.name;
    el.draggable = true;
    el.innerHTML = `${logoThumbHtml(logo.src, logo.name)}<button class="var-lib-del" title="Delete">×</button><button class="var-lib-bgrem" title="Remove background">✦</button>`;
    el.addEventListener('click', e => {
      if (e.target.classList.contains('var-lib-del') || e.target.classList.contains('var-lib-bgrem')) return;
      addVariationForLogo(logo);
    });
    el.querySelector('.var-lib-del').addEventListener('click', e => {
      e.stopPropagation();
      deleteHsLibLogo(logo);
    });
    el.querySelector('.var-lib-bgrem').addEventListener('click', async e => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.textContent = '…';
      btn.disabled = true;
      try {
        const newLogo = await removeBgFromLogo(logo, s => { btn.textContent = s === 'uploading' ? '↑' : '…'; });
        // Replace in-place so no new library entry is created
        const origIdx = HS.library.indexOf(logo);
        if (origIdx >= 0) HS.library.splice(origIdx, 1, newLogo);
        else HS.library.push(newLogo);
        HS.variations.forEach(vv => {
          if (vv.logoId === logo.id) {
            vv.logoId = newLogo.id;
            vv.logoSrc = newLogo.src;
            delete vv.logoSrcTight; delete vv.logoAspect; delete vv.logoArtworkBounds;
          }
        });
        buildLibStrip();
        renderVarList();
      } catch (err) {
        console.error('Background removal failed', err);
      } finally {
        btn.textContent = '✦';
        btn.disabled = false;
      }
    });
    el.addEventListener('dragstart', () => { UI.hsDragLogoId = logo.id; el.classList.add('dragging'); });
    el.addEventListener('dragend',   () => { UI.hsDragLogoId = null;    el.classList.remove('dragging'); });
    strip.appendChild(el);
  });
}

export async function deleteHsLibLogo(logo) {
  if (!confirm(`Delete logo "${logo.name}"? Variations using it will lose their logo.`)) return;
  HS.variations.forEach(v => {
    if (v.logoId === logo.id) {
      v.logoId = null;
      v.logoSrc = null;
      v.logoSrcTight = undefined;
      v.logoAspect = undefined;
      v.logoArtworkBounds = undefined;
    }
  });
  HS.library = HS.library.filter(l => l.id !== logo.id);
  buildLibStrip();
  renderVarList();
  renderVariationPreview();
  hideHsToolbar();
  if (logo.storagePath) {
    try { await deleteLogo(logo.storagePath, logo.id); }
    catch (err) { console.error('Storage delete failed', err); }
  }
}

window.handleHsLogoUpload = async function (e) {
  const files = Array.from(e.target.files || []);
  if (e.target) e.target.value = '';
  for (const file of files) {
    try {
      const logo = await uploadLogo(HS.projectId, file);
      HS.library.push(logo);
      addVariationForLogo(logo);
      buildLibStrip();
      renderVarList();
    } catch (err) {
      console.error('Logo upload failed', err);
    }
  }
};

export function addVariationForLogo(logo) {
  const variation = {
    id: crypto.randomUUID(),
    name: logo.name,
    templateId: HS.templateStyle,
    logoId: logo.id,
    logoSrc: logo.src,
    logoData: { x: 50, y: 50, w: 90 },
  };
  HS.variations.push(variation);
  updateSidebar();
  selectVariation(variation.id);
  prepareLogo(variation, logo.src).then(() => {
    applyFillToVariation(variation);
    renderVarList();
    if (HS.activeVarId === variation.id) renderVariationPreview();
  }).catch(() => {});
}

export function selectVariation(id) {
  HS.activeVarId = id;
  UI.activeDefaultId = null;
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
}

window.selectHsVariation = function (id) { selectVariation(id); };

window.selectHsDefault = function (id) {
  UI.activeDefaultId = id;
  HS.activeVarId = null;
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
};

export function renderVarTmplRow() {
  const row = document.getElementById('hsVarTmplRow');
  if (!row) return;
  if (HS.editingVarId) { row.innerHTML = ''; return; }
  const v = HS.variations.find(v => v.id === HS.activeVarId);
  if (!v) { row.innerHTML = ''; return; }

  const customs = loadCustomTemplates();
  const activeLayoutId = v.templateId || HS.templateStyle;
  const activeCustomId = v.template?.sourceId || null;

  let triggerLabel;
  if (activeCustomId) {
    const c = customs.find(t => t.id === activeCustomId);
    triggerLabel = c ? c.name : 'Custom template';
  } else {
    triggerLabel = (HS_TEMPLATES.find(t => t.id === activeLayoutId) || HS_TEMPLATES[0]).name;
  }

  const builtInItems = HS_TEMPLATES.map(t => `
    <div class="hs-var-tmpl-opt${!activeCustomId && activeLayoutId === t.id ? ' active' : ''}"
      onclick="setVarTemplate('${t.id}')">
      <span>${escXml(t.name)}</span>
      ${!activeCustomId && activeLayoutId === t.id ? '<span>✓</span>' : ''}
    </div>`).join('');

  const customItems = customs.length
    ? customs.map(t => `
        <div class="hs-var-tmpl-opt${activeCustomId === t.id ? ' active' : ''}"
          onclick="setVarTemplate('custom:${t.id}')">
          <span>${escXml(t.name)}</span>
          ${activeCustomId === t.id ? '<span>✓</span>' : ''}
        </div>`).join('')
    : '<div class="hs-var-tmpl-opt-empty">No saved templates yet</div>';

  row.innerHTML = `
    <span class="hs-var-tmpl-label">Template</span>
    <div class="hs-var-tmpl-picker">
      <button class="hs-var-tmpl-trigger" onclick="toggleVarTmplMenu(event)">
        <span>${escXml(triggerLabel)}</span><span class="caret">▾</span>
      </button>
      <div class="hs-var-tmpl-menu" id="hsVarTmplMenu" style="display:none">
        <div class="hs-var-tmpl-group-label">Layouts</div>
        ${builtInItems}
        <div class="hs-var-tmpl-sep"></div>
        <div class="hs-var-tmpl-group-label">My templates</div>
        ${customItems}
        ${(v.template || (v.templateId && v.templateId !== HS.templateStyle)) ? `
          <div class="hs-var-tmpl-sep"></div>
          <div class="hs-var-tmpl-opt" onclick="setVarTemplate('__default__')">
            <span style="color:var(--gray-600)">Use project default</span>
          </div>` : ''}
      </div>
    </div>`;
}

window.toggleVarTmplMenu = function (e) {
  e?.stopPropagation();
  const menu = document.getElementById('hsVarTmplMenu');
  if (!menu) return;
  const open = menu.style.display !== 'none';
  menu.style.display = open ? 'none' : 'block';
  if (!open) {
    const close = ev => {
      if (!ev.target.closest('.hs-var-tmpl-picker')) {
        menu.style.display = 'none';
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
};

window.setVarTemplate = function (key) {
  const v = HS.variations.find(v => v.id === HS.activeVarId);
  if (!v) return;
  if (key === '__default__') {
    delete v.template;
    delete v.templateId;
  } else if (key.startsWith('custom:')) {
    const id = key.slice(7);
    const tmpl = loadCustomTemplates().find(t => t.id === id);
    if (!tmpl) return;
    v.template = {
      sourceId:      tmpl.id,
      templateStyle: tmpl.templateStyle,
      background:    { ...tmpl.background },
      topText:       { ...tmpl.topText },
      bottomText:    { ...tmpl.bottomText },
      templateLogos: cloneTemplateLogos(tmpl.templateLogos),
    };
    v.templateId = tmpl.templateStyle;
  } else {
    delete v.template;
    v.templateId = key;
  }
  const menu = document.getElementById('hsVarTmplMenu');
  if (menu) menu.style.display = 'none';
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
  saveDraftInternal().catch(() => {});
};

export function renderVarList() {
  const list = document.getElementById('hsVarList');
  if (!list) return;
  if (HS.editingVarId && HS.editingDraft) {
    renderEditor();
    return;
  }

  const varHtml = HS.variations.map(v => {
    const isCustomized = !!(v.template || v.sponsorText || (v.templateId && v.templateId !== HS.templateStyle));
    const fb = HS.feedback?.find(f => f.variation_id === v.id);
    const fbClass = fb?.status === 'needs_edits' && !fb?.resolved ? ' needs-edits'
      : fb?.status === 'approved' ? ' approved' : '';
    const statusTile = fb?.status === 'approved'
      ? '<span class="var-status-tile approved">✓ Approved</span>'
      : (fb?.status === 'needs_edits' && !fb?.resolved)
        ? '<span class="var-status-tile needs-edits">Needs edits</span>'
        : '<span class="var-status-tile not-reviewed">Not reviewed</span>';
    const qty = v.qty ?? 1;
    return `
    <div class="var-card${v.id === HS.activeVarId ? ' active' : ''}${fbClass}" data-varid="${v.id}" onclick="selectHsVariation('${v.id}')">
      <div class="var-card-left">
        <div class="hs-vthumb" id="hsvt-${v.id}"></div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">
          <input class="vname" value="${escXml(v.name)}" onclick="event.stopPropagation()"
            onchange="renameHsVar('${v.id}',this.value)">
          ${statusTile}
          ${isCustomized ? '<span class="var-custom-badge">Customized</span>' : ''}
          <div class="var-qty-row" onclick="event.stopPropagation()">
            <label class="var-qty-label">Qty</label>
            <input class="var-qty-input" type="number" min="1" step="1" value="${qty}"
              onchange="setHsVarQty('${v.id}', this.value)">
          </div>
        </div>
      </div>
      <div class="var-btns">
        <button class="vbtn" title="Edit" onclick="event.stopPropagation();startEditVar('${v.id}')">✎</button>
        <button class="vbtn" title="Delete" onclick="event.stopPropagation();deleteHsVar('${v.id}')">✕</button>
      </div>
    </div>`;
  }).join('');

  const defaultHtml = HS.defaults.map(d => {
    const qty = d.qty ?? 1;
    return `
    <div class="var-card${d.id === UI.activeDefaultId ? ' active' : ''}" onclick="selectHsDefault('${d.id}')">
      <div class="var-card-left">
        <div class="hs-vthumb hs-vthumb-img" style="background:#fff">
          ${logoThumbHtml(d.src, escXml(d.name))}
        </div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">
          <span class="vname" style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escXml(d.name)}">${escXml(d.name)}</span>
          <span class="var-status-tile not-reviewed">Not reviewed</span>
          <div class="var-qty-row" onclick="event.stopPropagation()">
            <label class="var-qty-label">Qty</label>
            <input class="var-qty-input" type="number" min="1" step="1" value="${qty}"
              onchange="setHsDefaultQty('${d.id}', this.value)">
          </div>
        </div>
      </div>
      <div class="var-btns">
        <button class="vbtn" title="Remove" onclick="event.stopPropagation();removeHsDefault('${d.id}')">✕</button>
      </div>
    </div>`;
  }).join('');

  if (!varHtml && !defaultHtml) {
    list.innerHTML = '<div style="font-size:13px;color:var(--gray-400);text-align:center;padding:1rem 0">No variations yet. Upload a logo to add one.</div>';
    return;
  }
  list.innerHTML = varHtml + defaultHtml;

  HS.variations.forEach(v => {
    const card = list.querySelector(`.var-card[data-varid="${v.id}"]`);
    if (card) {
      card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
      card.addEventListener('dragleave', e => { if (!card.contains(e.relatedTarget)) card.classList.remove('drag-over'); });
      card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const logo = UI.hsDragLogoId ? HS.library.find(l => l.id === UI.hsDragLogoId) : null;
        if (!logo) return;
        UI.hsDragLogoId = null;
        v.logoId = logo.id;
        v.logoSrc = logo.src;
        delete v.logoSrcTight; delete v.sponsorText;
        if (!v.logoData) v.logoData = { x: 50, y: 50, w: 90 };
        // Update only this card's thumbnail — avoids tearing down all event listeners
        const refreshThumb = () => {
          const thumb = document.getElementById('hsvt-' + v.id);
          if (thumb) renderHoleSignInto(thumb, getEffectiveState(v), getEffectiveVariation(v));
        };
        refreshThumb();
        if (HS.activeVarId === v.id) renderVariationPreview();
        prepareLogo(v, logo.src).then(() => {
          applyFillToVariation(v);
          refreshThumb();
          if (HS.activeVarId === v.id) renderVariationPreview();
        }).catch(() => {});
      });
    }

    const el = document.getElementById('hsvt-' + v.id);
    if (!el) return;
    el.style.position = 'relative';
    // While uploading, show a spinner
    if (v.loading) {
      el.innerHTML = '<div class="hs-vthumb-uploading"><div class="hs-upload-spinner"></div></div>';
      return;
    }
    // Artboard variations: skip SVG render entirely — paint the image directly
    // so there's no flash of the template behind the image.
    if (v.artboardSrc) {
      el.innerHTML = '';
      const ab = document.createElement('img');
      ab.className = 'hs-vthumb-artboard';
      ab.src = v.artboardSrc;
      ab.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;';
      el.appendChild(ab);
      return;
    }
    renderHoleSignInto(el, getEffectiveState(v), getEffectiveVariation(v));
    const imgEl = el.querySelector('image[href]');
    const src = imgEl?.getAttribute('href');
    if (src) {
      const img = new Image();
      img.onload = img.onerror = () => el.classList.remove('loading');
      img.src = src;
    } else {
      el.classList.remove('loading');
    }
  });
}

window.renameHsVar = function (id, name) {
  const v = HS.variations.find(v => v.id === id);
  if (v) v.name = name;
  const nameEl = document.getElementById('hsActiveVarName');
  if (nameEl && HS.activeVarId === id) nameEl.textContent = name;
};

window.setHsVarQty = function (id, val) {
  const v = HS.variations.find(v => v.id === id);
  if (!v) return;
  v.qty = Math.max(1, parseInt(val, 10) || 1);
};

window.deleteHsVar = function (id) {
  HS.variations = HS.variations.filter(v => v.id !== id);
  if (HS.activeVarId === id) HS.activeVarId = HS.variations[0]?.id || null;
  if (HS.editingVarId === id) { HS.editingVarId = null; HS.editingDraft = null; }
  updateSidebar();
  renderVarList();
  renderVariationPreview();
};

window.removeHsDefault = function (id) {
  HS.defaults = HS.defaults.filter(d => d.id !== id);
  renderVarList();
  saveHsOneOffs(HS.projectId, HS.defaults).catch(() => {});
};

window.setHsDefaultQty = function (id, val) {
  const d = HS.defaults.find(d => d.id === id);
  if (!d) return;
  d.qty = Math.max(1, parseInt(val, 10) || 1);
  saveHsOneOffs(HS.projectId, HS.defaults).catch(() => {});
};

window.addEmptyHsVar = function () {
  const v = {
    id: crypto.randomUUID(),
    name: 'Variation ' + (HS.variations.length + 1),
    templateId: HS.templateStyle,
    logoId: null,
    logoSrc: null,
    logoData: { x: 50, y: 50, w: 90 },
  };
  HS.variations.push(v);
  updateSidebar();
  selectVariation(v.id);
};
