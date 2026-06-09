import { HS, UI, alignBtns, fontSelect, getEffectiveState, getEffectiveVariation, mergeBanner } from './state.js';
import { goStep, updateSidebar } from './app.js';
import { cloneTemplateLogos, loadCustomTemplates, menuRow, paintTplSlotOverlays, stripSlotImages } from './design.js';
import { renderBannerSection, wireCanvasTextEditing, wireElementDrag, wireQuickAddHover } from './banner.js';
import { closeTlSlotToolbar, renderTemplateLogoControls, tlSource } from './template-logos.js';
import { applyFillToVariation, cropSvgToArtwork, fillHsLogo, hideHsToolbar, prepareLogo } from './logo-utils.js';
import { HS_H, HS_TEMPLATES, HS_W } from '../hole-sign-data.js';
import { escXml, getLogoZone, renderHoleSignInto } from '../hole-sign-render.js';
import { deleteLogo, uploadLogo } from '../supabase.js';

// ── Step 2: Variations ─────────────────────────────────────
export function renderStep2() {
  const panel = document.getElementById('panel-2');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="ptitle">Variations</div>
        <div class="psub">Upload sponsor logos and build one variation per sponsor. <strong>Each sign is printed front and back</strong> with the same design.</div>
      </div>
      <button class="btn sm" id="saveDraftBtn" onclick="saveDraft()">Save draft</button>
    </div>
    <div class="var-strip-wrap">
      <div class="var-strip-label">Logo library</div>
      <div class="var-strip" id="hsLibStrip">
        <button class="var-upload-btn" title="Upload logo" onclick="document.getElementById('hsLogoFile').click()">+</button>
        <input type="file" id="hsLogoFile" accept="image/*" multiple style="display:none">
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
          <div class="canvas-zoom-wrap" id="hsZoomWrap">
            <div class="hs-sign-preview" id="hsSignPreview"></div>
          </div>
        </div>
      </div>
      <div class="var-list-panel">
        <div class="var-list-title">Variations</div>
        <div class="var-list" id="hsVarList"></div>
        <button class="add-var" onclick="addEmptyHsVar()">+ Add variation</button>
      </div>
    </div>
    <div class="arow">
      <button class="btn" onclick="tryGoStep(1)">← Back</button>
      <div style="display:flex;gap:8px">
        <button class="btn primary" onclick="goStep(3)">Gallery & export →</button>
      </div>
    </div>`;

  document.getElementById('hsLogoFile').addEventListener('change', handleHsLogoUpload);
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

export function buildLibStrip() {
  const strip = document.getElementById('hsLibStrip');
  if (!strip) return;
  // Keep first 2 children (upload btn + file input)
  while (strip.children.length > 2) {
    strip.removeChild(strip.lastChild);
  }
  HS.library.forEach(logo => {
    const el = document.createElement('div');
    el.className = 'var-lib-item';
    el.title = logo.name;
    el.draggable = true;
    el.innerHTML = `<img src="${logo.src}" alt="${logo.name}"><button class="var-lib-del" title="Delete">×</button>`;
    el.addEventListener('click', e => {
      if (e.target.classList.contains('var-lib-del')) return;
      addVariationForLogo(logo);
    });
    el.querySelector('.var-lib-del').addEventListener('click', e => {
      e.stopPropagation();
      deleteHsLibLogo(logo);
    });
    el.addEventListener('dragstart', () => { UI.hsDragLogoId = logo.id; el.classList.add('dragging'); });
    el.addEventListener('dragend',   () => { UI.hsDragLogoId = null;    el.classList.remove('dragging'); });
    strip.appendChild(el);
  });
}

export async function deleteHsLibLogo(logo) {
  if (!confirm(`Delete logo "${logo.name}"? Variations using it will lose their logo.`)) return;
  // Strip the logo from any variation that referenced it
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
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
}

window.selectHsVariation = function (id) { selectVariation(id); };

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


// Size a preview wrap to "contain"-fit the whole sign inside its scroll
// container, then multiply by the zoom factor. 100% = the entire sign visible
// by default; because the fit is derived from the container's live dimensions,
// the canvas scales proportionally whenever the viewport/panel changes size.
function fitWrap(scroll, wrap, pct) {
  if (!scroll || !wrap) return;
  // Size the scroll box to the real space from its top edge to the bottom of
  // the viewport, so the whole sign is visible without the canvas drifting off
  // screen — regardless of how much chrome sits above it.
  const top = scroll.getBoundingClientRect().top;
  const availH = Math.max(240, Math.round(window.innerHeight - top - 24));
  scroll.style.height = availH + 'px';
  const cw = scroll.clientWidth, ch = scroll.clientHeight;
  if (!cw || !ch) return;
  const ar = HS_W / HS_H;
  let w = cw, h = cw / ar;          // fit to width…
  if (h > ch) { h = ch; w = ch * ar; } // …unless that overflows height
  const k = (pct || 100) / 100;
  wrap.style.width  = Math.round(w * k) + 'px';
  wrap.style.height = Math.round(h * k) + 'px';
}

export function applyHsZoom(pct) {
  UI.hsZoom = pct;
  fitWrap(document.getElementById('hsCanvasScroll'), document.getElementById('hsZoomWrap'), pct);
  const label = document.getElementById('hsZoomValue');
  const reset = document.getElementById('hsZoomReset');
  if (label) label.textContent = pct + '%';
  if (reset) reset.style.display = pct === 100 ? 'none' : '';
}

window.setHsZoom = function (val) {
  const pct = Math.max(40, Math.min(400, parseInt(val, 10) || 100));
  applyHsZoom(pct);
};

export function applyHsStep1Zoom(pct) {
  UI.hsStep1Zoom = pct;
  fitWrap(document.getElementById('hsStep1Scroll'), document.getElementById('hsStep1ZoomWrap'), pct);
  const label = document.getElementById('hsStep1ZoomValue');
  const reset = document.getElementById('hsStep1ZoomReset');
  if (label) label.textContent = pct + '%';
  if (reset) reset.style.display = pct === 100 ? 'none' : '';
}

window.setHsStep1Zoom = function (val) {
  const pct = Math.max(40, Math.min(400, parseInt(val, 10) || 100));
  applyHsStep1Zoom(pct);
};

// Re-fit both canvases on viewport resize so they always scale with the
// available space. Wired once; harmless to call for the inactive step.
let _hsResizeWired = false;
function wireCanvasResize() {
  if (_hsResizeWired) return;
  _hsResizeWired = true;
  let raf = null;
  window.addEventListener('resize', () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      fitWrap(document.getElementById('hsCanvasScroll'), document.getElementById('hsZoomWrap'),      UI.hsZoom);
      fitWrap(document.getElementById('hsStep1Scroll'),  document.getElementById('hsStep1ZoomWrap'), UI.hsStep1Zoom);
    });
  });
}

export function wireCanvasZoom(scrollId, wrapId, getZoom, applyZoom) {
  wireCanvasResize();
  const scroll = document.getElementById(scrollId);
  if (!scroll || scroll.__zoomWired) return;
  scroll.__zoomWired = true;

  scroll.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;

    // Capture the cursor's position relative to the wrap as a fraction of its size.
    const before = wrap.getBoundingClientRect();
    if (!before.width || !before.height) return;
    const fracX = (e.clientX - before.left) / before.width;
    const fracY = (e.clientY - before.top)  / before.height;

    const oldZoom = getZoom();
    const raw = -e.deltaY * 0.005;
    const factor = 1 + Math.max(-0.25, Math.min(0.25, raw));
    const newZoom = Math.max(40, Math.min(400, Math.round(oldZoom * factor)));
    if (newZoom === oldZoom) return;

    applyZoom(newZoom);

    // After layout updates, scroll so the same wrap-local point sits under the cursor again.
    const after = wrap.getBoundingClientRect();
    const targetX = after.left + fracX * after.width;
    const targetY = after.top  + fracY * after.height;
    scroll.scrollLeft += targetX - e.clientX;
    scroll.scrollTop  += targetY - e.clientY;
  }, { passive: false });
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
    // Built-in layout: clear any custom-template override but keep
    // the global background/text. Just swap the layout for this variation.
    delete v.template;
    v.templateId = key;
  }

  const menu = document.getElementById('hsVarTmplMenu');
  if (menu) menu.style.display = 'none';

  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
};

export function renderVarList() {
  const list = document.getElementById('hsVarList');
  if (!list) return;
  if (HS.editingVarId && HS.editingDraft) {
    renderEditor();
    return;
  }
  if (!HS.variations.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--gray-400);text-align:center;padding:1rem 0">No variations yet. Upload a logo to add one.</div>';
    return;
  }
  list.innerHTML = HS.variations.map(v => {
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
    <div class="var-card${v.id === HS.activeVarId ? ' active' : ''}${fbClass}" onclick="selectHsVariation('${v.id}')">
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

  HS.variations.forEach(v => {
    const el = document.getElementById('hsvt-' + v.id);
    if (el) renderHoleSignInto(el, getEffectiveState(v), getEffectiveVariation(v));
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
  if (HS.activeVarId === id) {
    HS.activeVarId = HS.variations[0]?.id || null;
  }
  if (HS.editingVarId === id) { HS.editingVarId = null; HS.editingDraft = null; }
  updateSidebar();
  renderVarList();
  renderVariationPreview();
};

// ── Per-variation editor ──────────────────────────────────
window.startEditVar = function (id) {
  const v = HS.variations.find(v => v.id === id);
  if (!v) return;
  HS.activeVarId = id;
  HS.editingVarId = id;
  const eff = getEffectiveState(v);
  HS.editingDraft = {
    templateStyle: eff.templateStyle,
    background:    { ...eff.background },
    topText:       { ...eff.topText },
    bottomText:    { ...eff.bottomText },
    bannerTop:     mergeBanner(eff.bannerTop),
    bannerBottom:  mergeBanner(eff.bannerBottom),
    templateLogos: cloneTemplateLogos(eff.templateLogos),
    sponsorText:   v.sponsorText ? { ...v.sponsorText } : { text: '', font: 'dm-serif', size: 300, color: '#111110' },
  };
  // Re-crop any slot logos so artwork-bounds blob URLs are fresh in this draft.
  (HS.editingDraft.templateLogos.slots || []).forEach(s => {
    if (s && s.logoSrc && s.logoArtworkBounds) {
      cropSvgToArtwork(s.logoSrc, s.logoArtworkBounds).then(t => {
        if (t) { s.logoSrcTight = t.url; s.logoAspect = t.aspect; renderVariationPreview(); }
      }).catch(() => {});
    }
  });
  UI.tlSelectedIdx = null;
  UI.hsVarMenu = null;
  UI.hsVarMenuAnimate = false;
  UI.qaLogosOpen = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  renderEditor();
  renderVariationPreview();
};

window.cancelEditVar = function () {
  HS.editingVarId = null;
  HS.editingDraft = null;
  UI.tlSelectedIdx = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
};

export function tlForCompare(tl) {
  if (!tl) return null;
  return {
    count: tl.count ?? 0,
    size: tl.size,
    vAlign: tl.vAlign,
    hAlign: tl.hAlign,
    stack: tl.stack,
    slots: (tl.slots || []).map(s => s ? { ...s, logoSrcTight: undefined } : null),
  };
}

window.applyEditVar = function () {
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!v || !HS.editingDraft) return;
  const d = HS.editingDraft;

  // Per-field overrides: only include the fields that actually differ from the
  // project default. Anything we don't snapshot inherits from HS, so updating
  // the default later still flows through to this variation.
  const tpl = {};
  if (d.templateStyle !== HS.templateStyle) tpl.templateStyle = d.templateStyle;
  if (JSON.stringify(d.background) !== JSON.stringify(HS.background)) tpl.background = { ...d.background };
  if (JSON.stringify(d.topText)    !== JSON.stringify(HS.topText))    tpl.topText    = { ...d.topText };
  if (JSON.stringify(d.bottomText) !== JSON.stringify(HS.bottomText)) tpl.bottomText = { ...d.bottomText };
  if (JSON.stringify(mergeBanner(d.bannerTop))    !== JSON.stringify(mergeBanner(HS.bannerTop)))    tpl.bannerTop    = mergeBanner(d.bannerTop);
  if (JSON.stringify(mergeBanner(d.bannerBottom)) !== JSON.stringify(mergeBanner(HS.bannerBottom))) tpl.bannerBottom = mergeBanner(d.bannerBottom);
  if (JSON.stringify(tlForCompare(d.templateLogos)) !== JSON.stringify(tlForCompare(HS.templateLogos))) {
    tpl.templateLogos = cloneTemplateLogos(d.templateLogos);
  }

  if (Object.keys(tpl).length === 0) {
    delete v.template;
    delete v.templateId;
  } else {
    v.template = tpl;
    v.templateId = tpl.templateStyle || HS.templateStyle;
  }

  if (d.sponsorText?.text?.trim()) {
    v.sponsorText = { ...d.sponsorText };
  } else {
    delete v.sponsorText;
  }

  HS.editingVarId = null;
  HS.editingDraft = null;
  UI.tlSelectedIdx = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
};

window.revertVarOverrides = function () {
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!v) return;
  delete v.template;
  delete v.templateId;
  delete v.sponsorText;
  HS.editingVarId = null;
  HS.editingDraft = null;
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
};

window.setDraftTmpl = function (key) {
  if (!HS.editingDraft) return;
  if (key === '__default__') {
    HS.editingDraft.templateStyle = HS.templateStyle;
    HS.editingDraft.background    = { ...HS.background };
    HS.editingDraft.topText       = { ...HS.topText };
    HS.editingDraft.bottomText    = { ...HS.bottomText };
    HS.editingDraft.bannerTop     = mergeBanner(HS.bannerTop);
    HS.editingDraft.bannerBottom  = mergeBanner(HS.bannerBottom);
    HS.editingDraft.templateLogos = cloneTemplateLogos(HS.templateLogos);
  } else if (key.startsWith('custom:')) {
    const tmpl = loadCustomTemplates().find(t => t.id === key.slice(7));
    if (!tmpl) return;
    HS.editingDraft.templateStyle = tmpl.templateStyle;
    HS.editingDraft.background    = { ...tmpl.background };
    HS.editingDraft.topText       = { ...tmpl.topText };
    HS.editingDraft.bottomText    = { ...tmpl.bottomText };
    HS.editingDraft.bannerTop     = mergeBanner(tmpl.bannerTop    || (tmpl.banner?.position !== 'bottom' ? tmpl.banner : null));
    HS.editingDraft.bannerBottom  = mergeBanner(tmpl.bannerBottom || (tmpl.banner?.position === 'bottom' ? tmpl.banner : null));
    HS.editingDraft.templateLogos = cloneTemplateLogos(tmpl.templateLogos);
  } else {
    HS.editingDraft.templateStyle = key;
  }
  UI.tlSelectedIdx = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  renderEditor();
  renderVariationPreview();
};

window.setDraftBgType = function (type) {
  if (!HS.editingDraft) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, type };
  renderEditor();
  renderVariationPreview();
};

window.setDraftBgColor = function (color) {
  if (!HS.editingDraft) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, color };
  const hexInput = document.getElementById('hsDraftBgHex');
  if (hexInput) hexInput.value = color;
  renderVariationPreview();
};

window.setDraftBgColorHex = function (val) {
  if (!HS.editingDraft) return;
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, color: c };
  const swatch = document.getElementById('hsDraftBgSwatch');
  if (swatch) swatch.value = c;
  renderVariationPreview();
};

window.setDraftText = function (which, key, val) {
  if (!HS.editingDraft) return;
  const k = which === 'top' ? 'topText' : which === 'bottom' ? 'bottomText' : 'sponsorText';
  const value = key === 'size' ? (parseInt(val, 10) || 0) : val;
  HS.editingDraft[k] = { ...HS.editingDraft[k], [key]: value };
  if (key === 'size') {
    const lbl = document.getElementById(`hsDraft${which}SizeLabel`);
    if (lbl) lbl.textContent = value + 'pt';
  } else if (key === 'color') {
    const hexInput = document.getElementById(`hsDraft${which}Hex`);
    if (hexInput) hexInput.value = value;
  }
  // Update immediately; keep alignment exactly as set (no auto-correct on edit).
  renderVariationPreview();
};

window.setDraftTextColorHex = function (which, val) {
  if (!HS.editingDraft) return;
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
  const k = which === 'top' ? 'topText' : which === 'bottom' ? 'bottomText' : 'sponsorText';
  HS.editingDraft[k] = { ...HS.editingDraft[k], color: c };
  const swatch = document.getElementById(`hsDraft${which}Swatch`);
  if (swatch) swatch.value = c;
  renderVariationPreview();
};

export function renderDraftTextControls(which, label, optional) {
  const d = HS.editingDraft;
  const k = which === 'top' ? 'topText' : which === 'bottom' ? 'bottomText' : 'sponsorText';
  const st = d[k] || { text: '', font: 'dm-serif', size: 300, color: '#111110' };
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">${label}${optional ? ' <span class="hs-optional">(optional)</span>' : ''}</div>
      <input class="hexin" style="width:100%" placeholder="Add Text..." value="${escXml(st.text)}"
        oninput="setDraftText('${which}','text',this.value)">
      ${fontSelect(`setDraftText('${which}','font',this.value)`, st.font)}
      ${alignBtns(st.align, `setDraftText('${which}','align'`)}
      <div style="display:flex;align-items:center;gap:8px">
        <input type="range" min="80" max="1000" value="${st.size}"
          oninput="setDraftText('${which}','size',this.value)" style="flex:1">
        <span id="hsDraft${which}SizeLabel" style="font-size:12px;color:var(--gray-600);min-width:50px">${st.size}pt</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="color" class="hs-color-swatch" id="hsDraft${which}Swatch" value="${st.color}"
          oninput="setDraftText('${which}','color',this.value)">
        <input type="text" class="hexin" id="hsDraft${which}Hex" style="flex:1" maxlength="7" value="${st.color}"
          oninput="setDraftTextColorHex('${which}',this.value)">
      </div>
    </div>`;
}

const HS_VAR_MENU_TITLES = {
  template: 'Template', background: 'Background',
  bannerTop: 'Top banner', bannerBottom: 'Bottom banner',
  top: 'Top text', bottom: 'Bottom text', logos: 'Template logos', sponsor: 'Sponsor name',
};

export function buildVarTemplateSection(d, customs) {
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">Template</div>
      <select class="hs-editor-select" onchange="setDraftTmpl(this.value)">
        <optgroup label="Layouts">
          ${HS_TEMPLATES.map(t => `<option value="${t.id}"${d.templateStyle === t.id ? ' selected' : ''}>${escXml(t.name)}</option>`).join('')}
        </optgroup>
        ${customs.length ? `<optgroup label="My templates">
          ${customs.map(t => `<option value="custom:${t.id}">${escXml(t.name)}</option>`).join('')}
        </optgroup>` : ''}
      </select>
      <button class="hs-editor-link" onclick="setDraftTmpl('__default__')">↺ Revert to project default</button>
    </div>`;
}

export function buildVarBackgroundSection(d) {
  let bgControls;
  if (d.background.type === 'color') {
    bgControls = `
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <input type="color" class="hs-color-swatch" id="hsDraftBgSwatch" value="${d.background.color}"
          oninput="setDraftBgColor(this.value)">
        <input type="text" class="hexin" id="hsDraftBgHex" style="flex:1" maxlength="7" value="${d.background.color}"
          oninput="setDraftBgColorHex(this.value)">
      </div>`;
  } else {
    bgControls = `<div style="font-size:12px;color:var(--gray-400);margin-top:4px">Background image set on project default. Switch to project default to use a different one.</div>`;
  }
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">Background</div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${d.background.type === 'color' ? ' active' : ''}" onclick="setDraftBgType('color')">Color</button>
        <button class="hs-tog-btn${d.background.type === 'image' ? ' active' : ''}" onclick="setDraftBgType('image')">Image</button>
      </div>
      ${bgControls}
    </div>`;
}

window.openHsVarMenu = function (key) { UI.hsVarMenu = key; UI.hsVarMenuAnimate = true; renderEditor(); };
window.closeHsVarMenu = function () { UI.hsVarMenu = null; UI.hsVarMenuAnimate = true; renderEditor(); };

export function renderEditor() {
  const list = document.getElementById('hsVarList');
  if (!list) return;
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!v || !HS.editingDraft) { renderVarList(); return; }

  const d = HS.editingDraft;
  const customs = loadCustomTemplates();
  const activeTmpl = HS_TEMPLATES.find(t => t.id === d.templateStyle) || HS_TEMPLATES[0];
  const isCustomized = !!(v.template || v.sponsorText || (v.templateId && v.templateId !== HS.templateStyle));
  const sponsorVisible = !v.logoSrc;

  // A section may have become unavailable after a template change.
  if (UI.hsVarMenu === 'logos' && activeTmpl.id === 'hole-sign-logo-only') UI.hsVarMenu = null;
  if ((UI.hsVarMenu === 'top' || UI.hsVarMenu === 'bottom') && !activeTmpl.supportsText) UI.hsVarMenu = null;
  if (UI.hsVarMenu === 'banner') UI.hsVarMenu = 'bannerTop'; // migrate stale key
  if (UI.hsVarMenu === 'sponsor' && !sponsorVisible) UI.hsVarMenu = null;

  let body;
  if (UI.hsVarMenu === null) {
    const rows = [];
    rows.push(menuRow('template', 'Template', escXml(activeTmpl.name), 'openHsVarMenu'));
    const bg = d.background;
    const bgHint = bg.type === 'color'
      ? `<span class="hs-menu-swatch" style="background:${escXml(bg.color)}"></span>`
      : 'Image';
    rows.push(menuRow('background', 'Background', bgHint, 'openHsVarMenu'));
    rows.push(menuRow('bannerTop',    'Top banner',    d.bannerTop?.enabled    ? 'On' : 'Off', 'openHsVarMenu'));
    rows.push(menuRow('bannerBottom', 'Bottom banner', d.bannerBottom?.enabled ? 'On' : 'Off', 'openHsVarMenu'));
    if (activeTmpl.supportsText) {
      rows.push(menuRow('top', 'Top text', d.topText.text ? escXml(d.topText.text) : 'Empty', 'openHsVarMenu'));
      rows.push(menuRow('bottom', 'Bottom text', d.bottomText.text ? escXml(d.bottomText.text) : 'Empty', 'openHsVarMenu'));
    }
    if (activeTmpl.id !== 'hole-sign-logo-only') {
      const c = d.templateLogos?.count ?? 0;
      rows.push(menuRow('logos', 'Template logos', c ? `${c} logo${c > 1 ? 's' : ''}` : 'Off', 'openHsVarMenu'));
    }
    if (sponsorVisible) {
      rows.push(menuRow('sponsor', 'Sponsor name', d.sponsorText?.text ? escXml(d.sponsorText.text) : 'Empty', 'openHsVarMenu'));
    }
    body = `
      <div class="hs-menu-list">${rows.join('')}</div>
      <div class="var-editor-actions">
        <button class="btn primary" onclick="applyEditVar()">Apply changes</button>
        <button class="btn" onclick="cancelEditVar()">Cancel</button>
        ${isCustomized ? '<button class="btn editor-revert-btn" onclick="revertVarOverrides()">Revert all overrides</button>' : ''}
      </div>`;
  } else {
    let section = '';
    if (UI.hsVarMenu === 'template')        section = buildVarTemplateSection(d, customs);
    else if (UI.hsVarMenu === 'background') section = buildVarBackgroundSection(d);
    else if (UI.hsVarMenu === 'bannerTop')    section = renderBannerSection('top');
    else if (UI.hsVarMenu === 'bannerBottom') section = renderBannerSection('bottom');
    else if (UI.hsVarMenu === 'top')        section = renderDraftTextControls('top', 'Top text', true);
    else if (UI.hsVarMenu === 'bottom')     section = renderDraftTextControls('bottom', 'Bottom text', true);
    else if (UI.hsVarMenu === 'logos')      section = renderTemplateLogoControls();
    else if (UI.hsVarMenu === 'sponsor')    section = renderDraftTextControls('sponsor', 'Sponsor name', true)
      + '<div style="font-size:11px;color:var(--gray-400);margin-top:-8px;margin-bottom:8px;padding:0 2px">Displayed in the logo zone when no logo is uploaded.</div>';
    body = `
      <div class="hs-menu-section-header">
        <button class="hs-menu-back" onclick="closeHsVarMenu()">← Back</button>
        <span class="hs-menu-section-title">${HS_VAR_MENU_TITLES[UI.hsVarMenu] || ''}</span>
      </div>
      ${section}`;
  }

  const animClass = UI.hsVarMenuAnimate ? ' hs-controls-enter' : '';
  UI.hsVarMenuAnimate = false;

  list.innerHTML = `
    <div class="var-editor">
      <div class="var-editor-header">
        <div class="var-editor-title">Editing: ${escXml(v.name)}</div>
        <button class="vbtn" title="Cancel" onclick="cancelEditVar()">✕</button>
      </div>
      <div class="hs-editor-body${animClass}">${body}</div>
    </div>`;
}

