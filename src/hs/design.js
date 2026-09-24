import { HS, UI, defaultCaptionsEdited, eyedropperBtn, mergeBanner } from './state.js';
import './text-layers.js';
import { goStep } from './app.js';
import { HS_BANNER_EDGE_PX, bannerSource, clearBannerPreview, dockOverlapHit, getDockedSiblings, hitTestDockZone, previewLogoZoneShrink, redrawBannerStructural, reflowBannerSvg, renderBannerSection, showBannerPreview, showBannerShrinkGhost, syncDockedLayerOverlays, syncLogoZone, wireBannerHeightHandles, wireBannerSpacingHandles, wireCanvasTextEditing, wireElementDrag } from './banner.js';
import { applyTlSlotImgStyle, openTlLibPicker, openTlSidePanel, openTlSlotToolbar, closeTlSlotToolbar, deselectTlSlots, redrawTplPreview, renderTemplateLogoControls, renderTemplateLogoTileItems, renderTplSlotBody, snapTlSlotsToDefaults, tlSource } from './template-logos.js';
import { applyHsStep1Zoom, initHsStep1Canvas } from './var-canvas.js';
import { applyQuickLogoSlot, applyQuickTextLayer, beginQuickEdit } from './var-editor.js';
import { cropSvgToArtwork, hideHsToolbar } from './logo-utils.js';
import { saveDraftInternal } from './draft.js';
import { HS_DEFAULT_TEMPLATES, HS_FONTS, HS_H, HS_TEMPLATES, HS_W, bannerDockSpecsFor, emptyBanner, emptyTemplateLogos } from '../hole-sign-data.js';
import { dockedLayerPositions, dockedLayers, escXml, getBannerRect, getLogoZone, getTemplateLogoSlots, renderHoleSignInto } from '../hole-sign-render.js';
import { wrapText } from '../text-utils.js';
import { uploadLogo } from '../supabase.js';
import { fileTypeLabel, isDisplayableImage } from '../media-utils.js';
import { clampPanToBg, clipToCanvas, createImageBox, layoutImgDragThumb, loadNaturalImgSize } from '../image-box.js';
import { findAxisSnap, hideAlignGuides, setAlignGuide } from '../align-guides.js';
import { commitActiveCanvasEdit, positionFloatingToolbar } from '../dom-utils.js';
import { renderLogosTileShell } from '../sidebar.js';

// Snapshot, at the very start of capture phase, whether a banner/text/image
// element was selected right before this click — registered once here (on
// `window`, so it fires ahead of the document-level capture listeners that
// close/deselect those elements — see text-layers.js's and banner.js's own
// "click outside closes it" listeners) rather than per-render. The
// background click handler below (in updateStep1Preview) reads this instead
// of the live UI flags, which may already have been nulled out by one of
// those other listeners by the time it runs: without it, tapping the
// background to deselect a banner/text/image would look identical to
// tapping it with nothing selected, and wrongly also open the Background
// section.
let hadSelectionBeforeClick = false;
window.addEventListener('click', () => {
  hadSelectionBeforeClick = !!(UI.activeTextLayerId || UI.editingTextLayerId || UI.canvasSelectedKind || UI.canvasEdit || UI.tlSelectedIdxs.size);
}, true);

// Color and image are independent layers, not exclusive alternatives — color
// is always painted (defaults to white) as the absolute-back layer, and an
// image, if set, paints on top of it (see makeHoleSignSvg in
// hole-sign-render.js). A variation logo can be sent "Below Background" to
// sit between the two, showing through any transparency in the image.
export function buildBackgroundSection() {
  const bg = HS.background;
  const color = bg.color || '#FFFFFF';
  const overlayColor = bg.overlayColor || '#000000';
  const overlayOp = bg.overlayOpacity ?? 50;
  const overlayOn = bg.overlayEnabled !== false;
  const imgOp = bg.imageOpacity ?? 100;
  const blendModes = ['normal','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','color','luminosity'];
  const imageControls = bg.imageUrl ? `
      <div class="hs-img-drag-wrap" id="bgImgWrap" style="aspect-ratio:${HS_W}/${HS_H}"
           onpointerdown="bgImgDragStart(event)"
           onwheel="bgImgWheel(event)">
        <div class="hs-img-drag-thumb" id="bgImgThumb"
             style="background-image:url('${bg.imageUrl.replace(/'/g,'%27')}')"></div>
        <div class="hs-img-drag-hint">Drag to reposition · Scroll to scale</div>
      </div>
      <button class="btn sm" style="margin-top:6px" onclick="removeBgImage()">Remove image</button>
      <div class="tl-row">
        <div class="tl-row-label">Opacity</div>
        <div class="tl-size-slider">
          <input type="range" min="0" max="100" value="${imgOp}" oninput="setBgImgOpacity(this.value)">
          <span class="tl-size-value" id="bgImgOpLbl">${imgOp}%</span>
        </div>
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Greyscale</div>
        <label class="tl-switch"><input type="checkbox"${bg.imageGreyscale ? ' checked' : ''} onchange="setBgImgGreyscale(this.checked)"><span class="tl-switch-slider"></span></label>
      </div>
      <div class="tl-row" style="margin-top:10px">
        <div class="tl-row-label" style="font-size:12px;font-weight:600;color:var(--black)">Color overlay</div>
        <label class="tl-switch"><input type="checkbox"${overlayOn ? ' checked' : ''} onchange="setBgOverlayEnabled(this.checked)"><span class="tl-switch-slider"></span></label>
      </div>
      ${overlayOn ? `
      <div class="color-row" style="margin-top:6px">
        <input type="color" class="hs-color-swatch" id="bgOvColorSwatch" value="${overlayColor}" oninput="setBgOverlayColor(this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${overlayColor}" oninput="setBgOverlayColorHex(this.value)" placeholder="#000000">
        ${eyedropperBtn('bgOvColorSwatch')}
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Amount</div>
        <div class="tl-size-slider">
          <input type="range" min="0" max="100" value="${overlayOp}" oninput="setBgOverlayOpacity(this.value)">
          <span class="tl-size-value" id="bgOvOpLbl">${overlayOp}%</span>
        </div>
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Blend</div>
        <select class="hs-editor-select" style="flex:1" onchange="setBgOverlayBlend(this.value)">
          ${blendModes.map(m => `<option value="${m}"${(bg.overlayBlend || 'normal') === m ? ' selected' : ''}>${m.charAt(0).toUpperCase() + m.slice(1).replace(/-/g,' ')}</option>`).join('')}
        </select>
      </div>` : ''}` : `
      <div style="margin-top:4px">
        <button class="btn sm" onclick="document.getElementById('hsBgFile').click()">Upload image</button>
        <input type="file" id="hsBgFile" accept="image/*" style="display:none" onchange="handleBgImageUpload(event)">
      </div>`;
  if (bg.imageUrl) {
    // Deferred so the wrap has been inserted (and laid out via the
    // aspect-ratio above) by the time this reads its actual pixel size.
    // The onNaturalSizeLoaded callback only ever fires for an image saved
    // before natural-size capture existed (see layoutImgDragThumb) —
    // redraw once it backfills so the canvas picks up the image's real
    // pan range too, not just this thumb.
    requestAnimationFrame(() => layoutImgDragThumb(document.getElementById('bgImgWrap'), document.getElementById('bgImgThumb'), bg, HS_W, HS_H, updateStep1Preview));
  }
  return `
    <div class="hs-section">
      <div class="hs-section-title">Background</div>
      <div class="tl-row-label" style="font-size:12px;font-weight:600;color:var(--black)">Color</div>
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="hsBgSwatch" value="${color}"
          oninput="setBgColor(this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${color}"
          oninput="setBgColorHex(this.value)" placeholder="#000000">
        ${eyedropperBtn('hsBgSwatch')}
      </div>
      <div class="tl-row-label" style="font-size:12px;font-weight:600;color:var(--black);margin-top:14px">Image</div>
      ${imageControls}
    </div>`;
}

// Layouts (HS_TEMPLATES, structural) and default designs (HS_DEFAULT_TEMPLATES,
// styled starting points shipped with the app) live in one combined grid —
// they're both just "pick a starting template" cards to the user. "My
// templates" (localStorage, per-browser) stays its own section below since
// it's independently save/deletable.
export function buildTemplateSection() {
  return `
    <div class="hs-section">
      <div class="hs-section-title">Template</div>
      <div class="hs-template-grid">
        ${HS_TEMPLATES.map(t => {
          const active = HS.templateStyle === t.id;
          const showBadge = active && hasBuiltInTemplateChanges();
          return `
          <div class="hs-template-card${active ? ' active' : ''}" onclick="setHsTemplate('${t.id}')">
            <div class="hs-template-thumb" id="hs-tmpl-${t.id}"></div>
            <div class="hs-template-name">${t.name}</div>
            ${showBadge ? '<span class="hs-tmpl-badge">Changes made</span>' : ''}
          </div>`;
        }).join('')}
        ${HS_DEFAULT_TEMPLATES.map(t => `
          <div class="hs-template-card" onclick="applyDefaultTemplate('${t.id}')">
            <div class="hs-template-thumb" id="hs-dtmpl-${t.id}"></div>
          </div>`).join('')}
      </div>
    </div>
    ${buildMyTemplatesSection()}`;
}

export function buildMyTemplatesSection() {
  const customs = loadCustomTemplates();
  return `
    <div class="hs-section">
      <div class="hs-section-title">My templates</div>
      ${customs.length ? `
        <div class="hs-template-grid" style="margin-bottom:8px">
          ${customs.map(t => `
            <div class="hs-template-card" onclick="applyCustomTemplate('${t.id}')">
              <div class="hs-template-thumb" id="hs-ctmpl-${t.id}"></div>
              <div class="hs-template-name">${escXml(t.name)}</div>
              <button class="hs-tmpl-del" onclick="event.stopPropagation();deleteCustomTemplate('${t.id}')"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
            </div>`).join('')}
        </div>` : `<div style="font-size:12px;color:var(--gray-400);margin-bottom:8px">No saved templates yet.</div>`}
      <button class="btn sm" style="width:100%;justify-content:center" onclick="showSaveTmplForm()">+ Save current as template</button>
      <div id="hsSaveTmplForm" class="hs-save-tmpl-form" style="display:none">
        <input class="hexin" id="hsTmplNameInput" placeholder="Template name…" style="width:100%"
          onkeydown="if(event.key==='Enter')confirmSaveTemplate()">
        <div style="display:flex;gap:6px">
          <button class="btn sm primary" onclick="confirmSaveTemplate()">Save</button>
          <button class="btn sm" onclick="hideSaveTmplForm()">Cancel</button>
        </div>
      </div>
    </div>`;
}

// One row in an options list. `hint` may contain HTML (e.g. a swatch).
// `handler` is the global fn invoked with the section key on click. `icon` is
// an optional fa-solid class (or space-separated classes) shown before the label.
export function menuRow(key, label, hint, handler = 'openHsMenu', icon = '') {
  const iconHtml = icon ? `<i class="fa-solid ${icon} hs-menu-row-icon" aria-hidden="true"></i>` : '';
  return `
    <button class="hs-menu-row" onclick="${handler}('${key}')">
      ${iconHtml}<span class="hs-menu-row-label">${label}</span>
      <span class="hs-menu-row-hint">${hint}</span>
      <span class="hs-menu-row-chev"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span>
    </button>`;
}

// An "add new" row — unlike menuRow() (which drills into a submenu), this
// performs the add immediately (enable a banner, add a text/image layer),
// so it has no hint/chevron, just a label. `icon` is an optional fa-solid
// class (or space-separated classes) shown before the label.
export function addRow(label, onclick, icon = '') {
  const iconHtml = icon ? `<i class="fa-solid ${icon} hs-menu-row-icon" aria-hidden="true"></i>` : '';
  return `
    <button class="hs-menu-row hs-menu-row-add" onclick="${onclick}">
      ${iconHtml}<span class="hs-menu-row-label">${label}</span>
    </button>`;
}

