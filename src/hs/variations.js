import { HS, UI, getEffectiveState, getEffectiveVariation, isVarCustomized, mergeBanner, findLogo } from './state.js';
import { mergeLibraries } from '../state.js';
import { goStep, updateSidebar } from './app.js';
import { cloneTemplateLogos, layoutPreviewState, loadCustomTemplates, templatePreviewState } from './design.js';
import { saveDraftInternal } from './draft.js';
import { addLogoLayer, hideHsToolbar, removeBgFromLogo } from './logo-utils.js';
import { HS_DEFAULT_TEMPLATES, HS_TEMPLATES, HS_W, HS_H, bannerDockSpecsFor } from '../hole-sign-data.js';
import { logoThumbHtml } from '../media-utils.js';
import { renderLogoTray } from '../logo-tray.js';
import { renderLogosTileShell } from '../sidebar.js';
import { renderEditRequestsPanel } from '../edit-requests-panel.js';
import { renderVariationList } from '../variation-list.js';
import { escXml, renderHoleSignInto } from '../hole-sign-render.js';
import { deleteLogo, uploadLogo, uploadUserLogo, deleteUserLogo, saveHsOneOffs, resolveFeedback, deleteFeedbackForVariation, adoptFeedbackLogo } from '../supabase.js';
import { applyHsZoom, initHsVarCanvas, renderVariationPreview } from './var-canvas.js';
import { renderEditor } from './var-editor.js';
import { openDefaultsPanel } from './defaults.js';

// ── Step 2: Variations ─────────────────────────────────────

export function renderStep2() {
  const panel = document.getElementById('panel-2');
  panel.innerHTML = `
    <div class="hs-design-layout">
      <div class="hs-design-preview-col">
        <div class="var-canvas-panel hs-canvas-bare" id="hsCanvasPanel"></div>
      </div>
      <div class="hs-design-controls">
        <div class="hs-design-controls-body">
          <div class="hs-stack-section">
            <div class="var-list-header" id="hsVarListHeader">
              <div class="var-list-title">Variations</div>
              <div class="add-var-wrap" id="addVarWrap">
                <button class="add-var-trigger" onclick="toggleAddVarMenu(event)">+ Add ▾</button>
                <button class="add-var-upload-btn" title="Upload custom design" onclick="document.getElementById('hsCustomArtboardFile').click()">
                  <i class="fa-solid fa-circle-arrow-up" aria-hidden="true"></i>
                </button>
                <div class="add-var-dropdown" id="addVarDropdown">
                  <button class="add-var-opt" onclick="addEmptyHsVar();closeAddVarMenu()">New variation</button>
                  <button class="add-var-opt" onclick="openDefaultsPanel();closeAddVarMenu()">Default sign</button>
                </div>
                <input type="file" id="hsCustomArtboardFile" accept="image/*,.pdf,.ai,.eps" multiple style="display:none">
              </div>
            </div>
            <div class="var-list" id="hsVarList"></div>
          </div>
        </div>
      </div>
    </div>`;
  document.getElementById('sidebarPanelHeader').innerHTML = `
    <div class="p1-header hs-panel-header">
      <div>
        <div class="ptitle">Hole Signs</div>
        <div class="psub">Upload sponsor logos and build one variation per sponsor. <strong>Each sign is printed front and back</strong> with the same design.</div>
      </div>
      <div class="p1-header-actions">
        <button class="btn primary" onclick="goStep(3)">Review &amp; export <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        <button class="btn sm save-draft-btn" id="saveDraftBtn" onclick="saveDraft()" style="display:none">Save draft</button>
      </div>
    </div>`;
  renderLogosTileShell('Logos', 'hsLibStrip');

  document.getElementById('hsCustomArtboardFile').addEventListener('change', handleHsArtboardUpload);
  initHsVarCanvas(document.getElementById('hsCanvasPanel'));
  applyHsZoom(UI.hsZoom);

  buildLibStrip();
  renderVarList();
  updateHsEditRequestsBanner();
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
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (!files.length) return;

  // Each file becomes its own variation; uploads run independently so one
  // slow/failed file doesn't hold up the others.
  await Promise.all(files.map(uploadArtboardVariation));
}