export function renderVariationPreview() {
  hideHsToolbar();
  const preview = document.getElementById('hsSignPreview');
  if (!preview) return;
  preview.innerHTML = '';

  const activeVar = HS.activeVarId ? HS.variations.find(v => v.id === HS.activeVarId) : null;
  const effState = getEffectiveState(activeVar);

  // Background SVG. Pass the variation only when there's no logo so the
  // renderer draws the sponsor-text fallback; when a logo exists, the DOM
  // overlay below handles drag/resize for it and we want a clean background.
  // When editing this variation, also strip template-logo slot images so the
  // interactive DOM overlays for those slots own their display (anti-halo).
  const isEditingActive = HS.editingVarId && HS.editingVarId === HS.activeVarId;
  const bgSvgDiv = document.createElement('div');
  bgSvgDiv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  const bgVar = activeVar && !activeVar.logoSrc ? getEffectiveVariation(activeVar) : null;
  const bgState = isEditingActive ? stripSlotImages(effState) : effState;
  // Hide the inline-edited text in the SVG so it doesn't halo behind the editor.
  if (isEditingActive && UI.canvasEdit) bgState.hideText = [UI.canvasEdit.kind];
  renderHoleSignInto(bgSvgDiv, bgState, bgVar);
  const bgSvgEl = bgSvgDiv.querySelector('svg');
  if (bgSvgEl) {
    bgSvgEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    preview.appendChild(bgSvgEl);
  }

  if (!HS.activeVarId) {
    const ph = document.createElement('div');
    ph.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;color:rgba(255,255,255,.6);';
    ph.textContent = 'Select or upload a logo';
    preview.appendChild(ph);
    return;
  }

  const variation = getEffectiveVariation(activeVar);
  if (!variation) return;

  // Compute logo zone using this variation's effective template
  const lz = getLogoZone(effState, effState.templateStyle);
  const dzone = document.createElement('div');
  dzone.className = 'dzone' + (variation.logoSrc ? ' has-logo' : '');
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  dzone.style.cssText = `position:absolute;left:${pct(lz.x, HS_W)};top:${pct(lz.y, HS_H)};width:${pct(lz.w, HS_W)};height:${pct(lz.h, HS_H)};`;

  const gh = document.createElement('div'); gh.className = 'dz-guide-h'; dzone.appendChild(gh);
  const gv = document.createElement('div'); gv.className = 'dz-guide-v'; dzone.appendChild(gv);

  if (variation.logoSrc) {
    const ld = variation.logoData || { x: 50, y: 50, w: 90 };
    const wrap = document.createElement('div');
    wrap.className = 'dz-logo-wrap';
    positionWrap(wrap, ld);

    const img = document.createElement('img');
    img.className = 'placed-img';
    img.src = variation.logoSrcTight || variation.logoSrc;
    img.alt = variation.name;
    img.draggable = false;
    wrap.appendChild(img);

    const handle = document.createElement('div');
    handle.className = 'dz-resize';
    wrap.appendChild(handle);

    dzone.appendChild(wrap);
    setupHsInteraction(dzone, wrap, handle, variation);

    wrap.addEventListener('click', e => {
      e.stopPropagation();
      if (UI.hsActiveZone?.dzone === dzone) { hideHsToolbar(); return; }
      if (UI.hsActiveZone) UI.hsActiveZone.dzone.classList.remove('selected');
      UI.hsActiveZone = { dzone, variation };
      dzone.classList.add('selected');
      showHsToolbar(dzone);
    });
  } else {
    dzone.style.cursor = 'pointer';
    dzone.addEventListener('click', e => {
      e.stopPropagation();
      if (UI.hsActiveZone?.dzone === dzone) { hideHsToolbar(); return; }
      if (UI.hsActiveZone) UI.hsActiveZone.dzone.classList.remove('selected');
      UI.hsActiveZone = { dzone, variation };
      dzone.classList.add('selected');
      showHsToolbar(dzone, true);
    });
  }

  dzone.addEventListener('dragover',  e => { e.preventDefault(); dzone.classList.add('drag-over'); });
  dzone.addEventListener('dragleave', ()  => dzone.classList.remove('drag-over'));
  dzone.addEventListener('drop', e => {
    e.preventDefault();
    dzone.classList.remove('drag-over');
    if (!UI.hsDragLogoId) return;
    const logo = HS.library.find(l => l.id === UI.hsDragLogoId);
    if (!logo) return;
    variation.logoId  = logo.id;
    variation.logoSrc = logo.src;
    delete variation.sponsorText;
    if (!variation.logoData) variation.logoData = { x: 50, y: 50, w: 90 };
    prepareLogo(variation, logo.src).then(() => {
      applyFillToVariation(variation);
      renderVarList();
      if (HS.activeVarId === variation.id) renderVariationPreview();
    }).catch(() => {});
    UI.hsDragLogoId = null;
    renderVarList();
    renderVariationPreview();
  });

  preview.appendChild(dzone);

  // While editing this variation, paint the interactive template-logo slot
  // overlays on top so the user can edit slots in-place. State comes from the
  // draft (via tlSource) so changes are isolated to this variation.
  if (isEditingActive) {
    wireElementDrag(preview, 'logos');
    paintTplSlotOverlays(preview, effState);
    wireCanvasTextEditing(preview);
    // Quick-add affordance only while editing a variation (the override surface).
    wireQuickAddHover(preview);
  }
}