export function renderDesignMenuList(activeTmpl) {
  const rows = [];
  rows.push(menuRow('template', 'Template', escXml(activeTmpl.name)));
  const bg = HS.background;
  const bgHint = `<span class="hs-menu-swatch" style="background:${escXml(bg.color || '#FFFFFF')}"></span>${bg.imageUrl ? ' + Image' : ''}`;
  rows.push(menuRow('background', 'Background', bgHint));

  // A banner already on shows as a normal drill-in row (hint "On") so it can
  // be switched back off from inside that same section's toggle — matches
  // the per-variation editor's equivalent rows (var-editor.js).
  rows.push(HS.bannerTop?.enabled
    ? menuRow('bannerTop', 'Top banner', 'On', 'openHsMenu', 'fa-window-maximize')
    : addRow('Top banner', "quickAdd('banner','top')", 'fa-window-maximize'));
  rows.push(HS.bannerBottom?.enabled
    ? menuRow('bannerBottom', 'Bottom banner', 'On', 'openHsMenu', 'fa-window-maximize hs-icon-flip')
    : addRow('Bottom banner', "quickAdd('banner','bottom')", 'fa-window-maximize hs-icon-flip'));
  rows.push(addRow('Text', 'addTextLayer()', 'fa-font'));
  rows.push(addRow('Images', 'addTplImage()', 'fa-image'));
  return `<div class="hs-menu-list">${rows.join('')}</div>`;
}

const HS_MENU_TITLES = {
  template: 'Template', background: 'Background',
  bannerTop: 'Top banner', bannerBottom: 'Bottom banner',
  logos: 'Template logos', tplSlot: 'Logo options',
};

export function renderDesignSection(key) {
  let body = '';
  if (key === 'template')         body = buildTemplateSection();
  else if (key === 'background')  body = buildBackgroundSection();
  else if (key === 'bannerTop')    body = renderBannerSection('top');
  else if (key === 'bannerBottom') body = renderBannerSection('bottom');
  else if (key === 'logos')       body = renderTemplateLogoControls();
  else if (key === 'tplSlot')     body = `<div class="hs-section">${renderTplSlotBody(UI.hsMenuSlotIdx ?? 0)}</div>`;
  const backFn = key === 'tplSlot' ? "openHsMenu('logos')" : 'closeHsMenu(true)';
  return `
    <div class="hs-menu-section-header">
      <button class="hs-menu-back" onclick="${backFn}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back</button>
      <span class="hs-menu-section-title">${HS_MENU_TITLES[key] || ''}</span>
    </div>
    ${body}`;
}

// Bridge for template-logos.js to refresh the tplSlot section without a circular import.
window._refreshDesignTplSlot = function () {
  const controls = document.getElementById('hsDesignControlsBody');
  if (controls && UI.hsMenu === 'tplSlot') controls.innerHTML = renderDesignSection('tplSlot');
};

// Bridge for template-logos.js to refresh the sidebar's Template logos tile
// after a slot's thumbnail changes (Replace, background removal) without a
// full renderStep1() — mirrors _refreshDesignTplSlot above. Not relevant
// while editing a variation's own template logos (that surface has no
// sidebar logos tile of its own) or before a template is chosen.
window._refreshDesignLogosTile = function () {
  if (UI.hsOnboarding || HS.editingVarId) return;
  const items = document.getElementById('sidebarLogosTile')?.querySelector('.hslt-items');
  if (items) items.innerHTML = renderTemplateLogoTileItems();
};

window.openHsMenu = function (key) { UI.hsMenu = key; UI.hsMenuAnimate = true; renderStep1(); };

// Update only the right controls panel without touching the canvas — used when
// the user clicks a canvas element so the relevant section auto-opens in place.
window.openHsMenuSection = function (key) {
  if (HS.editingVarId) return;
  const controls = document.getElementById('hsDesignControlsBody');
  if (!controls || UI.hsMenu === key) return;
  UI.hsMenu = key;
  controls.innerHTML = renderDesignSection(key);
  controls.classList.remove('hs-controls-enter');
  void controls.offsetWidth;
  controls.classList.add('hs-controls-enter');
};

// Counterpart to openHsMenuSection above, for the opposite direction: drop
// back to the main menu list without touching the canvas. Text elements
// (free text layers, docked banner captions, the top/bottom text bands)
// always edit via their own on-canvas floating toolbar/inline editor, never a
// right-sidebar section — so clicking one should drop whatever section was
// open (banner, template logos, etc.) back to the list. Their own click
// handlers stopPropagation() (so they never reach the background-click
// closeHsMenu() below) and some of them synchronously create a live
// contenteditable in the canvas right after — a full closeHsMenu()/
// renderStep1() there would destroy that DOM mid-click and cancel the edit
// before it starts, so this only ever touches #hsDesignControlsBody.
window.closeHsMenuSection = function (save) {
  if (HS.editingVarId || UI.hsMenu === null) return;
  UI.hsMenu = null;
  const controls = document.getElementById('hsDesignControlsBody');
  if (controls) {
    const activeTmpl = HS_TEMPLATES.find(t => t.id === HS.templateStyle) || HS_TEMPLATES[0];
    controls.innerHTML = renderDesignMenuList(activeTmpl);
    controls.classList.remove('hs-controls-enter');
    void controls.offsetWidth;
    controls.classList.add('hs-controls-enter');
  }
  if (save) {
    saveDraftInternal().then(() => {
      const el = document.getElementById('saveStatus');
      if (el) { el.textContent = 'Saved'; setTimeout(() => { el.textContent = ''; }, 1500); }
    }).catch(() => {});
  }
};
window.closeHsMenu = function (save) {
  UI.hsMenu = null;
  UI.hsMenuAnimate = true;
  renderStep1();
  if (save) {
    saveDraftInternal().then(() => {
      const el = document.getElementById('saveStatus');
      if (el) { el.textContent = 'Saved'; setTimeout(() => { el.textContent = ''; }, 1500); }
    }).catch(() => {});
  }
};

export function renderStep1() {
  const panel = document.getElementById('panel-1');

  // ── Onboarding: full-panel template picker for brand-new projects ──────────
  // Shows every starting point available in the in-project "Template" menu
  // (buildTemplateSection/buildMyTemplatesSection below): structural layouts
  // (HS_TEMPLATES), styled starter designs (HS_DEFAULT_TEMPLATES), and this
  // browser's saved "My templates" (localStorage) — so nothing added to any
  // of those three sources needs a matching update here.
  if (UI.hsOnboarding) {
    const customs = loadCustomTemplates();
    // One flat grid across all three sources (structural layouts, styled
    // starters, and this browser's saved customs) instead of a separate
    // "My templates" section below — a custom entry is distinguished by its
    // corner badge rather than by which section it sits in, so the grid
    // stays a single scan instead of two. Reuses the same
    // canvas-column + 280px-header-column shell every other step uses
    // (hs-design-layout — see renderStep1's main branch below) instead of a
    // bespoke wrapper, so the header sits in the same place and the grid
    // gets the same full-bleed width.
    panel.innerHTML = `
      <div class="hs-design-layout">
        <div class="hs-design-preview-col">
          <div class="hs-ob-grid">
            ${HS_TEMPLATES.map(t => `
              <div class="hs-ob-card" onclick="pickOnboardingTemplate('${t.id}')" title="${escXml(t.name)}">
                <div class="hs-ob-thumb" id="hs-ob-${t.id}"></div>
              </div>`).join('')}
            ${HS_DEFAULT_TEMPLATES.map(t => `
              <div class="hs-ob-card" onclick="pickOnboardingDefaultTemplate('${t.id}')" title="${escXml(t.name)}">
                <div class="hs-ob-thumb" id="hs-ob-dtmpl-${t.id}"></div>
              </div>`).join('')}
            ${customs.map(t => `
              <div class="hs-ob-card" onclick="pickOnboardingCustomTemplate('${t.id}')" title="${escXml(t.name)}">
                <div class="hs-ob-thumb" id="hs-ob-ctmpl-${t.id}"></div>
                <span class="hs-ob-badge" onclick="event.stopPropagation();editCustomTemplate('${t.id}')">
                  <span class="hs-ob-badge-default">Custom</span><span class="hs-ob-badge-edit">Edit template</span>
                </span>
              </div>`).join('')}
          </div>
        </div>
        <div class="hs-design-controls">
          <div class="panel-project-id" style="text-align:right;padding-bottom:.75rem">
            <div style="font-size:15px;font-weight:500;color:var(--black);line-height:1.3">${escXml(HS.projectName || '—')}</div>
            <div style="font-size:11px;color:var(--gray-400);margin-top:3px">Hole Signs</div>
          </div>
        </div>
      </div>`;
    document.getElementById('sidebarPanelHeader').innerHTML = `
      <div class="p1-header hs-panel-header">
        <div>
          <div class="ptitle">Choose a template</div>
          <div class="psub">Pick a starting point — you can customise everything on the next screen.</div>
        </div>
        <div class="p1-header-actions">
          <button class="btn primary" onclick="pickOnboardingBlankTemplate()">+ Create new template</button>
        </div>
      </div>`;
    const obLogosTile = document.getElementById('sidebarLogosTile');
    if (obLogosTile) obLogosTile.innerHTML = '';
    HS_TEMPLATES.forEach(t => {
      const el = document.getElementById('hs-ob-' + t.id);
      if (el) renderHoleSignInto(el, layoutPreviewState(t.id));
    });
    HS_DEFAULT_TEMPLATES.forEach(t => {
      const el = document.getElementById('hs-ob-dtmpl-' + t.id);
      if (el) renderHoleSignInto(el, templatePreviewState(t));
    });
    customs.forEach(t => {
      const el = document.getElementById('hs-ob-ctmpl-' + t.id);
      if (el) renderHoleSignInto(el, templatePreviewState(t));
    });
    return;
  }

  const activeTmpl = HS_TEMPLATES.find(t => t.id === HS.templateStyle) || HS_TEMPLATES[0];
  // A section may have become unavailable (e.g. a template with no fixed
  // top/bottom caption text).
  if ((UI.hsMenu === 'top' || UI.hsMenu === 'bottom') && !activeTmpl.supportsText) UI.hsMenu = null;
  if (UI.hsMenu === 'banner') UI.hsMenu = 'bannerTop'; // migrate stale key

  const controlsInner = UI.hsMenu === null ? renderDesignMenuList(activeTmpl) : renderDesignSection(UI.hsMenu);
  const animClass = UI.hsMenuAnimate ? ' hs-controls-enter' : '';
  UI.hsMenuAnimate = false;

  const editingTmpl = UI.hsEditingCustomTemplateId ? loadCustomTemplates().find(t => t.id === UI.hsEditingCustomTemplateId) : null;

  panel.innerHTML = `
    <div class="hs-design-layout">
      <div class="hs-design-preview-col">
        <div class="var-canvas-panel hs-canvas-bare" id="hsStep1CanvasPanel"></div>
      </div>
      <div class="hs-design-controls">
        <div class="panel-project-id" style="text-align:right;padding-bottom:.75rem">
          <div style="font-size:15px;font-weight:500;color:var(--black);line-height:1.3">${escXml(HS.projectName || '—')}</div>
          <div style="font-size:11px;color:var(--gray-400);margin-top:3px">Hole Signs</div>
        </div>
        <div class="hs-design-controls-body${animClass}" id="hsDesignControlsBody">${controlsInner}</div>
      </div>
    </div>`;
  document.getElementById('sidebarPanelHeader').innerHTML = `
    <div class="p1-header hs-panel-header">
      <div>
        <div class="ptitle">Templates</div>
        <div class="psub">${editingTmpl
          ? `Editing “${escXml(editingTmpl.name)}” — changes save automatically as a new template.`
          : 'Choose a template, set the background, and configure text.'}</div>
      </div>
      <div class="p1-header-actions">
        <button class="btn primary" onclick="goStep(2)">Save &amp; Continue <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        <button class="btn sm save-draft-btn" id="saveDraftBtn" onclick="saveDraft()" style="display:none">Save draft</button>
      </div>
    </div>`;
  const logosItems = renderLogosTileShell('Logos');
  if (logosItems) logosItems.innerHTML = renderTemplateLogoTileItems();

  window.goStep = goStep;

  initHsStep1Canvas(document.getElementById('hsStep1CanvasPanel'));
  applyHsStep1Zoom(UI.hsStep1Zoom);
  updateStep1Preview();
  // Built-in template thumbnails always show the pristine default state, so
  // the user sees exactly what they'll get when clicking the card (which
  // resets to defaults).
  HS_TEMPLATES.forEach(t => {
    const el = document.getElementById('hs-tmpl-' + t.id);
    if (el) renderHoleSignInto(el, layoutPreviewState(t.id));
  });
  loadCustomTemplates().forEach(t => {
    const el = document.getElementById('hs-ctmpl-' + t.id);
    if (el) renderHoleSignInto(el, templatePreviewState(t));
  });
  HS_DEFAULT_TEMPLATES.forEach(t => {
    const el = document.getElementById('hs-dtmpl-' + t.id);
    if (el) renderHoleSignInto(el, templatePreviewState(t));
  });

  scheduleCustomTemplateForkSave();
}