async function uploadArtboardVariation(file) {
  // Add a placeholder tile immediately so the user sees the card appear right away
  const varId = crypto.randomUUID();
  const newVar = {
    id: varId,
    name: file.name.replace(/\.[^.]+$/, ''),
    artboardSrc: null,
    loading: true,
    logos: [],
  };
  HS.variations.push(newVar);
  HS.activeVarId = varId;
  updateSidebar();
  renderVarList();

  try {
    const logo = await uploadLogo(HS.projectId, file);
    newVar.artboardSrc = logo.src;
    delete newVar.loading;
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
  renderLogoTray(document.getElementById('hsLibStrip'), {
    library: HS.library,
    fileInputId: 'hsLogoFile',
    accept: 'image/*,.pdf,.ai,.eps',
    onUpload: handleHsLogoUpload,
    onDragStart: logo => { UI.hsDragLogoId = logo.id; },
    onDragEnd: () => { UI.hsDragLogoId = null; },
    onDelete: logo => deleteHsLibLogo(logo),
    onRemoveBg: async (logo, onProgress) => {
      const newLogo = await removeBgFromLogo(logo, onProgress);
      // Replace in-place so no new library entry is created
      const origIdx = HS.library.indexOf(logo);
      if (origIdx >= 0) HS.library.splice(origIdx, 1, newLogo);
      else HS.library.push(newLogo);
      HS.variations.forEach(vv => {
        (vv.logos || []).forEach(layer => {
          if (layer.logoId === logo.id) {
            layer.logoId = newLogo.id;
            layer.logoSrc = newLogo.src;
            delete layer.logoSrcTight; delete layer.logoAspect; delete layer.logoArtworkBounds;
          }
        });
      });
      buildLibStrip();
      renderVarList();
    },
  });
}

export async function deleteHsLibLogo(logo) {
  if (!confirm(`Delete logo "${logo.name}"? Variations using it will lose their logo.`)) return;
  HS.variations.forEach(v => {
    v.logos = (v.logos || []).filter(layer => layer.logoId !== logo.id);
  });
  HS.library = HS.library.filter(l => l.id !== logo.id);
  buildLibStrip();
  renderVarList();
  renderVariationPreview();
  hideHsToolbar();
  if (logo.storagePath) {
    try {
      await (logo.shared ? deleteUserLogo(logo.storagePath, logo.id) : deleteLogo(logo.storagePath, logo.id));
    }
    catch (err) { console.error('Storage delete failed', err); }
  }
}

// Every upload becomes a shared logo (user_logos), reusable across all of
// this user's projects — one flat "Logos" section, not a project-only vs.
// shared split. Logos already on the project from before this change
// (project_logos rows, loaded alongside the shared ones in mergeLibraries())
// keep showing here too and stay deletable via deleteLogo — only a newly
// uploaded logo is tagged `shared: true`.
async function handleHsLogoUpload(files) {
  showHsCanvasUploadSpinner();
  try {
    for (const file of files) {
      // Optimistic placeholder — shown immediately (as a spinner tile, see
      // logo-tray.js) so the tray doesn't sit idle for the whole upload,
      // then swapped in-place for the real logo once it lands.
      const tempId = 'tmp-' + crypto.randomUUID();
      HS.library.push({ id: tempId, name: file.name.replace(/\.[^.]+$/, ''), uploading: true });
      buildLibStrip();
      try {
        const logo = await uploadUserLogo(file);
        logo.shared = true;
        const idx = HS.library.findIndex(l => l.id === tempId);
        if (idx !== -1) HS.library.splice(idx, 1, logo);
        else HS.library.push(logo);
        addVariationForLogo(logo);
        buildLibStrip();
        renderVarList();
      } catch (err) {
        console.error('Logo upload failed', err);
        HS.library = HS.library.filter(l => l.id !== tempId);
        buildLibStrip();
      }
    }
  } finally {
    hideHsCanvasUploadSpinner();
  }
}

function showHsCanvasUploadSpinner() {
  const panel = document.getElementById('hsCanvasPanel');
  if (!panel || document.getElementById('hsCanvasUploadOverlay')) return;
  const el = document.createElement('div');
  el.id = 'hsCanvasUploadOverlay';
  el.className = 'hs-canvas-upload-overlay';
  el.innerHTML = '<div class="hs-upload-spinner"></div>';
  panel.appendChild(el);
}

function hideHsCanvasUploadSpinner() {
  document.getElementById('hsCanvasUploadOverlay')?.remove();
}

export function addVariationForLogo(logo) {
  const variation = {
    id: crypto.randomUUID(),
    name: logo.name,
    templateId: HS.templateStyle,
    logos: [],
  };
  HS.variations.push(variation);
  updateSidebar();
  selectVariation(variation.id);
  const p = addLogoLayer(variation, logo); // synchronously pushes the loading layer
  renderVarList();
  renderVariationPreview();
  p.then(() => {
    renderVarList();
    if (HS.activeVarId === variation.id) renderVariationPreview();
  }).catch(() => renderVarList());
}

export function selectVariation(id) {
  HS.activeVarId = id;
  UI.activeDefaultId = null;
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
}

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
  const activeSourceKind = v.template?.sourceKind || null;
  const activeSourceId   = v.template?.sourceId || null;

  let triggerLabel;
  if (activeSourceKind === 'custom') {
    const c = customs.find(t => t.id === activeSourceId);
    triggerLabel = c ? c.name : 'Custom template';
  } else if (activeSourceKind === 'default') {
    const d = HS_DEFAULT_TEMPLATES.find(t => t.id === activeSourceId);
    triggerLabel = d ? d.name : 'Starter template';
  } else {
    triggerLabel = (HS_TEMPLATES.find(t => t.id === activeLayoutId) || HS_TEMPLATES[0]).name;
  }

  // A tile shows the template's own default look — including this
  // variation's real logo/sponsor text composited in — not a generic
  // placeholder, so picking one is a genuine visual comparison.
  const tile = (thumbId, key, name, active) => `
    <div class="hs-var-tmpl-gtile${active ? ' active' : ''}" onclick="setVarTemplate('${key}')">
      <div class="hs-var-tmpl-gthumb" id="${thumbId}"></div>
      <div class="hs-var-tmpl-gname">${escXml(name)}</div>
    </div>`;

  const layoutTiles = HS_TEMPLATES.map(t =>
    tile('hs-vgal-l-' + t.id, t.id, t.name, !activeSourceKind && activeLayoutId === t.id)).join('');
  const starterTiles = HS_DEFAULT_TEMPLATES.map(t =>
    tile('hs-vgal-d-' + t.id, 'default:' + t.id, t.name, activeSourceKind === 'default' && activeSourceId === t.id)).join('');
  const customTiles = customs.length
    ? customs.map(t => tile('hs-vgal-c-' + t.id, 'custom:' + t.id, t.name, activeSourceKind === 'custom' && activeSourceId === t.id)).join('')
    : '<div class="hs-var-tmpl-opt-empty">No saved templates yet</div>';

  row.innerHTML = `
    <span class="hs-var-tmpl-label">Template</span>
    <div class="hs-var-tmpl-picker">
      <button class="hs-var-tmpl-trigger" onclick="toggleVarTmplMenu(event)">
        <span>${escXml(triggerLabel)}</span><span class="caret">▾</span>
      </button>
      <div class="hs-var-tmpl-menu hs-var-tmpl-gallery-menu" id="hsVarTmplMenu" style="display:none">
        <div class="hs-var-tmpl-group-label">Layouts</div>
        <div class="hs-var-tmpl-gallery">${layoutTiles}</div>
        <div class="hs-var-tmpl-sep"></div>
        <div class="hs-var-tmpl-group-label">Starter templates</div>
        <div class="hs-var-tmpl-gallery">${starterTiles}</div>
        <div class="hs-var-tmpl-sep"></div>
        <div class="hs-var-tmpl-group-label">My templates</div>
        <div class="hs-var-tmpl-gallery">${customTiles}</div>
        ${(v.template || (v.templateId && v.templateId !== HS.templateStyle)) ? `
          <div class="hs-var-tmpl-sep"></div>
          <div class="hs-var-tmpl-opt" onclick="setVarTemplate('__default__')">
            <span style="color:var(--gray-600)">Use project default</span>
          </div>` : ''}
      </div>
    </div>`;

  const eVar = getEffectiveVariation(v);
  HS_TEMPLATES.forEach(t => {
    const el = document.getElementById('hs-vgal-l-' + t.id);
    if (el) renderHoleSignInto(el, layoutPreviewState(t.id), eVar);
  });
  HS_DEFAULT_TEMPLATES.forEach(t => {
    const el = document.getElementById('hs-vgal-d-' + t.id);
    if (el) renderHoleSignInto(el, templatePreviewState(t), eVar);
  });
  customs.forEach(t => {
    const el = document.getElementById('hs-vgal-c-' + t.id);
    if (el) renderHoleSignInto(el, templatePreviewState(t), eVar);
  });
}