export function positionWrap(wrap, ld) {
  wrap.style.left   = ld.x + '%';
  wrap.style.top    = ld.y + '%';
  wrap.style.width  = ld.w + '%';
  wrap.style.height = 'auto';
}

// Render a DOM overlay for the variation's sponsor text inside the logo zone.
// Click to select, drag the corner handle to resize. Updates sponsorText.size
// live on the variation (and on HS.editingDraft.sponsorText when in editor).
export function setupHsInteraction(dz, wrap, handle, variation) {
  let mode = null;
  let startPX, startPY, startX, startY, rStartX, rStartW;

  wrap.addEventListener('pointerdown', e => {
    if (e.target === handle) return;
    mode = 'move';
    dz.classList.add('dz-adjusting');
    wrap.setPointerCapture(e.pointerId);
    startPX = e.clientX; startPY = e.clientY;
    startX  = parseFloat(wrap.style.left);
    startY  = parseFloat(wrap.style.top);
    e.preventDefault();
  });

  handle.addEventListener('pointerdown', e => {
    mode = 'resize';
    dz.classList.add('dz-adjusting');
    handle.setPointerCapture(e.pointerId);
    rStartX = e.clientX;
    rStartW = parseFloat(wrap.style.width);
    e.stopPropagation();
    e.preventDefault();
  });

  wrap.addEventListener('pointermove', e => {
    if (!mode) return;
    const ld = variation.logoData || { x: 50, y: 50, w: 90 };
    if (mode === 'move') {
      const dzRect = dz.getBoundingClientRect();
      const dx = (e.clientX - startPX) / dzRect.width  * 100;
      const dy = (e.clientY - startPY) / dzRect.height * 100;
      // Keep the logo's bounding box inside its zone so it can't overlap the
      // banner (or the opposite band). The wrap is centred on (x,y), so clamp
      // the centre by half the logo's size as a % of the zone. If the logo is
      // larger than the zone on an axis, just centre it on that axis.
      const wr = wrap.getBoundingClientRect();
      const halfW = wr.width  / dzRect.width  * 50;
      const halfH = wr.height / dzRect.height * 50;
      const clampAxis = (v, half) => half >= 50 ? 50 : Math.max(half, Math.min(100 - half, v));
      let nx = clampAxis(startX + dx, halfW);
      let ny = clampAxis(startY + dy, halfH);

      const snapX = 5 / dzRect.width  * 100;
      const snapY = 5 / dzRect.height * 100;
      const snapH = Math.abs(nx - 50) < snapX;
      const snapV = Math.abs(ny - 50) < snapY;
      if (snapH) nx = 50;
      if (snapV) ny = 50;
      dz.classList.toggle('snap-h', snapH);
      dz.classList.toggle('snap-v', snapV);

      ld.x = nx; ld.y = ny;
      variation.logoData = ld;
      positionWrap(wrap, ld);
    } else if (mode === 'resize') {
      const dzRect = dz.getBoundingClientRect();
      const delta = (e.clientX - rStartX) / dzRect.width * 100 * 2;
      const nw = Math.max(10, Math.min(300, rStartW + delta));
      const ld2 = variation.logoData || { x: 50, y: 50, w: 90 };
      ld2.w = nw;
      variation.logoData = ld2;
      positionWrap(wrap, ld2);
    }
  });

  handle.addEventListener('pointermove', e => {
    if (mode !== 'resize') return;
    const ld = variation.logoData || { x: 50, y: 50, w: 90 };
    const dzRect = dz.getBoundingClientRect();
    const delta = (e.clientX - rStartX) / dzRect.width * 100 * 2;
    const nw = Math.max(10, Math.min(300, rStartW + delta));
    ld.w = nw;
    variation.logoData = ld;
    positionWrap(wrap, ld);
  });

  const onUp = () => {
    if (!mode) return;
    mode = null;
    dz.classList.remove('dz-adjusting', 'snap-h', 'snap-v');
    renderVarList();
  };

  wrap.addEventListener('pointerup', onUp);
  handle.addEventListener('pointerup', onUp);
}

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