window.setBgColor = function (val) {
  HS.background.color = val;
  // Sync hex input
  const hexInputs = document.querySelectorAll('#panel-1 .hs-section input[type=text].hexin');
  hexInputs.forEach(inp => {
    if (inp.placeholder === '#000000' || inp.value.startsWith('#')) {
      inp.value = val;
    }
  });
  updateStep1Preview();
};

window.setBgColorHex = function (val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
    HS.background.color = c;
    const swatch = document.querySelector('#panel-1 .hs-section input[type=color]');
    if (swatch) swatch.value = c;
    updateStep1Preview();
  }
};

window.handleBgImageUpload = async function (e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !HS.projectId) return;
  try {
    const logo = await uploadLogo(HS.projectId, file);
    HS.background.imageUrl = logo.src;
    HS.background.storagePath = logo.storagePath;
    // Captured once here (rather than derived on the fly) so the renderer
    // (hole-sign-render.js) and this drag control can both do a real
    // "cover" fit — knowing which axis actually has slack to pan through —
    // without either of them needing to load the image themselves.
    HS.background.imageNaturalW = null;
    HS.background.imageNaturalH = null;
    // The canvas render this triggers below runs before this resolves, so it
    // falls back to the old (locked-until-zoomed) box model — redraw once
    // natural size actually lands so the real pan range appears on its own,
    // without needing the user to nudge the image first to "unstick" it.
    loadNaturalImgSize(logo.src, (w, h) => {
      HS.background.imageNaturalW = w;
      HS.background.imageNaturalH = h;
      updateStep1Preview();
    });
    renderStep1();
  } catch (err) {
    console.error('Background image upload failed', err);
  }
};

window.removeBgImage = function () {
  HS.background.imageUrl = null;
  HS.background.storagePath = null;
  renderStep1();
};

window.setBgImgOpacity = function (val) {
  HS.background.imageOpacity = parseInt(val, 10);
  const lbl = document.getElementById('bgImgOpLbl');
  if (lbl) lbl.textContent = val + '%';
  updateStep1Preview();
};
// Mirrors bannerImgDragStart/bannerImgWheel (hs/banner.js) for the main sign
// background image — see layoutImgDragThumb (image-box.js) for why the
// preview has to be computed from the image's natural size instead of a
// plain CSS background-position/-size percentage.
window.bgImgDragStart = function (e) {
  e.preventDefault();
  const wrap  = document.getElementById('bgImgWrap');
  const thumb = document.getElementById('bgImgThumb');
  if (!wrap || !thumb) return;
  const bg = HS.background;
  const x0 = e.clientX, y0 = e.clientY;
  const ix0 = bg.imageX ?? 50, iy0 = bg.imageY ?? 50;
  wrap.setPointerCapture(e.pointerId);
  function onMove(ev) {
    const dx = (ev.clientX - x0) / wrap.offsetWidth  * 100;
    const dy = (ev.clientY - y0) / wrap.offsetHeight * 100;
    const p = clampPanToBg(HS_W, HS_H, bg, ix0 - dx, iy0 - dy);
    bg.imageX = p.x;
    bg.imageY = p.y;
    layoutImgDragThumb(wrap, thumb, bg, HS_W, HS_H, updateStep1Preview);
    updateStep1Preview();
  }
  function onUp() {
    wrap.removeEventListener('pointermove', onMove);
    wrap.removeEventListener('pointerup', onUp);
    updateStep1Preview();
  }
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
};
window.bgImgWheel = function (e) {
  e.preventDefault();
  const wrap  = document.getElementById('bgImgWrap');
  const thumb = document.getElementById('bgImgThumb');
  const bg = HS.background;
  const delta = e.deltaY > 0 ? -5 : 5;
  bg.imageScale = Math.max(100, Math.min(300, (bg.imageScale ?? 100) + delta));
  // Zooming out can shrink the valid pan range below the current position —
  // re-clamp now rather than leaving a gap until the next drag touches it.
  const p = clampPanToBg(HS_W, HS_H, bg, bg.imageX, bg.imageY);
  bg.imageX = p.x;
  bg.imageY = p.y;
  layoutImgDragThumb(wrap, thumb, bg, HS_W, HS_H, updateStep1Preview);
  clearTimeout(window._bgWheelT);
  window._bgWheelT = setTimeout(updateStep1Preview, 80);
};
window.setBgImgGreyscale = function (on) {
  HS.background.imageGreyscale = !!on;
  updateStep1Preview();
};
window.setBgOverlayColor = function (val) {
  HS.background.overlayColor = val;
  const hex = document.getElementById('bgOvColorSwatch');
  if (hex) hex.nextElementSibling.value = val;
  updateStep1Preview();
};
window.setBgOverlayColorHex = function (val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  HS.background.overlayColor = c;
  const swatch = document.getElementById('bgOvColorSwatch');
  if (swatch) swatch.value = c;
  updateStep1Preview();
};
window.setBgOverlayOpacity = function (val) {
  HS.background.overlayOpacity = parseInt(val, 10);
  const lbl = document.getElementById('bgOvOpLbl');
  if (lbl) lbl.textContent = val + '%';
  updateStep1Preview();
};
window.setBgOverlayBlend = function (val) {
  HS.background.overlayBlend = val;
  updateStep1Preview();
};
window.setBgOverlayEnabled = function (on) {
  HS.background.overlayEnabled = !!on;
  // Default the amount to 50% when first enabling so it's immediately visible.
  if (on && !(HS.background.overlayOpacity > 0)) HS.background.overlayOpacity = 50;
  renderStep1();
};

// Clean state a built-in template starts from. Clicking a built-in card resets
// the canvas to these values; any subsequent edits surface as "Changes made"
// on that card so the user knows the built-in default has been customized.
export const HS_BUILTIN_DEFAULTS = {
  background: { type: 'color', color: '#FFFFFF', imageUrl: null, storagePath: null },
  topText:    { text: 'Sponsored By', font: 'dm-serif', size: 300, color: '#111110' },
  bottomText: { text: '', font: 'dm-serif', size: 300, color: '#111110' },
};

// Preview-only state for a bare layout (HS_TEMPLATES entry — no bundled
// style of its own): the same pristine defaults a built-in card resets the
// canvas to. Used by every "pick a layout" thumbnail (onboarding grid, the
// Template section below, and the Variations-page per-variation picker in
// variations.js) so a thumbnail always shows exactly what clicking it applies.
export function layoutPreviewState(templateStyle) {
  return {
    templateStyle,
    background:    { ...HS_BUILTIN_DEFAULTS.background },
    topText:       { ...HS_BUILTIN_DEFAULTS.topText },
    bottomText:    { ...HS_BUILTIN_DEFAULTS.bottomText },
    bannerTop:     emptyBanner(),
    bannerBottom:  emptyBanner(),
    templateLogos: emptyTemplateLogos(),
    textLayers:    [],
  };
}

// Preview-only state for a starter/custom template (HS_DEFAULT_TEMPLATES or
// "My templates" entry). A stored template keeps its banner captions as
// `bannerTopTextLayers`/`bannerBottomTextLayers` spec arrays (see
// bannerDockSpecsFor), not a ready `textLayers` list — passing the raw
// template object straight to renderHoleSignInto (as every thumbnail here
// used to) silently drops any caption docked to a banner, since
// dockedLayers() only ever reads state.textLayers. Used by every "pick a
// template" thumbnail for the same reason as layoutPreviewState above.
export function templatePreviewState(tmpl) {
  return {
    templateStyle: tmpl.templateStyle,
    background:    { ...tmpl.background },
    topText:       { ...tmpl.topText },
    bottomText:    { ...tmpl.bottomText },
    bannerTop:     mergeBanner(tmpl.bannerTop    || (tmpl.banner?.position !== 'bottom' ? tmpl.banner : null)),
    bannerBottom:  mergeBanner(tmpl.bannerBottom || (tmpl.banner?.position === 'bottom' ? tmpl.banner : null)),
    templateLogos: cloneTemplateLogos(tmpl.templateLogos),
    textLayers:    bannerDockSpecsFor(tmpl).map(spec => ({ ...spec, id: 'tlprev-' + Math.random().toString(36).slice(2, 9) })),
  };
}

export function applyBuiltInDefaults() {
  HS.background = { ...HS_BUILTIN_DEFAULTS.background };
  HS.topText    = { ...HS_BUILTIN_DEFAULTS.topText };
  HS.bottomText = { ...HS_BUILTIN_DEFAULTS.bottomText };
  HS.bannerTop    = emptyBanner();
  HS.bannerBottom = emptyBanner();
  // Built-in templates carry no banner captions of their own — drop any
  // docked layers left over from whatever template was active before (their
  // text, if user-edited, is carried forward by captureUserCaptions/
  // restoreUserCaptions in setHsTemplate, into HS.topText/HS.bottomText).
  HS.textLayers = (HS.textLayers || []).filter(l => !l.dock);
  HS.templateLogos = emptyTemplateLogos();
  HS.captionsEdited = defaultCaptionsEdited();
}

export function hasBuiltInTemplateChanges() {
  return JSON.stringify(HS.background) !== JSON.stringify(HS_BUILTIN_DEFAULTS.background)
      || JSON.stringify(HS.topText)    !== JSON.stringify(HS_BUILTIN_DEFAULTS.topText)
      || JSON.stringify(HS.bottomText) !== JSON.stringify(HS_BUILTIN_DEFAULTS.bottomText)
      || !!HS.bannerTop?.enabled
      || !!HS.bannerBottom?.enabled
      || (HS.templateLogos?.count ?? 0) !== 0;
}

// Writes text into the Nth docked layer of a banner zone (dockedLayers, in
// dockOrder — see hole-sign-render.js), creating one (with sensible default
// styling) if it doesn't exist yet. Docked layers replaced the old fixed
// bannerTop/bannerBottom.topText/subText slots, so a banner's "primary"/"sub"
// caption is now just the 1st/2nd docked free text layer in that zone.
function setDockedCaption(which, index, text) {
  const layers = dockedLayers(HS, which);
  if (layers[index]) { layers[index].text = text; return; }
  if (!Array.isArray(HS.textLayers)) HS.textLayers = [];
  HS.textLayers.push({
    id: 'tl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    text, font: index === 0 ? 'dm-serif' : 'dm-sans', size: index === 0 ? 260 : 140,
    color: '#111110', align: 'center', dock: which, dockOrder: index, aboveFrame: true,
  });
}