// Positions the gallery dropdown as a viewport-fixed panel, anchored to the
// trigger button's live screen position, rather than document-flow
// (position:absolute under the trigger). The trigger sits at the bottom of
// the Variations canvas, inside an app shell with no page-level scroll — an
// absolute panel opening downward from there renders past the bottom of the
// viewport with no way to scroll down and reach it. Opens upward instead
// when there isn't enough room below, and always clamps its own height to
// whatever space is actually available so its own scrollbar (see
// .hs-var-tmpl-menu's overflow-y) can reach every tile.
function positionVarTmplMenu(menu, trigger) {
  const r = trigger.getBoundingClientRect();
  const gap = 4;
  const margin = 12;
  const width = Math.max(r.width, 280);
  const spaceBelow = window.innerHeight - r.bottom - gap - margin;
  const spaceAbove = r.top - gap - margin;
  const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
  menu.style.maxHeight = Math.max(160, Math.min(480, openUp ? spaceAbove : spaceBelow)) + 'px';
  menu.style.width = width + 'px';
  menu.style.left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin)) + 'px';
  if (openUp) {
    menu.style.top = 'auto';
    menu.style.bottom = (window.innerHeight - r.top + gap) + 'px';
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = (r.bottom + gap) + 'px';
  }
}

window.toggleVarTmplMenu = function (e) {
  e?.stopPropagation();
  const menu = document.getElementById('hsVarTmplMenu');
  if (!menu) return;
  const open = menu.style.display !== 'none';
  if (open) { menu.style.display = 'none'; return; }
  positionVarTmplMenu(menu, e.currentTarget);
  menu.style.display = 'block';
  const close = ev => {
    if (!ev.target.closest('.hs-var-tmpl-picker')) {
      menu.style.display = 'none';
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
};

// Snapshots a template's full look onto `v.template` — background, text
// bands, both banners, and template logos — and reseeds `v.textLayers`'
// docked caption layers to the template's own defaults (dropping the old
// template's docked layers, keeping any free-floating ones this variation
// already had). Mirrors setDraftTmpl's custom/default branches
// (var-editor.js) so picking a template from the Variations-page quick
// picker and from the full per-variation editor produce identical results.
export function applyVarTemplateSpec(v, tmpl, sourceKind) {
  v.template = {
    sourceKind,
    sourceId:      tmpl.id,
    templateStyle: tmpl.templateStyle,
    background:    { ...tmpl.background },
    topText:       { ...tmpl.topText },
    bottomText:    { ...tmpl.bottomText },
    bannerTop:     mergeBanner(tmpl.bannerTop    || (tmpl.banner?.position !== 'bottom' ? tmpl.banner : null)),
    bannerBottom:  mergeBanner(tmpl.bannerBottom || (tmpl.banner?.position === 'bottom' ? tmpl.banner : null)),
    templateLogos: cloneTemplateLogos(tmpl.templateLogos),
  };
  v.templateId = tmpl.templateStyle;
  const base = (v.textLayers !== undefined ? v.textLayers : (HS.textLayers || [])).filter(l => !l.dock).map(l => ({ ...l }));
  bannerDockSpecsFor(tmpl).forEach(spec => {
    base.push({ ...spec, id: 'tl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) });
  });
  v.textLayers = base;
}

// ── Apply a customer's requested quick-pick change (see review.js's
// Request-edits quick-picks and the variation_feedback.requested_* columns)
// straight onto a variation. Colors/logo use the same sparse per-variation
// override fields a designer's own quick-edit already writes
// (backgroundOverride/topTextOverride/bottomTextOverride/templateLogoOverrides,
// merged in getEffectiveState — src/hs/state.js) so position/layout stay
// untouched; template uses the full-snapshot path above since a template
// swap is itself a layout change. Exported (rather than kept as window.*
// handlers like most of this file) so both hs/export.js's Gallery-step
// per-card buttons and the edit-requests panel (openHsEditRequests below) can
// apply the same requested change without duplicating the logic.
export function applyRequestedHsTemplate(v, fb) {
  if (!fb?.requested_template_id) return false;
  const key = fb.requested_template_id;
  if (!key.startsWith('default:')) return false;
  const tmpl = HS_DEFAULT_TEMPLATES.find(t => t.id === key.slice(8));
  if (!tmpl) return false;
  applyVarTemplateSpec(v, tmpl, 'default');
  return true;
}

export function applyRequestedHsColors(v, fb) {
  if (!fb?.requested_colors) return false;
  const { background, topText, bottomText } = fb.requested_colors;
  if (background) v.backgroundOverride = { ...(v.backgroundOverride || {}), color: background };
  if (topText)    v.topTextOverride    = { ...(v.topTextOverride    || {}), color: topText };
  if (bottomText) v.bottomTextOverride = { ...(v.bottomTextOverride || {}), color: bottomText };
  return true;
}

// One requested_colors key applied on its own (see hsColorFields below) — the
// edit-requests panel's Colors section registers one .erm-section per key
// rather than one "apply everything" field, so staff can accept e.g. just
// the background color without also taking the text colors. Overrides are
// always named "<key>Override" (backgroundOverride/topTextOverride/
// bottomTextOverride), so this stays generic across all three.
function applyRequestedHsColorKeyTo(v, fb, key) {
  const hex = fb?.requested_colors?.[key];
  if (!hex) return false;
  const overrideKey = key + 'Override';
  v[overrideKey] = { ...(v[overrideKey] || {}), color: hex };
  return true;
}

// Slot 0 only — the simplest defensible default given the feedback row
// carries no signal for which of N template-logo slots was meant (mirrors
// the flags side's single-primary-placement assumption). The reviewer's
// uploaded file already lives in the flag-logos bucket (see uploadFeedbackLogo
// in review.js) but, unlike a staff-uploaded logo, has no project_logos row
// yet — adopt it into the real library (adoptFeedbackLogo) so it shows up in
// the Logos tray for reuse and survives a reload. Dedupe on storage path so
// re-applying (or "Apply all") doesn't insert a second row for the same file.
export async function applyRequestedHsLogo(v, fb) {
  if (!fb?.requested_logo_url) return false;
  let entry = HS.library.find(l => l.storagePath && l.storagePath === fb.requested_logo_path);
  if (!entry) {
    entry = fb.requested_logo_path
      ? await adoptFeedbackLogo(HS.projectId, 'Requested logo', fb.requested_logo_url, fb.requested_logo_path)
      : { id: 'fb-' + fb.id, name: 'Requested logo', src: fb.requested_logo_url };
    HS.library.push(entry);
    buildLibStrip();
  }
  v.templateLogoOverrides = { ...(v.templateLogoOverrides || {}), 0: { logoId: entry.id, logoSrc: entry.src } };
  return true;
}

// A throwaway copy of `v` with every present requested_* field merged on
// top — never mutates the real variation — so the row's combined preview
// shows what it would look like with everything applied together, not just
// its current (unmodified) state. Unlike the flags side, no library entry is
// needed for the logo case: hole-sign template-logo slots carry their image
// src inline (logoSrc), not a library lookup.
function previewHsVariation(v, fb) {
  const preview = { ...v };
  if (fb?.requested_template_id?.startsWith('default:')) {
    const tmpl = HS_DEFAULT_TEMPLATES.find(t => t.id === fb.requested_template_id.slice(8));
    if (tmpl) applyVarTemplateSpec(preview, tmpl, 'default');
  }
  if (fb?.requested_colors) {
    const { background, topText, bottomText } = fb.requested_colors;
    if (background) preview.backgroundOverride = { ...(v.backgroundOverride || {}), color: background };
    if (topText)    preview.topTextOverride    = { ...(v.topTextOverride    || {}), color: topText };
    if (bottomText) preview.bottomTextOverride = { ...(v.bottomTextOverride || {}), color: bottomText };
  }
  if (fb?.requested_logo_url) {
    preview.templateLogoOverrides = { ...(v.templateLogoOverrides || {}), 0: { logoId: 'preview', logoSrc: fb.requested_logo_url } };
  }
  return preview;
}

const HS_COLOR_LABELS = { background: 'Background', topText: 'Top text', bottomText: 'Bottom text' };

// One .erm-section per requested_colors key actually present in ANY pending
// request in this panel (not just this row) — mirrors flags/variations.js's
// zoneColorFields, same reasoning: Colors stops being a single
// lumped-together field so staff can accept, say, just the background color
// without also taking the text colors.
function hsColorFields() {
  const keys = new Set();
  (HS.feedback || []).forEach(fb => {
    if (fb.status === 'needs_edits') Object.keys(fb.requested_colors || {}).forEach(k => keys.add(k));
  });
  return [...keys].map(key => ({
    key: 'color-' + key,
    sectionLabel: HS_COLOR_LABELS[key] || key,
    has: fb => !!fb.requested_colors?.[key],
    apply: (v, fb) => applyRequestedHsColorKeyTo(v, fb, key),
    preview: (el, fb) => {
      const hex = fb.requested_colors?.[key];
      const safe = /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : '#cccccc';
      el.innerHTML = `
        <div class="erm-color-editor">
          <div class="erm-color-dot" style="background:${safe}"></div>
          <input type="text" class="hexin" value="${escXml(hex || '')}" readonly>
        </div>`;
    },
  }));
}

// ── "View edits" — reachable two ways, both opening the same in-panel
// sub-view (edit-requests-panel.js) in place of the right-hand "Variations"
// list: a specific variation's own "View edits" link (its card, via
// renderVarList's onViewEdits) passes that variation's id to show just its
// request; the canvas banner's "View all edits" (project-global — see
// updateHsEditRequestsBanner) omits it to show every open request.
window.openHsEditRequests = function (variationId) {
  const list = document.getElementById('hsVarList');
  if (!list) return;
  document.getElementById('hsVarListHeader')?.style.setProperty('display', 'none');
  renderEditRequestsPanel(list, {
    variations: HS.variations,
    feedback: HS.feedback || [],
    renderThumb: (el, v, fb) => {
      const preview = previewHsVariation(v, fb);
      renderHoleSignInto(el, getEffectiveState(preview), getEffectiveVariation(preview));
    },
    thumbAspect: `${HS_W}/${HS_H}`,
    filterVariationId: variationId,
    fields: [
      {
        key: 'template', sectionLabel: 'Template', has: fb => !!fb.requested_template_id, apply: (v, fb) => applyRequestedHsTemplate(v, fb),
        preview: (el, fb) => {
          const key = fb.requested_template_id || '';
          if (!key.startsWith('default:')) return;
          const tmpl = HS_DEFAULT_TEMPLATES.find(t => t.id === key.slice(8));
          if (!tmpl) return;
          const thumb = document.createElement('div');
          thumb.className = 'erm-style-preview';
          el.appendChild(thumb);
          renderHoleSignInto(thumb, templatePreviewState(tmpl));
        },
      },
      ...hsColorFields(),
      {
        key: 'logo', sectionLabel: 'Logos', has: fb => !!fb.requested_logo_url, apply: (v, fb) => applyRequestedHsLogo(v, fb),
        preview: (el, fb) => { el.innerHTML = `<img src="${escXml(fb.requested_logo_url)}" alt="">`; },
      },
    ],
    resolve: vid => resolveFeedback(HS.projectId, 'hole-signs', vid),
    onApplied: v => {
      if (v.id === HS.activeVarId) renderVariationPreview();
      updateHsEditRequestsBanner();
    },
    persist: () => saveDraftInternal(),
    onBack: () => {
      document.getElementById('hsVarListHeader')?.style.removeProperty('display');
      list.innerHTML = '';
      renderVarList();
    },
  });
};

// Global (project-wide, not scoped to the active variation) banner shown
// above the canvas whenever ANY variation has an open edit request — the
// entry point into the unfiltered edit-requests panel regardless of which
// variation happens to be selected. A specific variation's own request is
// reachable from its card instead (see the "View edits" link wired in
// renderVarList above).
export function updateHsEditRequestsBanner() {
  const noteEl = document.getElementById('hsVarEditNote');
  const noteTextEl = document.getElementById('hsVarEditNoteText');
  if (!noteEl || !noteTextEl) return;
  const pending = (HS.feedback || []).filter(f => f.status === 'needs_edits' && !f.resolved && HS.variations.some(v => v.id === f.variation_id)).length;
  noteEl.style.display = pending ? '' : 'none';
  if (pending) noteTextEl.textContent = `${pending} variation${pending === 1 ? '' : 's'} need${pending === 1 ? 's' : ''} edits`;
}

window.setVarTemplate = function (key) {
  const v = HS.variations.find(v => v.id === HS.activeVarId);
  if (!v) return;
  if (key === '__default__') {
    delete v.template;
    delete v.templateId;
    delete v.textLayers;
  } else if (key.startsWith('custom:')) {
    const tmpl = loadCustomTemplates().find(t => t.id === key.slice(7));
    if (!tmpl) return;
    applyVarTemplateSpec(v, tmpl, 'custom');
  } else if (key.startsWith('default:')) {
    const tmpl = HS_DEFAULT_TEMPLATES.find(t => t.id === key.slice(8));
    if (!tmpl) return;
    applyVarTemplateSpec(v, tmpl, 'default');
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

function renderHsVarThumb(el, v) {
  el.style.position = 'relative';
  // While uploading, show a spinner
  if (v.loading) {
    el.innerHTML = '<div class="hs-vthumb-uploading"><div class="hs-upload-spinner"></div></div>';
    return;
  }
  // Artboard variations render through the same SVG builder as everything
  // else — makeHoleSignSvg paints the artboard image below the frame group,
  // so banner/template-logo dressing still shows on top of it here exactly
  // as it does on the live canvas.
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
}

export function renderVarList() {
  const list = document.getElementById('hsVarList');
  if (!list) return;
  // The edit-requests panel (openHsEditRequests) also renders into this same
  // container, in place of the card list — a background refresh (e.g. a
  // realtime feedback update while it's open) must not stomp it. Its own
  // "Back" clears the container first, so this only guards passive refreshes.
  if (list.querySelector('#erpList')) return;
  // UI.hsFullEditorOpen (not just editingVarId/editingDraft) — a quick-edit
  // draft (see beginQuickEdit in var-editor.js) sets those same fields but
  // must not pop the full side-panel editor open.
  if (UI.hsFullEditorOpen && HS.editingVarId && HS.editingDraft) {
    renderEditor();
    return;
  }

  if (!HS.variations.length && !HS.defaults.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--gray-400);text-align:center;padding:1rem 0">No variations yet. Upload a logo to add one.</div>';
    return;
  }

  // renderEditor() replaces #hsVarList's own innerHTML while editing, so
  // these sub-containers are rebuilt fresh on every call rather than reused.
  list.innerHTML = '<div class="var-list" id="hsVarCards"></div><div class="var-list" id="hsDefaultCards"></div>';
  const varsEl = document.getElementById('hsVarCards');
  const defsEl = document.getElementById('hsDefaultCards');

  renderVariationList(varsEl, HS.variations, {
    activeId: HS.activeVarId,
    thumbId: v => 'hsvt-' + v.id,
    thumbClass: 'hs-vthumb',
    renderThumb: renderHsVarThumb,
    feedbackFor: v => HS.feedback?.find(f => f.variation_id === v.id),
    badgeFor: v => isVarCustomized(v)
      ? '<span class="var-custom-badge">Customized</span>' : '',
    onSelect: v => window.startEditVar(v.id),
    onRename: (v, name) => { v.name = name; },
    onEdit: v => window.startEditVar(v.id),
    onDuplicate: v => dupHsVar(v.id),
    onDelete: v => deleteHsVar(v.id),
    onQtyChange: (v, qty) => { v.qty = qty; },
    onViewEdits: v => window.openHsEditRequests(v.id),
  });

  // Dropping a dragged library logo directly onto a variation card assigns
  // it to that variation — extra behavior beyond the shared card template,
  // wired separately since it doesn't exist for the flags list.
  HS.variations.forEach(v => {
    const card = varsEl.querySelector(`.var-card[data-varid="${v.id}"]`);
    if (!card) return;
    card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', e => { if (!card.contains(e.relatedTarget)) card.classList.remove('drag-over'); });
    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const logo = UI.hsDragLogoId ? findLogo(UI.hsDragLogoId) : null;
      if (!logo) return;
      UI.hsDragLogoId = null;
      // Update only this card's thumbnail — avoids tearing down all event listeners
      const refreshThumb = () => {
        const thumb = document.getElementById('hsvt-' + v.id);
        if (thumb) renderHsVarThumb(thumb, v);
      };
      // Always ADDS a new layer (see addLogoLayer in logo-utils.js) — dropping
      // onto a variation's card never overwrites a logo it already has.
      const isFullGraphic = getEffectiveState(v).templateStyle === 'hole-sign-full-graphic';
      const p = addLogoLayer(v, logo, { isFullGraphic });
      refreshThumb();
      if (HS.activeVarId === v.id) renderVariationPreview();
      p.then(() => {
        refreshThumb();
        if (HS.activeVarId === v.id) renderVariationPreview();
      }).catch(() => refreshThumb());
    });
  });

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
        <button class="vbtn" title="Remove" aria-label="Remove" onclick="event.stopPropagation();removeHsDefault('${d.id}')"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
    </div>`;
  }).join('');
  defsEl.innerHTML = defaultHtml;
}

// Clone a variation's full state (template override, sponsor text, logo
// placement) under a new id — matches flags' dupVar. Templates/logo data are
// deep-copied so editing the copy never mutates the source.
function dupHsVar(id) {
  const src = HS.variations.find(v => v.id === id);
  if (!src) return;
  const nv = { ...src, id: crypto.randomUUID(), name: src.name + ' copy' };
  // Fresh id per layer, or a duplicated variation would share its source's
  // layer object references — dragging one copy's logo would move the other's.
  nv.logos = (src.logos || []).map(layer => ({ ...layer, id: crypto.randomUUID() }));
  if (src.template) {
    // Only rebuild the fields the source actually overrides — spreading an
    // absent field (e.g. `{ ...undefined }`) yields a truthy `{}`, which
    // getEffectiveState would then treat as a real override and blank out
    // that piece of the global template instead of leaving it untouched.
    nv.template = { ...src.template };
    if (src.template.background)    nv.template.background    = { ...src.template.background };
    if (src.template.topText)       nv.template.topText       = { ...src.template.topText };
    if (src.template.bottomText)    nv.template.bottomText    = { ...src.template.bottomText };
    if (src.template.templateLogos) nv.template.templateLogos = cloneTemplateLogos(src.template.templateLogos);
  }
  if (src.sponsorText) nv.sponsorText = { ...src.sponsorText };
  HS.variations.push(nv);
  updateSidebar();
  selectVariation(nv.id);
}

function deleteHsVar(id) {
  HS.variations = HS.variations.filter(v => v.id !== id);
  if (HS.activeVarId === id) HS.activeVarId = HS.variations[0]?.id || null;
  if (HS.editingVarId === id) { HS.editingVarId = null; HS.editingDraft = null; }
  HS.feedback = (HS.feedback || []).filter(f => f.variation_id !== id);
  updateSidebar();
  renderVarList();
  renderVariationPreview();
  updateHsEditRequestsBanner();
  deleteFeedbackForVariation(HS.projectId, 'hole-signs', id).catch(() => {});
}

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

export function createEmptyVariation(name) {
  return {
    id: crypto.randomUUID(),
    name,
    templateId: HS.templateStyle,
    logos: [],
  };
}

window.addEmptyHsVar = function () {
  const v = createEmptyVariation('Variation ' + (HS.variations.length + 1));
  HS.variations.push(v);
  updateSidebar();
  selectVariation(v.id);
};