export function ensureHsToolbar() {
  if (document.getElementById('hsZoneToolbar')) return;
  const t = document.createElement('div');
  t.id = 'hsZoneToolbar';
  t.className = 'dz-toolbar';
  t.innerHTML = `
    <button class="dz-tb-btn" id="hsTbFill">Fill</button>
    <div class="dz-tb-sep" id="hsTbFillSep"></div>
    <button class="dz-tb-btn" id="hsTbRemove">Remove</button>
    <div class="dz-tb-sep" id="hsTbSep"></div>
    <div style="position:relative">
      <button class="dz-tb-btn" id="hsTbReplace">Replace ▾</button>
      <div class="dz-lib-picker" id="hsLibPicker" style="display:none"></div>
    </div>
    <input type="file" id="hsReplaceFile" accept="image/*" style="display:none">`;
  document.body.appendChild(t);

  document.getElementById('hsTbFill').addEventListener('click', fillHsLogo);

  document.getElementById('hsTbRemove').addEventListener('click', () => {
    if (!UI.hsActiveZone) return;
    UI.hsActiveZone.variation.logoId = null;
    UI.hsActiveZone.variation.logoSrc = null;
    delete UI.hsActiveZone.variation.sponsorText;
    hideHsToolbar();
    renderVarList();
    renderVariationPreview();
  });

  document.getElementById('hsTbReplace').addEventListener('click', e => {
    e.stopPropagation();
    const picker = document.getElementById('hsLibPicker');
    const open = picker.style.display !== 'none';
    picker.style.display = open ? 'none' : 'block';
    if (!open) renderHsLibPicker();
  });

  document.getElementById('hsReplaceFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !UI.hsActiveZone) return;
    try {
      const logo = await uploadLogo(HS.projectId, file);
      HS.library.push(logo);
      buildLibStrip();
      const capturedVar = UI.hsActiveZone.variation;
      capturedVar.logoId = logo.id;
      capturedVar.logoSrc = logo.src;
      delete capturedVar.sponsorText;
      if (!capturedVar.logoData) capturedVar.logoData = { x: 50, y: 50, w: 90 };
      prepareLogo(capturedVar, logo.src).then(() => { applyFillToVariation(capturedVar); renderVarList(); renderVariationPreview(); }).catch(() => {});
      hideHsToolbar();
      renderVarList();
      renderVariationPreview();
    } catch (err) { console.error('Upload failed', err); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#hsZoneToolbar') && !e.target.closest('.dz-logo-wrap') && !e.target.closest('.dzone')) {
      hideHsToolbar();
    }
  });
}