// Swapping templates changes *structure* (background, banners, logo layout)
// — the user's own caption text shouldn't have to be retyped just because
// the surrounding template changed. Capture it beforehand (falling back to
// whichever slot — plain text band vs. banner dock — currently holds it,
// since different templates put the same caption in different places). Only
// a slot the user has actually typed into (HS.captionsEdited) is captured —
// a template's own placeholder/default text (e.g. "Sponsored By") is never
// treated as user text, so it doesn't leak into the next template.
function captureUserCaptions() {
  const e = HS.captionsEdited || {};
  return {
    primary:      e.primary      ? (HS.topText?.text?.trim()    || dockedLayers(HS, 'top')[0]?.text?.trim()    || '') : '',
    primarySub:   e.primarySub   ? (dockedLayers(HS, 'top')[1]?.text?.trim()    || '') : '',
    secondary:    e.secondary    ? (HS.bottomText?.text?.trim() || dockedLayers(HS, 'bottom')[0]?.text?.trim() || '') : '',
    secondarySub: e.secondarySub ? (dockedLayers(HS, 'bottom')[1]?.text?.trim() || '') : '',
  };
}

// ...then re-apply it into whichever slot the *new* template structure
// actually uses. Only overwrites when the user had actually typed something
// — an untouched template's own placeholder/blank text is left alone, so a
// pristine template swap still looks like that template, not a mash-up.
// Re-marks the restored slot as edited so it keeps carrying forward through
// further template switches.
function restoreUserCaptions(prev) {
  if (prev.primary) {
    if (HS.bannerTop?.enabled) setDockedCaption('top', 0, prev.primary);
    else HS.topText.text = prev.primary;
    HS.captionsEdited.primary = true;
  }
  if (prev.primarySub && HS.bannerTop?.enabled) {
    setDockedCaption('top', 1, prev.primarySub);
    HS.captionsEdited.primarySub = true;
  }
  if (prev.secondary) {
    if (HS.bannerBottom?.enabled) setDockedCaption('bottom', 0, prev.secondary);
    else HS.bottomText.text = prev.secondary;
    HS.captionsEdited.secondary = true;
  }
  if (prev.secondarySub && HS.bannerBottom?.enabled) {
    setDockedCaption('bottom', 1, prev.secondarySub);
    HS.captionsEdited.secondarySub = true;
  }
}

window.pickOnboardingTemplate = function (templateId) {
  UI.hsOnboarding = false;
  UI.hsEditingCustomTemplateId = null;
  UI.hsCustomTemplateForkId = null;
  HS.templateStyle = templateId;
  applyBuiltInDefaults();
  renderStep1();
};

// "+ Create new template" — unlike clicking a layout card (which seeds the
// built-in "Sponsored By" placeholder caption), this starts completely
// blank so nothing has to be deleted before the user's own design begins.
window.pickOnboardingBlankTemplate = function () {
  UI.hsOnboarding = false;
  UI.hsEditingCustomTemplateId = null;
  UI.hsCustomTemplateForkId = null;
  HS.templateStyle = HS_TEMPLATES[0].id;
  applyBuiltInDefaults();
  HS.topText.text = '';
  HS.captionsEdited = defaultCaptionsEdited();
  renderStep1();
};

window.pickOnboardingDefaultTemplate = function (id) {
  UI.hsOnboarding = false;
  UI.hsEditingCustomTemplateId = null;
  UI.hsCustomTemplateForkId = null;
  window.applyDefaultTemplate(id);
};

window.pickOnboardingCustomTemplate = function (id) {
  UI.hsOnboarding = false;
  UI.hsEditingCustomTemplateId = null;
  UI.hsCustomTemplateForkId = null;
  window.applyCustomTemplate(id);
};

// Entered via a "My templates" card's corner badge (onboarding grid — see
// renderStep1 above) instead of clicking the card itself: applies the
// template exactly like pickOnboardingCustomTemplate, but also marks it as
// the one being edited, so every further change auto-saves as a new
// template (see scheduleCustomTemplateForkSave) instead of just customizing
// this one project's design.
window.editCustomTemplate = function (id) {
  UI.hsOnboarding = false;
  window.applyCustomTemplate(id);
  UI.hsEditingCustomTemplateId = id;
  UI.hsCustomTemplateForkId = null;
};

window.setHsTemplate = function (templateId) {
  const prev = captureUserCaptions();
  HS.templateStyle = templateId;
  applyBuiltInDefaults();
  restoreUserCaptions(prev);
  if (UI.hsMenu === 'template') window.closeHsMenu(true);
  else renderStep1();
};