export function renderHsLibPicker() {
  const picker = document.getElementById('hsLibPicker');
  if (!picker || !UI.hsActiveZone) return;
  const { variation } = UI.hsActiveZone;
  const libHtml = HS.library.length
    ? HS.library.map(l => `
        <div class="dz-lp-item${variation.logoId === l.id ? ' active' : ''}" data-lid="${l.id}" title="${l.name}">
          <img src="${l.src}" alt="${l.name}">
        </div>`).join('')
    : '';
  picker.innerHTML = `
    ${libHtml}
    <div class="dz-lp-upload" id="hsLpUpload">+ Upload image</div>
    <div class="dz-lp-upload" id="hsLpText">+ Type text</div>`;

  picker.querySelectorAll('.dz-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      const logo = HS.library.find(l => l.id === el.dataset.lid);
      if (!logo || !UI.hsActiveZone) return;
      const pickedVar = UI.hsActiveZone.variation;
      pickedVar.logoId = logo.id;
      pickedVar.logoSrc = logo.src;
      delete pickedVar.sponsorText;
      if (!pickedVar.logoData) pickedVar.logoData = { x: 50, y: 50, w: 90 };
      prepareLogo(pickedVar, logo.src).then(() => { applyFillToVariation(pickedVar); renderVarList(); renderVariationPreview(); }).catch(() => {});
      hideHsToolbar();
      renderVarList();
      renderVariationPreview();
    });
  });
  picker.querySelector('#hsLpUpload')?.addEventListener('click', () => {
    document.getElementById('hsReplaceFile').click();
  });
  picker.querySelector('#hsLpText')?.addEventListener('click', () => {
    if (!UI.hsActiveZone) return;
    const v = UI.hsActiveZone.variation;
    v.logoId = null;
    v.logoSrc = null;
    if (!v.sponsorText || !v.sponsorText.text || !v.sponsorText.text.trim()) {
      v.sponsorText = {
        text: v.name || 'Sponsor name',
        font: HS.topText?.font || 'dm-serif',
        size: 300,
        color: HS.topText?.color || '#111110',
      };
    }
    hideHsToolbar();
    renderVarList();
    renderVariationPreview();
  });
}

export function showHsToolbar(dz, openPicker = false) {
  ensureHsToolbar();
  const v = UI.hsActiveZone?.variation;
  const hasLogo = !!v?.logoSrc;
  const hasText = !!(v?.sponsorText?.text && v.sponsorText.text.trim());
  const hasContent = hasLogo || hasText;
  document.getElementById('hsTbFill').style.display    = hasLogo ? '' : 'none';
  document.getElementById('hsTbFillSep').style.display = hasLogo ? '' : 'none';
  document.getElementById('hsTbRemove').style.display  = hasContent ? '' : 'none';
  document.getElementById('hsTbSep').style.display     = hasContent ? '' : 'none';
  document.getElementById('hsTbReplace').textContent   = hasLogo ? 'Replace ▾' : hasText ? 'Change ▾' : 'Add logo or text ▾';

  const picker = document.getElementById('hsLibPicker');
  picker.style.display = openPicker ? 'block' : 'none';
  if (openPicker) renderHsLibPicker();

  const tb = document.getElementById('hsZoneToolbar');
  tb.style.display = 'flex';
  const dzRect = dz.getBoundingClientRect();
  const tbH = tb.offsetHeight || 36;
  const topAbove = dzRect.top + window.scrollY - tbH - 6;
  const topBelow = dzRect.bottom + window.scrollY + 6;
  const top = dzRect.top > tbH + 20 ? topAbove : topBelow;
  tb.style.left = Math.max(8, dzRect.left + window.scrollX) + 'px';
  tb.style.top  = top + 'px';
}