// ── Custom templates (localStorage) ───────────────────────
// Latest-edited-first — every consumer (onboarding grid, the in-editor "My
// templates" section, the Variations-page template picker) lists them this
// way for free, so a template being actively iterated on (see
// scheduleCustomTemplateForkSave below) always surfaces at the top.
export function loadCustomTemplates() {
  let list;
  try { list = JSON.parse(localStorage.getItem('hs_custom_templates') || '[]'); }
  catch { list = []; }
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function saveCustomTemplates(list) {
  localStorage.setItem('hs_custom_templates', JSON.stringify(list));
}

window.showSaveTmplForm = function () {
  const form = document.getElementById('hsSaveTmplForm');
  if (!form) return;
  form.style.display = 'flex';
  document.getElementById('hsTmplNameInput')?.focus();
};

window.hideSaveTmplForm = function () {
  const form = document.getElementById('hsSaveTmplForm');
  if (form) form.style.display = 'none';
};

// Snapshot of a banner zone's docked layers, in the same partial-spec shape
// migrateBannerCaptions() produces (no `id` — a fresh one is assigned when
// the template is later applied).
function snapshotDockedLayerSpecs(which) {
  return dockedLayers(HS, which).map(l => ({
    text: l.text, font: l.font, size: l.size, color: l.color, align: l.align, w: l.w,
    dock: which, dockOrder: l.dockOrder ?? 0, aboveFrame: l.aboveFrame ?? true,
  }));
}

// Full snapshot of the live design, in the shape stored in "My templates".
// Shared by the explicit "Save current as template" form below and by the
// auto-fork-on-edit path (scheduleCustomTemplateForkSave).
function buildTemplateSnapshot(name) {
  return {
    id: crypto.randomUUID(),
    name,
    templateStyle: HS.templateStyle,
    background:    { ...HS.background },
    topText:       { ...HS.topText },
    bottomText:    { ...HS.bottomText },
    bannerTop:     mergeBanner(HS.bannerTop),
    bannerBottom:  mergeBanner(HS.bannerBottom),
    bannerTopTextLayers:    snapshotDockedLayerSpecs('top'),
    bannerBottomTextLayers: snapshotDockedLayerSpecs('bottom'),
    templateLogos: cloneTemplateLogos(HS.templateLogos),
    updatedAt: Date.now(),
  };
}

window.confirmSaveTemplate = function () {
  const name = document.getElementById('hsTmplNameInput')?.value.trim();
  if (!name) return;
  const list = loadCustomTemplates();
  list.push(buildTemplateSnapshot(name));
  saveCustomTemplates(list);
  renderStep1();
};

window.deleteCustomTemplate = function (id) {
  saveCustomTemplates(loadCustomTemplates().filter(t => t.id !== id));
  if (UI.hsEditingCustomTemplateId === id) UI.hsEditingCustomTemplateId = null;
  if (UI.hsCustomTemplateForkId === id) UI.hsCustomTemplateForkId = null;
  renderStep1();
};

// Debounced auto-save while UI.hsEditingCustomTemplateId is set (entered via
// a "My templates" card's "Edit template" corner badge — see
// editCustomTemplate below). The first design change after entering forks a
// brand-new "My templates" entry — the original the user clicked "Edit" on
// is never mutated — and every change after that updates that same fork in
// place. Called from the tail of renderStep1() below, which already runs
// after every design mutation, so no individual setter needs to know about
// this; flushCustomTemplateForkSave lets goStep() (app.js) force a pending
// save through immediately when the user navigates away mid-debounce.
let templateForkTimer = null;
function runCustomTemplateForkSave() {
  clearTimeout(templateForkTimer);
  templateForkTimer = null;
  if (!UI.hsEditingCustomTemplateId) return;
  const list = loadCustomTemplates();
  if (UI.hsCustomTemplateForkId) {
    const idx = list.findIndex(t => t.id === UI.hsCustomTemplateForkId);
    if (idx >= 0) {
      list[idx] = { ...buildTemplateSnapshot(list[idx].name), id: UI.hsCustomTemplateForkId };
      saveCustomTemplates(list);
      return;
    }
  }
  const source = list.find(t => t.id === UI.hsEditingCustomTemplateId);
  const entry = buildTemplateSnapshot(source ? source.name : 'Untitled template');
  UI.hsCustomTemplateForkId = entry.id;
  list.push(entry);
  saveCustomTemplates(list);
}

function scheduleCustomTemplateForkSave() {
  if (!UI.hsEditingCustomTemplateId) return;
  clearTimeout(templateForkTimer);
  templateForkTimer = setTimeout(runCustomTemplateForkSave, 800);
}

export function flushCustomTemplateForkSave() {
  if (templateForkTimer) runCustomTemplateForkSave();
}

// Template banners no longer carry caption text of their own (see emptyBanner
// in hole-sign-data.js) — a template's banner captions are docked free text
// layers instead, seeded from `bannerTopTextLayers`/`bannerBottomTextLayers`
// (new-shape templates) or migrated from a legacy `bannerTop.topText`/
// `subText` pair (older "My templates" entries saved before this change).
// Existing docked layers belong to the *previous* template and are dropped
// first — captureUserCaptions/restoreUserCaptions (called by the two
// `apply*Template` functions below) is what carries real user text forward.
function replaceBannerDockSeeds(tmpl) {
  HS.textLayers = (HS.textLayers || []).filter(l => !l.dock);
  bannerDockSpecsFor(tmpl).forEach(spec => {
    HS.textLayers.push({ ...spec, id: 'tl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) });
  });
}

window.applyCustomTemplate = function (id) {
  const tmpl = loadCustomTemplates().find(t => t.id === id);
  if (!tmpl) return;
  const prev = captureUserCaptions();
  HS.templateStyle = tmpl.templateStyle;
  HS.background    = { ...tmpl.background };
  HS.topText       = { ...tmpl.topText };
  HS.bottomText    = { ...tmpl.bottomText };
  HS.bannerTop    = mergeBanner(tmpl.bannerTop    || (tmpl.banner?.position !== 'bottom' ? tmpl.banner : null));
  HS.bannerBottom = mergeBanner(tmpl.bannerBottom || (tmpl.banner?.position === 'bottom' ? tmpl.banner : null));
  replaceBannerDockSeeds(tmpl);
  HS.templateLogos = cloneTemplateLogos(tmpl.templateLogos);
  HS.captionsEdited = defaultCaptionsEdited();
  restoreUserCaptions(prev);
  HS.templateLogos.slots.forEach(s => {
    if (s.logoSrc && s.logoArtworkBounds) {
      cropSvgToArtwork(s.logoSrc, s.logoArtworkBounds).then(t => {
        if (t) { s.logoSrcTight = t.url; s.logoAspect = t.aspect; updateStep1Preview(); }
      }).catch(() => {});
    }
  });
  if (UI.hsMenu === 'template') window.closeHsMenu(true);
  else renderStep1();
};

// Global default templates never carry a baked-in logo slot (that's always
// project-specific artwork), so unlike applyCustomTemplate above there's no
// cropSvgToArtwork re-crop step needed here.
window.applyDefaultTemplate = function (id) {
  const tmpl = HS_DEFAULT_TEMPLATES.find(t => t.id === id);
  if (!tmpl) return;
  const prev = captureUserCaptions();
  HS.templateStyle = tmpl.templateStyle;
  HS.background    = { ...tmpl.background };
  HS.topText       = { ...tmpl.topText };
  HS.bottomText    = { ...tmpl.bottomText };
  HS.bannerTop     = mergeBanner(tmpl.bannerTop);
  HS.bannerBottom  = mergeBanner(tmpl.bannerBottom);
  replaceBannerDockSeeds(tmpl);
  HS.templateLogos = cloneTemplateLogos(tmpl.templateLogos);
  HS.captionsEdited = defaultCaptionsEdited();
  restoreUserCaptions(prev);
  if (UI.hsMenu === 'template') window.closeHsMenu(true);
  else renderStep1();
};

export function cloneTemplateLogos(tl) {
  if (!tl) return emptyTemplateLogos();
  return {
    count: tl.count ?? 0,
    size: tl.size || 'md',
    vAlign: tl.vAlign || 'top',
    hAlign: tl.hAlign || 'spread',
    stack: tl.stack || 'horizontal',
    slots: (tl.slots || []).map(s => ({ ...s, logoSrcTight: undefined })),
    ...(tl.customPositions ? { customPositions: true } : {}),
  };
}

export function updateStep1Preview() {
  const el = document.getElementById('hsStep1Preview');
  if (!el) return;
  // Re-snap template logo slots to the current layout whenever the preview
  // refreshes, so banner/text changes automatically reposition non-custom slots.
  const tl = HS.templateLogos;
  if (tl && !tl.customPositions && tl.count > 0) snapTlSlotsToDefaults(tl);
  el.innerHTML = '';
  // Background SVG. Strip the template-logo slots so the interactive DOM
  // overlays own the slot display (otherwise the SVG copy bleeds out from
  // behind the live overlay during drag/resize — the "halo").
  // Always hide text layers (and top/bottom band text) from the SVG — DOM
  // overlays own the display to avoid the double-render halo, and so the
  // corner-resize handles can scale the visible text in real time instead of
  // only an invisible proxy (same pattern as template logo slots / stripSlotImages).
  const previewState = { ...stripSlotImages(HS), hideTextLayers: (HS.textLayers || []).map(l => l.id), hideText: ['top', 'bottom'] };
  const bg = document.createElement('div');
  bg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  renderHoleSignInto(bg, previewState, { templateId: HS.templateStyle });
  const svg = bg.querySelector('svg');
  if (svg) {
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';
    el.appendChild(svg);
  }
  // Logo block-drag overlay sits beneath the slot overlays so slot clicks work.
  // (Banner drag is handled by the inline text-edit zones below.)
  wireElementDrag(el, 'logos');
  paintTplSlotOverlays(el, HS);
  paintTextLayerOverlays(el, HS);
  wireCanvasTextEditing(el);
  wireBannerHeightHandles(el);
  wireBannerSpacingHandles(el);
  // Show where each variation's logo will land, the same dashed placeholder used
  // on the Variations page, so the template preview reads as a full layout.
  const lz = getLogoZone(HS, HS.templateStyle);
  const pctP = (val, total) => (val / total * 100).toFixed(4) + '%';
  const ph = document.createElement('div');
  ph.className = 'dzone hs-logo-placeholder';
  ph.style.cssText = `left:${pctP(lz.x, HS_W)};top:${pctP(lz.y, HS_H)};width:${pctP(lz.w, HS_W)};height:${pctP(lz.h, HS_H)};pointer-events:none;`;
  ph.innerHTML = '<span class="hs-ph-label">Variation logo</span>';
  el.appendChild(ph);
  // Clicking the canvas background (not on an interactive element) either:
  // (a) lands inside an enabled banner's own rect with no docked text/handle
  //     under the cursor — auto-open that banner's details section (matches
  //     the tplSlot-tap precedent above), or
  // (b) lands anywhere else with something already open/selected — closes the
  //     current submenu, returns to the main menu list, and deselects any
  //     selected image(s)/banner/text, including a multi-selection, so
  //     clicking off two shift-selected images deselects both, not just
  //     closes their panel, or
  // (c) lands anywhere else with nothing open/selected — the background
  //     itself is the only thing under the tap, so open its own section
  //     (tapping it again, or anything else, closes it same as any other
  //     section per (b)). Deselecting something per (b) must NOT also fall
  //     through to this — see hadSelectionBeforeClick above.
  // `el` is a persistent node reused across every updateStep1Preview() call
  // (only its children are torn down above) — guard so this only ever gets
  // wired once per node, not once per call. A duplicate listener here doesn't
  // just waste work: the second, stale copy runs its own bannerHit/hitTest
  // against `el`'s already-current rect and re-evaluates UI.hsMenu *after*
  // the first copy already acted on it — e.g. opening the Background section
  // only for the second copy to immediately see UI.hsMenu now set and close
  // it right back, all within the same click (visible as a quick open/close
  // jolt instead of a clean open).
  if (!el.dataset.bgClickWired) {
    el.dataset.bgClickWired = '1';
    el.addEventListener('click', e => {
      const onInteractive = e.target.closest('.canvas-edit-zone,.tl-slot,.band-drag,.dzone,.hs-tl-overlay,.hs-banner-height-handle,.hs-banner-spacing-handle');
      if (onInteractive) return;
      const r = el.getBoundingClientRect();
      const cx = (e.clientX - r.left) / r.width * HS_W;
      const cy = (e.clientY - r.top) / r.height * HS_H;
      const bannerHit = hitTestDockZone(HS, cx, cy, null);
      if (bannerHit) {
        const key = bannerHit === 'bottom' ? 'bannerBottom' : 'bannerTop';
        if (UI.hsMenu !== key) window.openHsMenu(key);
        return;
      }
      const hadSelection = hadSelectionBeforeClick;
      if (UI.tlSelectedIdxs.size > 0) UI.tlSelectedIdxs.clear();
      if (UI.hsMenu) window.closeHsMenu(true);
      else if (hadSelection) updateStep1Preview();
      else window.openHsMenu('background');
    }, { capture: false });
  }
}

// Return a shallow clone of `state` with the template-logo slot images zeroed
// out, so the SVG keeps the strip layout but skips drawing the slot bitmaps.
export function stripSlotImages(state) {
  return {
    ...state,
    templateLogos: state.templateLogos ? {
      ...state.templateLogos,
      slots: (state.templateLogos.slots || []).map(() => null),
    } : state.templateLogos,
  };
}

// Paint interactive DOM overlays on top of a preview SVG. Slots with logos
// show hover actions (Remove), and — in the interactive (non-locked) case —
// drag/resize via the same shared image component (image-box.js) and dark
// action-bar toolbar as any other placed logo (flags, hole-sign variations).
export function paintTplSlotOverlays(parentEl, state, { locked = false, variation = null } = {}) {
  const tl = state.templateLogos;
  if (!tl || !tl.count) return;
  const slots = getTemplateLogoSlots(state, state.templateStyle);
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  slots.forEach((rect, i) => {
    const slot = tl.slots[i] || (tl.slots[i] = {});

    // Shared visual content — an image (or file-type badge) clipped to the
    // slot's own shape, or an "Add logo" placeholder for an empty slot.
    // Built once and handed to either the locked (plain div) or interactive
    // (createImageBox) box below as their `visualEl`.
    let visualEl;
    if (slot.logoSrc) {
      const imgClip = document.createElement('div');
      imgClip.className = 'tl-slot-imgclip';
      const slotSrc = slot.logoSrcTight || slot.logoSrc;
      let slotVisual;
      if (isDisplayableImage(slotSrc)) {
        slotVisual = document.createElement('img');
        slotVisual.src = slotSrc;
        slotVisual.alt = '';
        slotVisual.draggable = false;
        slotVisual.className = 'tl-slot-img';
        // Natural size (and so rendered size, since it can be scaled to fit)
        // isn't known until load — clipping any earlier uses a stale rect.
        slotVisual.addEventListener('load', () => clipToCanvas(slotVisual, parentEl));
      } else {
        slotVisual = document.createElement('div');
        slotVisual.className = 'tl-slot-img tl-slot-file-badge';
        slotVisual.textContent = fileTypeLabel(slotSrc);
      }
      applyTlSlotImgStyle(slotVisual, slot);
      imgClip.appendChild(slotVisual);
      visualEl = imgClip;
    } else {
      const ph = document.createElement('div');
      ph.className = 'tl-slot-placeholder';
      ph.innerHTML = '<span><i class="fa-solid fa-plus" aria-hidden="true"></i></span><span class="tl-slot-ph-label">Add logo</span>';
      visualEl = ph;
    }

    if (locked) {
      // Quick-edit mode (Variations page, not in the full pencil editor):
      // one click swaps this slot's image — silently starts (or continues) a
      // draft for `variation` and auto-applies as soon as a logo is picked,
      // with no visible side panel or Apply step. No drag/resize, so this
      // stays a plain (non-image-box.js) box — same shape as before.
      const overlay = document.createElement('div');
      overlay.className = 'tl-slot' + (slot.logoSrc ? ' has-logo' : '') + (slot.aboveFrame ? ' above-frame' : '') + ' locked';
      overlay.style.cssText = `position:absolute;left:${pct(rect.x, HS_W)};top:${pct(rect.y, HS_H)};width:${pct(rect.w, HS_W)};height:${pct(rect.h, HS_H)};`;
      overlay.dataset.idx = i;
      if (slot.logoSrc) {
        if (slot.bg && slot.bg !== 'transparent') overlay.style.background = slot.bg;
        if (slot.border?.color && slot.ratio !== 'fit') overlay.style.border = `1.5px solid ${slot.border.color}`;
      }
      overlay.appendChild(visualEl);

      const hoverActions = document.createElement('div');
      hoverActions.className = 'tl-slot-hover-actions';
      if (slot.logoSrc) {
        const swapBtn = document.createElement('button');
        swapBtn.className = 'tl-slot-mini-btn';
        swapBtn.title = 'Swap image';
        swapBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>';
        swapBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (variation) beginQuickEdit(variation);
          openTlLibPicker(i, { onAssigned: () => applyQuickLogoSlot(i) });
        });
        hoverActions.appendChild(swapBtn);
      }
      const removeBtn = document.createElement('button');
      removeBtn.className = 'tl-slot-mini-btn tl-slot-remove';
      removeBtn.title = 'Remove';
      removeBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
      removeBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (variation) beginQuickEdit(variation);
        window.removeTlSlot(i);
        window.applyEditVar();
      });
      hoverActions.appendChild(removeBtn);
      overlay.appendChild(hoverActions);

      overlay.addEventListener('click', e => {
        e.stopPropagation();
        // Not focusable, so a native click here never blurs an in-progress
        // text-band edit on its own (see the matching fix on var-canvas.js's
        // logo dzone clicks) — force it, or HS.editingDraft is left dangling
        // and getEffectiveState keeps reading its now-stale content.
        commitActiveCanvasEdit(overlay);
        if (variation) beginQuickEdit(variation);
        openTlLibPicker(i, { onAssigned: () => applyQuickLogoSlot(i) });
      });
      parentEl.appendChild(overlay);
      if (slot.logoSrc) {
        const visual = overlay.querySelector('.tl-slot-img');
        if (visual) requestAnimationFrame(() => clipToCanvas(visual, parentEl));
      }
      return;
    }

    // Interactive (non-locked): the same draggable/resizable image box and
    // dark toolbar as flag logos / hole-sign variation logos. A getter/
    // setter adapter over the slot's absolute-pixel freeX/freeY/freeW/freeH
    // (falling back to the computed default `rect` until first customized)
    // lets image-box.js's own percent-of-zone x/y/w/h model drive them
    // directly, with no separate copy of the drag/resize math to maintain.
    const fw = () => slot.freeW ?? rect.w;
    const fh = () => slot.freeH ?? rect.h;
    const fx = () => slot.freeX ?? rect.x;
    const fy = () => slot.freeY ?? rect.y;
    const data = {
      get w() { return fw() / HS_W * 100; },
      set w(v) { slot.freeW = v / 100 * HS_W; },
      get h() { return fh() / HS_H * 100; },
      set h(v) { slot.freeH = v / 100 * HS_H; },
      get x() { return (fx() + fw() / 2) / HS_W * 100; },
      set x(v) { slot.freeX = (v / 100 * HS_W) - fw() / 2; },
      get y() { return (fy() + fh() / 2) / HS_H * 100; },
      set y(v) { slot.freeY = (v / 100 * HS_H) - fh() / 2; },
    };

    // Sibling slots' edges/centers as extra drag-snap targets, so one slot
    // can still snap into alignment with another (ported from the old
    // per-slot free-drag's cross-slot snap — center-point-only now, since
    // it rides on image-box.js's own center-based snap check rather than a
    // bespoke leading/center/trailing-edge comparison).
    const others = slots.filter((_, j) => j !== i);
    const extraSnapX = others.flatMap(r => [r.x, r.x + r.w / 2, r.x + r.w]).map(px => px / HS_W * 100);
    const extraSnapY = others.flatMap(r => [r.y, r.y + r.h / 2, r.y + r.h]).map(px => px / HS_H * 100);

    if (slot.logoSrc) {
      if (slot.bg && slot.bg !== 'transparent') visualEl.style.background = slot.bg;
      if (slot.border?.color && slot.ratio !== 'fit') visualEl.style.border = `1.5px solid ${slot.border.color}`;
    }

    let wrap;
    wrap = createImageBox(parentEl, parentEl, data, {
      visualEl,
      aboveFrame: !!slot.aboveFrame,
      minW: 300 / HS_W * 100,
      extraSnapX, extraSnapY,
      onStart: () => closeTlSlotToolbar(),
      onCommit: () => {
        tlSource().customPositions = true;
        redrawTplPreview();
        if (UI.tlSelectedIdxs.has(i)) {
          const freshWrap = parentEl.querySelector(`.dz-logo-wrap[data-tl-idx="${i}"]`);
          if (freshWrap) openTlSlotToolbar(i, freshWrap);
        }
      },
      onClick: () => {
        // Selecting this image and selecting a text layer are mutually
        // exclusive on this canvas — drop any active text-layer selection
        // (and its toolbar) the same way deselectTlSlots() drops an active
        // image selection when a text layer gets clicked (see the text-layer
        // click handlers above).
        if (UI.activeTextLayerId) {
          UI.activeTextLayerId = null;
          document.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.remove('selected'));
          window.closeTextLayerToolbar?.();
        }
        window.deselectBandZones?.();
        UI.tlSelectedIdxs = new Set([i]);
        parentEl.querySelectorAll('.dz-logo-wrap[data-tl-idx]').forEach(w => {
          w.classList.toggle('selected', w.dataset.tlIdx === String(i));
        });
        if (slot.logoSrc) {
          openTlSlotToolbar(i, wrap);
        } else {
          openTlLibPicker(i);
        }
      },
      onRemove: () => window.removeTlSlot(i),
    });
    wrap.dataset.tlIdx = i;
    wrap.classList.toggle('selected', UI.tlSelectedIdxs.has(i));
    parentEl.appendChild(wrap);
    if (slot.logoSrc) {
      const visual = wrap.querySelector('.tl-slot-img');
      if (visual) requestAnimationFrame(() => clipToCanvas(visual, parentEl));
    }
  });
}

function repositionToolbar(anchorEl, toolbarId = 'hsTlToolbar') {
  const tb = document.getElementById(toolbarId);
  if (!tb) return;
  const container = anchorEl.closest('.hs-design-preview-col');
  positionFloatingToolbar(tb, anchorEl, container);
}

export { repositionToolbar };

// Measure the actual rendered width of a text layer's longest line using canvas.
// Returns width in SVG sign coordinates.
// Y/X snap targets drawn from banner and logo zone positions.
function getSnapTargets(state) {
  const ySnaps = [0, HS_H / 2, HS_H];
  const xSnaps = [0, HS_W / 2, HS_W];
  const bt = getBannerRect(state, 'top');
  const bb = getBannerRect(state, 'bottom');
  if (bt) { ySnaps.push(bt.y, bt.y + bt.h); }
  if (bb) { ySnaps.push(bb.y, bb.y + bb.h); }
  const lz = getLogoZone(state, state.templateStyle);
  if (lz) { ySnaps.push(lz.y, lz.y + lz.h); xSnaps.push(lz.x, lz.x + lz.w); }
  return {
    ySnaps: [...new Set(ySnaps)].sort((a, b) => a - b),
    xSnaps: [...new Set(xSnaps)].sort((a, b) => a - b),
  };
}


// Zoom (canvas-panel.js) resizes the preview wrapper's real px dimensions
// without re-running a full repaint, so DOM text overlays — which bake their
// font-size to a one-time px snapshot of `<model size> * (containerPx / HS_H)`
// at paint time (free text layers here, band hotspot/editor in banner.js,
// inline editor in text-layers.js) — go stale while the underlying SVG (sized
// via viewBox) keeps tracking zoom automatically. Every site that stamps a
// px font-size onto one of these overlays also stamps `data-base-size` with
// the un-scaled model value, so this just recomputes px from the current
// container height — call after any zoom change.
export function rescaleTextOverlayFonts(previewEl) {
  if (!previewEl) return;
  const sc = (previewEl.offsetHeight || HS_H) / HS_H;
  previewEl.querySelectorAll('[data-base-size]').forEach(el => {
    const base = parseFloat(el.dataset.baseSize);
    if (!Number.isFinite(base)) return;
    el.style.fontSize = Math.max(8, Math.round(base * sc)) + 'px';
  });
}

// Narrowest width (in HS-space units) that keeps `text` on a single line
// under the *exact* wrapping rules `.hs-tl-content` renders with. Starts from
// the plain unwrapped width as a guess, then verifies by actually rendering
// at that width with matching CSS (white-space/word-break/line-height) and
// growing it until it genuinely doesn't wrap — a plain unwrapped measurement
// alone is close but not reliably exact (word-break compounding, sub-pixel
// font-metric rounding that isn't linear across sizes), and wrapText has zero
// tolerance for landing even a fraction of a pixel short.
function measureNaturalWidthHS(text, fontFamily, fsPx, sx) {
  const t = text || 'Text';
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:-9999px;` +
    `word-break:break-word;line-height:1.1;font-family:${fontFamily};font-size:${fsPx}px;`;
  probe.textContent = t;
  document.body.appendChild(probe);

  probe.style.whiteSpace = 'pre';
  let w = Math.ceil(probe.offsetWidth) + 4;
  // Baseline single-line box height, captured here (guaranteed unwrapped —
  // white-space:pre never breaks). scrollHeight is NOT usable for the check
  // below: some fonts' descenders bleed past the line box, so scrollHeight
  // reports a few px taller than offsetHeight even for one true line —
  // comparing against it made every width look "still wrapped" and grow
  // needlessly. offsetHeight doesn't have that quirk.
  const singleLineH = probe.offsetHeight;

  probe.style.whiteSpace = 'pre-wrap';
  probe.style.width = w + 'px';
  let guard = 0;
  while (probe.offsetHeight > singleLineH + 1 && guard++ < 20) {
    w += Math.max(4, Math.ceil(w * 0.05));
    probe.style.width = w + 'px';
  }
  probe.remove();
  return Math.ceil(w / sx);
}

// Shrinks/grows a "collapsed" (layer.autoWidth) text layer's box to exactly
// fit its current text/font/size, re-centered on its previous center. Called
// on every repaint (see paintTextLayerOverlays below) so the box keeps
// tracking content as it changes, not just once at the moment it collapsed.
export function applyAutoWidth(layer, parentEl) {
  const fontFamily = HS_FONTS.find(f => f.id === layer.font)?.family || "'DM Serif Display', serif";
  const sc = parentEl.offsetHeight / HS_H;
  const fsPx = Math.max(8, Math.round(layer.size * sc));
  const sx = parentEl.offsetWidth / HS_W;
  const newW = Math.max(layer.size, measureNaturalWidthHS(layer.text, fontFamily, fsPx, sx));
  const center = layer.x + layer.w / 2;
  layer.w = newW;
  layer.x = Math.round(center - newW / 2);
}

export function paintTextLayerOverlays(parentEl, state, { locked = false, variation = null } = {}) {
  parentEl.querySelectorAll('.hs-tl-overlay').forEach(el => el.remove());
  const layers = state.textLayers || [];
  if (!layers.length) return;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  const { ySnaps, xSnaps } = getSnapTargets(state);
  // A layer docked to a banner (see hole-sign-data.js/hole-sign-render.js) is
  // positioned by that banner's computed stack, not its own stored x/y/w.
  const dockPosByWhich = { top: dockedLayerPositions(state, 'top'), bottom: dockedLayerPositions(state, 'bottom') };

  layers.forEach(layer => {
    const sc = parentEl.offsetHeight / HS_H;
    const fontFamily = HS_FONTS.find(f => f.id === layer.font)?.family || "'DM Serif Display', serif";
    const fsPx = Math.max(8, Math.round(layer.size * sc));
    const isActive = UI.activeTextLayerId === layer.id;
    const dockPos = layer.dock ? dockPosByWhich[layer.dock]?.[layer.id] : null;
    // Collapsed layers keep re-fitting their box on every repaint — not just
    // at the moment they collapsed — so edits (typed text, font, size) keep
    // it snug instead of leaving it sized for whatever the content used to be.
    if (!dockPos && layer.autoWidth) applyAutoWidth(layer, parentEl);
    const boxX = dockPos ? dockPos.x : layer.x;
    const boxY = dockPos ? dockPos.y : layer.y;
    const boxW = dockPos ? dockPos.w : (layer.w || Math.round(HS_W * 0.8));

    const overlay = document.createElement('div');
    // .above-frame/.below-frame drive this free layer's z-index (style.css)
    // so the toolbar's arrange buttons actually move it on the live canvas,
    // not just in exported output — a docked layer always paints above the
    // frame regardless of its own aboveFrame flag (see hole-sign-render.js's
    // `layer.aboveFrame || layer.dock`), so it's left off that pair and keeps
    // the base .hs-tl-overlay tier instead, same as the static banner zones.
    const tierClass = layer.dock ? '' : (layer.aboveFrame ? ' above-frame' : ' below-frame');
    overlay.className = 'hs-tl-overlay' + tierClass + (isActive ? ' selected' : '') + (layer.dock ? ' docked' : '') + (locked ? ' locked' : '');
    overlay.dataset.tlId = layer.id;
    // No fixed height — auto-sizes to text content. Wrapping + font-size changes
    // both flow into height naturally, giving real-time resize feedback.
    overlay.style.cssText = `position:absolute;left:${pct(boxX, HS_W)};top:${pct(boxY, HS_H)};width:${pct(boxW, HS_W)};`;

    // Permanent text content — the only visual render (SVG copy always hidden).
    // Normal-flow div so the overlay auto-sizes to it; white-space:pre-wrap so
    // the box width constrains lines and height grows automatically.
    const textDiv = document.createElement('div');
    textDiv.className = 'hs-tl-content';
    textDiv.style.cssText = [
      'width:100%;pointer-events:none;overflow:visible;',
      `font-family:${fontFamily};font-size:${fsPx}px;`,
      `color:${layer.color};text-align:${layer.align || 'center'};`,
      'line-height:1.1;white-space:pre-wrap;word-break:break-word;',
    ].join('');
    textDiv.textContent = layer.text || 'Text';
    // Un-scaled model value — lets rescaleTextOverlayFonts() (design.js) recompute
    // fsPx from the current container size on zoom, without needing layer lookup.
    textDiv.dataset.baseSize = layer.size;
    overlay.appendChild(textDiv);

    // ── Resize / scale handles ────────────────────────────────────────────────
    // All handles are always in the DOM; CSS controls opacity/pointer-events.
    // Skipped entirely in locked mode: positions/sizes stay fixed there.
    if (!locked) {

    // Double-clicking either width handle snaps the box to the logo boundary's
    // full width (matching the default addTextLayer() gives a new layer); a
    // second double-click, once already at that width, instead collapses it
    // to fit the text's own natural (unwrapped) width — and, via layer.autoWidth
    // (see applyAutoWidth/paintTextLayerOverlays above), keeps re-fitting on
    // every later edit instead of freezing at today's content. Not offered
    // for docked layers — their width is already driven by the banner's own fit.
    function handleWidthHandleDblClick(e) {
      e.stopPropagation();
      if (layer.dock) return;
      const lz = getLogoZone(state, state.templateStyle);
      const atZoneWidth = Math.abs((layer.w || 0) - lz.w) <= 2;
      if (atZoneWidth) {
        layer.autoWidth = true;
        applyAutoWidth(layer, parentEl);
      } else {
        layer.autoWidth = false;
        layer.w = lz.w;
        layer.x = lz.x;
      }
      overlay.style.left  = pct(layer.x, HS_W);
      overlay.style.width = pct(layer.w, HS_W);
      clipToCanvas(textDiv, parentEl);
      if (HS.editingVarId) window._hsRenderVariationPreview?.();
      else updateStep1Preview();
    }
    // Detected manually from pointerdown timing/position rather than the
    // native 'dblclick' event: every plain click on either handle re-renders
    // the whole overlay tree on pointerup (see below), which replaces this
    // handle with a fresh DOM node — browsers key click-count tracking to a
    // stable target element, so a real 'dblclick' listener here would almost
    // never fire once the first click's repaint swaps the node out from under
    // it. UI.tlWidthDblClick persists across those repaints (it's on the
    // ephemeral UI object, keyed by layer id + side) so the second click is
    // still recognized as a pair with the first.
    function checkWidthHandleDblClick(side) {
      const now = Date.now();
      const prev = UI.tlWidthDblClick;
      if (prev && prev.id === layer.id && prev.side === side && now - prev.t < 400) {
        UI.tlWidthDblClick = null;
        return true;
      }
      UI.tlWidthDblClick = { id: layer.id, side, t: now };
      return false;
    }

    // Left-edge handle — drags left edge, keeps right edge fixed
    const lh = document.createElement('div');
    lh.className = 'hs-tl-resize-l';
    let lhStartX, lhStartLayerX, lhStartW;
    lh.addEventListener('pointerdown', e => {
      e.stopPropagation();
      if (checkWidthHandleDblClick('l')) { e.preventDefault(); handleWidthHandleDblClick(e); return; }
      layer.autoWidth = false; // manual drag overrides the collapsed auto-fit
      lh.setPointerCapture(e.pointerId);
      lhStartX = e.clientX; lhStartLayerX = layer.x; lhStartW = layer.w;
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    lh.addEventListener('pointermove', e => {
      if (!lh.hasPointerCapture(e.pointerId)) return;
      const sx = parentEl.offsetWidth / HS_W;
      const dx = (e.clientX - lhStartX) / sx;
      if (layer.dock) {
        // Docked layers are always centered within the banner's margin span
        // (see fitTextBox) — grow symmetrically from center instead of
        // sliding just the left edge, so the live drag matches the re-render.
        const newW = Math.max(layer.size, Math.round(lhStartW - dx * 2));
        layer.w = newW;
        const pos = dockedLayerPositions(state, layer.dock)[layer.id];
        if (pos) { overlay.style.left = pct(pos.x, HS_W); overlay.style.width = pct(pos.w, HS_W); }
      } else {
        const rightEdge = lhStartLayerX + lhStartW;
        const newW = Math.max(layer.size, Math.round(lhStartW - dx));
        layer.x = rightEdge - newW; layer.w = newW;
        overlay.style.left  = pct(layer.x, HS_W);
        overlay.style.width = pct(newW, HS_W);
      }
      clipToCanvas(textDiv, parentEl);
    });
    lh.addEventListener('pointerup', () => {
      document.body.style.cursor = '';
      if (HS.editingVarId) window._hsRenderVariationPreview?.();
      else updateStep1Preview();
    });
    overlay.appendChild(lh);

    // Right-edge handle — drags right edge, keeps left edge fixed
    const rh = document.createElement('div');
    rh.className = 'hs-tl-resize-r';
    let rhStartX, rhStartW;
    rh.addEventListener('pointerdown', e => {
      e.stopPropagation();
      if (checkWidthHandleDblClick('r')) { e.preventDefault(); handleWidthHandleDblClick(e); return; }
      layer.autoWidth = false; // manual drag overrides the collapsed auto-fit
      rh.setPointerCapture(e.pointerId);
      rhStartX = e.clientX; rhStartW = layer.w;
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    rh.addEventListener('pointermove', e => {
      if (!rh.hasPointerCapture(e.pointerId)) return;
      const sx = parentEl.offsetWidth / HS_W;
      const dx = (e.clientX - rhStartX) / sx;
      if (layer.dock) {
        const newW = Math.max(layer.size, Math.round(rhStartW + dx * 2));
        layer.w = newW;
        const pos = dockedLayerPositions(state, layer.dock)[layer.id];
        if (pos) { overlay.style.left = pct(pos.x, HS_W); overlay.style.width = pct(pos.w, HS_W); }
      } else {
        const newW = Math.max(layer.size, Math.round(rhStartW + dx));
        layer.w = newW;
        overlay.style.width = pct(newW, HS_W);
      }
      clipToCanvas(textDiv, parentEl);
    });
    rh.addEventListener('pointerup', () => {
      document.body.style.cursor = '';
      if (HS.editingVarId) window._hsRenderVariationPreview?.();
      else updateStep1Preview();
    });
    overlay.appendChild(rh);

    // Corner handles — drag outward to increase font size, inward to decrease.
    // xSign / ySign indicate the "outward" direction for each corner.
    const makeCorner = (cls, xSign, ySign) => {
      const ch = document.createElement('div');
      ch.className = `hs-tl-resize-corner ${cls}`;
      let chStartX, chStartY, chStartSize, chStartW, chStartLayerX;
      ch.addEventListener('pointerdown', e => {
        e.stopPropagation();
        ch.setPointerCapture(e.pointerId);
        chStartX = e.clientX; chStartY = e.clientY; chStartSize = layer.size;
        chStartW = layer.w;
        // A docked layer's real on-screen x is its computed dock position, not
        // the (possibly stale) stored layer.x — center growth from that instead.
        chStartLayerX = layer.dock ? (dockedLayerPositions(state, layer.dock)[layer.id]?.x ?? layer.x) : layer.x;
        document.body.style.cursor = getComputedStyle(ch).cursor || 'nwse-resize';
        e.preventDefault();
      });
      ch.addEventListener('pointermove', e => {
        if (!ch.hasPointerCapture(e.pointerId)) return;
        const dx = (e.clientX - chStartX) * xSign;
        const dy = (e.clientY - chStartY) * ySign;
        // Use whichever axis is being dragged more strongly
        const outward = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
        const newSize = Math.max(60, Math.min(2000, Math.round(chStartSize + outward * 1.5)));
        layer.size = newSize;
        const sc = parentEl.offsetHeight / HS_H;
        const fsPxNow = Math.max(8, Math.round(newSize * sc));
        textDiv.style.fontSize = fsPxNow + 'px';
        textDiv.dataset.baseSize = newSize;

        // Scale the box's width along with the font size (same ratio), growing
        // outward from its center — otherwise the box lags behind and the text
        // just wraps onto more lines instead of visibly growing. Ratio-scaling
        // alone can undershoot by a hair (each size rounds to its own integer
        // CSS px independently, so width doesn't scale in perfect lockstep with
        // size) and wrap a trailing letter — floor it against the text's actual
        // measured width at the new size so that can't happen. A collapsed
        // (autoWidth) layer uses that measured width outright, so it keeps
        // tracking content exactly instead of drifting from repeated ratio math.
        const ratioW = Math.round(chStartW * (newSize / chStartSize));
        const sx = parentEl.offsetWidth / HS_W;
        const naturalW = measureNaturalWidthHS(layer.text, fontFamily, fsPxNow, sx);
        const newW = layer.autoWidth && !layer.dock
          ? Math.max(newSize, naturalW)
          : Math.max(newSize, ratioW, naturalW);
        layer.w = newW;
        layer.x = chStartLayerX + Math.round((chStartW - newW) / 2);
        overlay.style.width = pct(newW, HS_W);
        overlay.style.left  = pct(layer.x, HS_W);

        // Sync toolbar slider live
        const slider = document.getElementById('hsTlSizeSlider');
        const val    = document.getElementById('hsTlSizeVal');
        if (slider) slider.value = newSize;
        if (val) val.textContent = newSize;
        clipToCanvas(textDiv, parentEl);
      });
      ch.addEventListener('pointerup', () => {
        document.body.style.cursor = '';
        if (HS.editingVarId) window._hsRenderVariationPreview?.();
        else updateStep1Preview();
      });
      return ch;
    };
    overlay.appendChild(makeCorner('tl', -1, -1));
    overlay.appendChild(makeCorner('tr',  1, -1));
    overlay.appendChild(makeCorner('bl', -1,  1));
    overlay.appendChild(makeCorner('br',  1,  1));
    }

    if (locked) {
      // Quick-edit mode: one click starts (or continues) a draft for
      // `variation` and drops straight into inline text editing — no
      // select-then-toolbar step, no drag. Auto-applies on commit.
      overlay.addEventListener('click', e => {
        e.stopPropagation();
        commitActiveCanvasEdit(overlay);
        deselectTlSlots();
        hideHsToolbar();
        window.deselectBandZones?.();
        if (variation) beginQuickEdit(variation);
        document.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.remove('selected'));
        overlay.classList.add('selected');
        UI.activeTextLayerId = layer.id;
        window.enterTextLayerEditMode?.(layer.id, overlay, { onCommit: () => applyQuickTextLayer(layer.id) });
      });
      parentEl.appendChild(overlay);
      requestAnimationFrame(() => clipToCanvas(textDiv, parentEl));
      return;
    }

    overlay.addEventListener('click', e => {
      e.stopPropagation();
      commitActiveCanvasEdit(overlay);
      deselectTlSlots();
      hideHsToolbar();
      window.deselectBandZones?.();
      document.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.remove('selected'));
      overlay.classList.add('selected');
      UI.activeTextLayerId = layer.id;
      window.closeHsMenuSection?.(true);
      window.openTextLayerToolbar?.(layer.id, overlay);
    });

    overlay.addEventListener('dblclick', e => {
      e.stopPropagation();
      window.enterTextLayerEditMode?.(layer.id, overlay);
    });

    let startCX, startCY, startX, startY, didDrag = false;
    // The zone (if any) this layer is currently docked/hovering-to-dock to
    // during this drag — re-evaluated every tick, seeded from its dock state
    // at drag start so hitTestDockZone can apply undock hysteresis correctly.
    let dockHit = null;
    // Set while hovering within HS_BANNER_EDGE_PX of a top/bottom edge whose
    // banner isn't enabled yet (so hitTestDockZone has no rect to hit at all)
    // — 'top' | 'bottom' | null. Dropping here enables that banner and docks
    // this layer into it.
    let pendingBannerEnable = null;
    // Set when this drag disables a banner (its last docked layer left) —
    // pointerup needs a structural redraw then, same as enabling one, so the
    // now-unneeded height/spacing handles actually disappear.
    let bannerWasDisabled = false;

    overlay.addEventListener('pointerdown', e => {
      if (e.target.closest('.hs-tl-editor-wrap, .hs-tl-resize-l, .hs-tl-resize-r, .hs-tl-resize-corner')) return;
      overlay.setPointerCapture(e.pointerId);
      startCX = e.clientX; startCY = e.clientY;
      // Start from the layer's current visual box (its computed dock position
      // if docked, else its stored x/y) so the first move doesn't jump.
      const dockPos0 = layer.dock ? dockPosByWhich[layer.dock]?.[layer.id] : null;
      startX = dockPos0 ? dockPos0.x : layer.x;
      startY = dockPos0 ? dockPos0.y : layer.y;
      dockHit = layer.dock || null;
      pendingBannerEnable = null;
      bannerWasDisabled = false;
      didDrag = false;
      e.preventDefault();
    });

    overlay.addEventListener('pointermove', e => {
      if (!overlay.hasPointerCapture(e.pointerId)) return;
      const sx = parentEl.offsetWidth  / HS_W;
      const sy = parentEl.offsetHeight / HS_H;
      const dx = (e.clientX - startCX) / sx;
      const dy = (e.clientY - startCY) / sy;

      if (!didDrag && Math.hypot(dx, dy) > 5) {
        didDrag = true;
        window.closeTextLayerToolbar?.();
        document.body.style.cursor = 'grabbing';
      }
      if (!didDrag) return;

      let nx = Math.round(startX + dx);
      let ny = Math.round(startY + dy);

      // Never let the free-dragged box leave the design canvas — clamp here,
      // before any docking/snap logic below reads nx/ny, so every branch
      // (shift-drag, banner-dock, plain free-drag) inherits the same bound.
      const boxHForClamp = overlay.offsetHeight / sy;
      nx = Math.max(0, Math.min(HS_W - (layer.w || 0), nx));
      ny = Math.max(0, Math.min(HS_H - boxHForClamp, ny));

      if (e.shiftKey) {
        // Shift always means free positioning + edge-snap, regardless of zone
        // overlap — an explicit "pull this out precisely" escape hatch, so
        // undock immediately if it was docked.
        if (dockHit) { dockHit = null; layer.dock = null; overlay.classList.remove('hs-dock-reflow'); }
        const snapX = findAxisSnap(xSnaps, nx, 0, 200);
        const snapY = findAxisSnap(ySnaps, ny, 0, 200);
        if (snapX) nx = snapX.newPos;
        if (snapY) ny = snapY.newPos;
        setAlignGuide(parentEl, 'v', !!snapX, snapX && pct(snapX.value, HS_W));
        setAlignGuide(parentEl, 'h', !!snapY, snapY && pct(snapY.value, HS_H));
        layer.x = nx; layer.y = ny;
        overlay.style.left = pct(nx, HS_W);
        overlay.style.top  = pct(ny, HS_H);
        clipToCanvas(textDiv, parentEl);
        return;
      }

      // Dock as soon as HS_DOCK_OVERLAP_PX of the box's edge has crossed into
      // an enabled banner's rect — and undock, symmetrically, once overlap
      // drops back below that — rather than waiting for the whole box to
      // cross the zone's center (see dockOverlapHit).
      const boxH = overlay.offsetHeight / sy;
      const cx = nx + (layer.w || 0) / 2;
      const cy = ny + boxH / 2;
      const hit = dockOverlapHit(state, ny, boxH, sy, dockHit, layer.id);

      if (hit) {
        if (pendingBannerEnable) { pendingBannerEnable = null; clearBannerPreview(parentEl); syncLogoZone(parentEl, state); }
        hideAlignGuides(parentEl);
        // Captured before any of the mutations below touch layer.dock — true
        // only on the tick this layer actually joins the banner (not on
        // every subsequent tick spent reordering within it).
        const enteringDock = layer.dock !== hit;
        const siblings = getDockedSiblings(state, hit, layer.id);
        const positions = dockedLayerPositions(state, hit);
        // Insertion index: first sibling whose stacked box midpoint sits below cy.
        let index = siblings.length;
        for (let i = 0; i < siblings.length; i++) {
          const r = positions[siblings[i].id];
          if (r && cy < r.y + r.h / 2) { index = i; break; }
        }
        if (layer.dock !== hit || (layer.dockOrder ?? 0) !== index) {
          const ordered = [...siblings];
          ordered.splice(index, 0, layer);
          ordered.forEach((l, i) => { l.dockOrder = i; });
        }
        layer.dock = hit;
        dockHit = hit;
        if (enteringDock) {
          // Joining the banner grows its accommodating height (bannerEffectiveHeight
          // already counts this layer now that layer.dock is set) — reflow the
          // real background band live so the banner visibly adjusts to fit
          // before the drop, not just after. Also repositions every docked
          // overlay (this one + siblings), so no need to do that separately.
          // Classes added before the reflow (not after) so the transition is
          // already armed when reflowBannerSvg's syncDockedLayerOverlays sets
          // the new positions — otherwise this first move into the banner
          // would snap both this layer and its new siblings instead of
          // easing them in/aside.
          parentEl.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.add('hs-dock-reflow'));
          const editingVar = HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null;
          reflowBannerSvg(parentEl, editingVar);
        } else {
          const freshPositions = dockedLayerPositions(state, hit);
          const myPos = freshPositions[layer.id];
          if (myPos) {
            overlay.classList.add('hs-dock-reflow');
            overlay.style.left  = pct(myPos.x, HS_W);
            overlay.style.top   = pct(myPos.y, HS_H);
            overlay.style.width = pct(myPos.w, HS_W);
          }
          // Reposition every sibling too, so they visibly shift to make room as
          // this layer drags past them — eased (.hs-dock-reflow) so the layout
          // adjusting to fit reads as a smooth transition, not a snap.
          siblings.forEach(sib => {
            const r = freshPositions[sib.id];
            const el = parentEl.querySelector(`.hs-tl-overlay[data-tl-id="${sib.id}"]`);
            if (el && r) {
              el.classList.add('hs-dock-reflow');
              el.style.left = pct(r.x, HS_W); el.style.top = pct(r.y, HS_H); el.style.width = pct(r.w, HS_W);
              const sibContent = el.querySelector('.hs-tl-content');
              if (sibContent) clipToCanvas(sibContent, parentEl);
            }
          });
        }
      } else {
        if (dockHit) {
          const leavingWhich = dockHit;
          // Captured before any mutation below — the band's shape right up
          // to the moment this layer leaves it, and the color it's rendered
          // in — so the shrink-ghost has something to ease FROM.
          const oldRect = getBannerRect(state, leavingWhich);
          const ghostColor = bannerSource(leavingWhich).bg?.color || '#E5E5E5';
          // This layer was the only thing keeping the banner occupied — turn
          // it back off instead of leaving an empty enabled band behind, the
          // mirror image of edgeHit enabling it when the first layer dropped
          // in. Checked before nulling layer.dock (getDockedSiblings already
          // excludes this layer by id either way).
          const wasLastDocked = getDockedSiblings(state, leavingWhich, layer.id).length === 0;
          dockHit = null; layer.dock = null;
          if (wasLastDocked) { bannerSource(leavingWhich).enabled = false; bannerWasDisabled = true; }
          // Leaving the banner shrinks its accommodating height back down
          // (bannerEffectiveHeight no longer counts this layer) — reflow live
          // so backing out of the banner before dropping visibly un-grows it.
          // Remaining siblings get the eased class so their shift-back reads
          // as smooth too; this layer is excluded (and un-classed) since it's
          // going back to pixel-locked free dragging, not a reflowed slot.
          parentEl.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.add('hs-dock-reflow'));
          overlay.classList.remove('hs-dock-reflow');
          const editingVar = HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null;
          reflowBannerSvg(parentEl, editingVar);
          // reflowBannerSvg's SVG swap already committed the new (smaller, or
          // fully gone) band instantly — this ghost is purely a visual fake
          // easing the color band's edge from the old shape down to it, so
          // the collapse actually reads as sliding up (top banner) or down
          // (bottom banner) instead of an instant pop.
          showBannerShrinkGhost(parentEl, leavingWhich, oldRect, getBannerRect(state, leavingWhich), ghostColor);
        }
        // No enabled banner to dock into (hitTestDockZone found nothing) — but
        // if the box is within HS_BANNER_EDGE_PX of a top/bottom edge whose
        // banner is off, preview enabling + docking into it on drop instead of
        // falling through to the plain free-drag snap below.
        const edgeThresh = HS_BANNER_EDGE_PX / sy;
        const edgeHit = (ny <= edgeThresh && !bannerSource('top').enabled) ? 'top'
          : ((ny + boxH) >= HS_H - edgeThresh && !bannerSource('bottom').enabled) ? 'bottom'
          : null;
        if (edgeHit) {
          pendingBannerEnable = edgeHit;
          hideAlignGuides(parentEl);
          showBannerPreview(parentEl, edgeHit);
          previewLogoZoneShrink(parentEl, state, edgeHit);
          layer.x = nx; layer.y = ny;
          overlay.style.left = pct(nx, HS_W);
          overlay.style.top  = pct(ny, HS_H);
        } else {
          if (pendingBannerEnable) { pendingBannerEnable = null; clearBannerPreview(parentEl); syncLogoZone(parentEl, state); }
          // Same box-center snap-to-canvas-center that logos and template-logo
          // slots already default to — matches image dragging, which snaps by
          // default too, unlike this default (non-Shift) path previously.
          const tolX = 5 / sx, tolY = 5 / sy;
          const snapX = findAxisSnap([HS_W / 2], cx, 0, tolX);
          const snapY = findAxisSnap([HS_H / 2], cy, 0, tolY);
          if (snapX) nx += snapX.newPos - cx;
          if (snapY) ny += snapY.newPos - cy;
          setAlignGuide(parentEl, 'v', !!snapX, '50%');
          setAlignGuide(parentEl, 'h', !!snapY, '50%');
          layer.x = nx; layer.y = ny;
          overlay.style.left = pct(nx, HS_W);
          overlay.style.top  = pct(ny, HS_H);
        }
      }
      clipToCanvas(textDiv, parentEl);
    });

    overlay.addEventListener('pointerup', () => {
      document.body.style.cursor = '';
      overlay.classList.remove('hs-dock-reflow');
      clearBannerPreview(parentEl);
      hideAlignGuides(parentEl);
      if (didDrag) {
        if (pendingBannerEnable) {
          const which = pendingBannerEnable;
          bannerSource(which).enabled = true;
          layer.dock = which;
          layer.dockOrder = 0;
          pendingBannerEnable = null;
          redrawBannerStructural();
        } else if (bannerWasDisabled) {
          redrawBannerStructural();
        } else if (HS.editingVarId) window._hsRenderVariationPreview?.();
        else updateStep1Preview();
        if (UI.activeTextLayerId === layer.id) {
          const newOverlay = parentEl.querySelector(`.hs-tl-overlay[data-tl-id="${layer.id}"]`);
          if (newOverlay) requestAnimationFrame(() => window.openTextLayerToolbar?.(layer.id, newOverlay));
        }
      }
      didDrag = false;
    });

    parentEl.appendChild(overlay);
    requestAnimationFrame(() => clipToCanvas(textDiv, parentEl));
  });
}
