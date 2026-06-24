import { HS, UI, eyedropperBtn, mergeBanner, renderTextControls, syncAlignBtns } from './state.js';
import { goStep } from './app.js';
import { renderBannerSection, wireCanvasTextEditing, wireElementDrag, wireQuickAddHover } from './banner.js';
import { applyTlSlotImgStyle, openTlLibPicker, openTlSidePanel, redrawTplPreview, renderTemplateLogoControls, renderTplSlotBody, snapTlSlotsToDefaults, tlSource, wireTlSlotFreeDrag } from './template-logos.js';
import { applyHsStep1Zoom, wireCanvasZoom } from './var-canvas.js';
import { cropSvgToArtwork } from './logo-utils.js';
import { saveDraftInternal } from './export.js';
import { HS_H, HS_TEMPLATES, HS_W, emptyBanner, emptyTemplateLogos } from '../hole-sign-data.js';
import { escXml, getLogoZone, getTemplateLogoSlots, renderHoleSignInto } from '../hole-sign-render.js';
import { uploadLogo } from '../supabase.js';

export function buildBackgroundSection() {
  const bg = HS.background;
  let bgControls;
  if (bg.type === 'color') {
    bgControls = `
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="hsBgSwatch" value="${bg.color}"
          oninput="setBgColor(this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${bg.color}"
          oninput="setBgColorHex(this.value)" placeholder="#000000">
        ${eyedropperBtn('hsBgSwatch')}
      </div>`;
  } else if (bg.imageUrl) {
    const overlayColor = bg.overlayColor || '#000000';
    const overlayOp = bg.overlayOpacity ?? 50;
    const overlayOn = bg.overlayEnabled !== false;
    const imgOp = bg.imageOpacity ?? 100;
    const blendModes = ['normal','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','color','luminosity'];
    bgControls = `
      <div class="hs-bg-img-row" style="margin-top:4px">
        <img src="${bg.imageUrl}" style="width:60px;height:40px;object-fit:cover;border-radius:6px;border:1px solid var(--gray-100)">
        <button class="btn sm" onclick="removeBgImage()">Remove image</button>
      </div>
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
      </div>` : ''}`;
  } else {
    bgControls = `
      <div style="margin-top:4px">
        <button class="btn sm" onclick="document.getElementById('hsBgFile').click()">Upload image</button>
        <input type="file" id="hsBgFile" accept="image/*" style="display:none" onchange="handleBgImageUpload(event)">
      </div>`;
  }
  return `
    <div class="hs-section">
      <div class="hs-section-title">Background</div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${bg.type === 'color' ? ' active' : ''}" onclick="setBgType('color')">Color</button>
        <button class="hs-tog-btn${bg.type === 'image' ? ' active' : ''}" onclick="setBgType('image')">Image</button>
      </div>
      ${bgControls}
    </div>`;
}

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
      </div>
    </div>`;
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
              <button class="hs-tmpl-del" onclick="event.stopPropagation();deleteCustomTemplate('${t.id}')">×</button>
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
// `handler` is the global fn invoked with the section key on click.
export function menuRow(key, label, hint, handler = 'openHsMenu') {
  return `
    <button class="hs-menu-row" onclick="${handler}('${key}')">
      <span class="hs-menu-row-label">${label}</span>
      <span class="hs-menu-row-hint">${hint}</span>
      <span class="hs-menu-row-chev">›</span>
    </button>`;
}

export function renderDesignMenuList(activeTmpl) {
  const rows = [];
  rows.push(menuRow('template', 'Template', escXml(activeTmpl.name)));
  const customs = loadCustomTemplates();
  rows.push(menuRow('mytemplates', 'My templates', customs.length ? `${customs.length} saved` : 'None'));
  const bg = HS.background;
  const bgHint = bg.type === 'color'
    ? `<span class="hs-menu-swatch" style="background:${escXml(bg.color)}"></span>`
    : (bg.imageUrl ? 'Image' : 'No image');
  rows.push(menuRow('background', 'Background', bgHint));
  rows.push(menuRow('bannerTop',    'Top banner',    HS.bannerTop?.enabled    ? 'On' : 'Off'));
  rows.push(menuRow('bannerBottom', 'Bottom banner', HS.bannerBottom?.enabled ? 'On' : 'Off'));
  if (activeTmpl.supportsText) {
    rows.push(menuRow('top', 'Text', HS.topText.text ? escXml(HS.topText.text) : 'Empty'));
    rows.push(menuRow('bottom', 'Bottom text', HS.bottomText.text ? escXml(HS.bottomText.text) : 'Empty'));
  }
  if (activeTmpl.id !== 'hole-sign-logo-only') {
    const c = HS.templateLogos?.count ?? 0;
    rows.push(menuRow('logos', 'Template logos', c ? `${c} logo${c > 1 ? 's' : ''}` : 'Off'));
  }
  return `
    <div class="hs-menu-list">${rows.join('')}</div>
    <div class="arow" style="margin-top:1rem">
      <div></div>
      <button class="btn primary" onclick="goStep(2)">Next: Variations →</button>
    </div>`;
}

const HS_MENU_TITLES = {
  template: 'Template', mytemplates: 'My templates', background: 'Background',
  bannerTop: 'Top banner', bannerBottom: 'Bottom banner',
  top: 'Text', bottom: 'Bottom text', logos: 'Template logos', tplSlot: 'Logo options',
};

export function renderDesignSection(key) {
  let body = '';
  if (key === 'template')         body = buildTemplateSection();
  else if (key === 'mytemplates') body = buildMyTemplatesSection();
  else if (key === 'background')  body = buildBackgroundSection();
  else if (key === 'bannerTop')    body = renderBannerSection('top');
  else if (key === 'bannerBottom') body = renderBannerSection('bottom');
  else if (key === 'top')         body = renderTextControls('top', HS.topText);
  else if (key === 'bottom')      body = renderTextControls('bottom', HS.bottomText);
  else if (key === 'logos')       body = renderTemplateLogoControls();
  else if (key === 'tplSlot')     body = `<div class="hs-section">${renderTplSlotBody(UI.hsMenuSlotIdx ?? 0)}</div>`;
  const backFn = key === 'tplSlot' ? "openHsMenu('logos')" : 'closeHsMenu(true)';
  return `
    <div class="hs-menu-section-header">
      <button class="hs-menu-back" onclick="${backFn}">← Back</button>
      <span class="hs-menu-section-title">${HS_MENU_TITLES[key] || ''}</span>
    </div>
    ${body}`;
}

// Bridge for template-logos.js to refresh the tplSlot section without a circular import.
window._refreshDesignTplSlot = function () {
  const controls = document.querySelector('#panel-1 .hs-design-controls');
  if (controls && UI.hsMenu === 'tplSlot') controls.innerHTML = renderDesignSection('tplSlot');
};

window.openHsMenu = function (key) { UI.hsMenu = key; UI.hsMenuAnimate = true; renderStep1(); };

// Update only the right controls panel without touching the canvas — used when
// the user clicks a canvas element so the relevant section auto-opens in place.
window.openHsMenuSection = function (key) {
  if (HS.editingVarId) return;
  const controls = document.querySelector('#panel-1 .hs-design-controls');
  if (!controls || UI.hsMenu === key) return;
  UI.hsMenu = key;
  controls.innerHTML = renderDesignSection(key);
  controls.classList.remove('hs-controls-enter');
  void controls.offsetWidth;
  controls.classList.add('hs-controls-enter');
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
  if (UI.hsOnboarding) {
    const defaultState = { ...HS_BUILTIN_DEFAULTS, templateLogos: emptyTemplateLogos() };
    panel.innerHTML = `
      <div class="hs-ob-wrap">
        <div class="hs-ob-header">
          <div class="ptitle">Choose a template</div>
          <div class="psub">Pick a starting point — you can customise everything on the next screen.</div>
        </div>
        <div class="hs-ob-grid">
          ${HS_TEMPLATES.map(t => `
            <div class="hs-ob-card" onclick="pickOnboardingTemplate('${t.id}')">
              <div class="hs-ob-thumb" id="hs-ob-${t.id}"></div>
              <div class="hs-ob-info">
                <div class="hs-ob-name">${t.name}</div>
                <div class="hs-ob-desc">${t.description}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
    HS_TEMPLATES.forEach(t => {
      const el = document.getElementById('hs-ob-' + t.id);
      if (el) renderHoleSignInto(el, defaultState, { templateId: t.id });
    });
    return;
  }

  const activeTmpl = HS_TEMPLATES.find(t => t.id === HS.templateStyle) || HS_TEMPLATES[0];
  // A section may have become unavailable (e.g. logo-only template hides text).
  if (UI.hsMenu === 'logos' && activeTmpl.id === 'hole-sign-logo-only') UI.hsMenu = null;
  if ((UI.hsMenu === 'top' || UI.hsMenu === 'bottom') && !activeTmpl.supportsText) UI.hsMenu = null;
  if (UI.hsMenu === 'banner') UI.hsMenu = 'bannerTop'; // migrate stale key

  const controlsInner = UI.hsMenu === null ? renderDesignMenuList(activeTmpl) : renderDesignSection(UI.hsMenu);
  const animClass = UI.hsMenuAnimate ? ' hs-controls-enter' : '';
  UI.hsMenuAnimate = false;

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="ptitle">Design</div>
        <div class="psub">Choose a template, set the background, and configure text.</div>
      </div>
      <button class="btn sm" id="saveDraftBtn" onclick="saveDraft()">Save draft</button>
    </div>
    <div class="hs-design-layout">
      <div class="hs-design-preview-col">
        <div class="canvas-zoom-row">
          <span class="canvas-zoom-value" id="hsStep1ZoomValue">100%</span>
          <button class="canvas-zoom-reset" id="hsStep1ZoomReset" onclick="setHsStep1Zoom(100)" style="display:none">Reset</button>
          <span class="canvas-zoom-hint">⌘ + scroll to zoom</span>
        </div>
        <div class="canvas-scroll hs-step1-scroll" id="hsStep1Scroll">
          <div class="canvas-scroll-inner">
            <div class="hs-step1-zoom-wrap" id="hsStep1ZoomWrap">
              <div class="hs-sign-thumb" id="hsStep1Preview"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="hs-design-controls${animClass}">${controlsInner}</div>
    </div>`;

  window.goStep = goStep;

  applyHsStep1Zoom(UI.hsStep1Zoom);
  wireCanvasZoom('hsStep1Scroll', 'hsStep1ZoomWrap', () => UI.hsStep1Zoom, applyHsStep1Zoom);
  updateStep1Preview();
  // Built-in template thumbnails always show the pristine default state, so
  // the user sees exactly what they'll get when clicking the card (which
  // resets to defaults).
  const defaultState = { ...HS_BUILTIN_DEFAULTS, templateLogos: emptyTemplateLogos() };
  HS_TEMPLATES.forEach(t => {
    const el = document.getElementById('hs-tmpl-' + t.id);
    if (el) renderHoleSignInto(el, defaultState, { templateId: t.id });
  });
  loadCustomTemplates().forEach(t => {
    const el = document.getElementById('hs-ctmpl-' + t.id);
    if (el) renderHoleSignInto(el, t, { templateId: t.templateStyle });
  });
}

window.setHsTextProp = function (which, key, val) {
  const obj = which === 'top' ? HS.topText : HS.bottomText;
  const cap = which.charAt(0).toUpperCase() + which.slice(1);
  if (key === 'size') {
    obj.size = parseInt(val, 10);
    const lbl = document.getElementById('hs' + cap + 'SizeLabel');
    if (lbl) lbl.textContent = obj.size + 'pt';
  } else {
    obj[key] = val;
  }
  updateStep1Preview();
  // Directly update the active class on alignment toggle buttons so the visual
  // reflects the new value without a full controls re-render.
  if (key === 'align') syncAlignBtns(val);
};

window.setHsTextColorHex = function (which, val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (/^#[0-9A-Fa-f]{6}$/.test(c)) {
    const obj = which === 'top' ? HS.topText : HS.bottomText;
    obj.color = c;
    updateStep1Preview();
  }
};

window.setBgType = function (type) {
  HS.background.type = type;
  renderStep1();
};

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
const HS_BUILTIN_DEFAULTS = {
  background: { type: 'color', color: '#FFFFFF', imageUrl: null, storagePath: null },
  topText:    { text: 'Sponsored By', font: 'dm-serif', size: 300, color: '#111110' },
  bottomText: { text: '', font: 'dm-serif', size: 300, color: '#111110' },
};

export function applyBuiltInDefaults() {
  HS.background = { ...HS_BUILTIN_DEFAULTS.background };
  HS.topText    = { ...HS_BUILTIN_DEFAULTS.topText };
  HS.bottomText = { ...HS_BUILTIN_DEFAULTS.bottomText };
  HS.bannerTop    = emptyBanner();
  HS.bannerBottom = emptyBanner();
  HS.templateLogos = emptyTemplateLogos();
}

export function hasBuiltInTemplateChanges() {
  return JSON.stringify(HS.background) !== JSON.stringify(HS_BUILTIN_DEFAULTS.background)
      || JSON.stringify(HS.topText)    !== JSON.stringify(HS_BUILTIN_DEFAULTS.topText)
      || JSON.stringify(HS.bottomText) !== JSON.stringify(HS_BUILTIN_DEFAULTS.bottomText)
      || !!HS.bannerTop?.enabled
      || !!HS.bannerBottom?.enabled
      || (HS.templateLogos?.count ?? 0) !== 0;
}

window.pickOnboardingTemplate = function (templateId) {
  UI.hsOnboarding = false;
  HS.templateStyle = templateId;
  applyBuiltInDefaults();
  renderStep1();
};

window.setHsTemplate = function (templateId) {
  HS.templateStyle = templateId;
  applyBuiltInDefaults();
  renderStep1();
};

// ── Custom templates (localStorage) ───────────────────────
export function loadCustomTemplates() {
  try { return JSON.parse(localStorage.getItem('hs_custom_templates') || '[]'); }
  catch { return []; }
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

window.confirmSaveTemplate = function () {
  const name = document.getElementById('hsTmplNameInput')?.value.trim();
  if (!name) return;
  const list = loadCustomTemplates();
  list.push({
    id: crypto.randomUUID(),
    name,
    templateStyle: HS.templateStyle,
    background:    { ...HS.background },
    topText:       { ...HS.topText },
    bottomText:    { ...HS.bottomText },
    bannerTop:     mergeBanner(HS.bannerTop),
    bannerBottom:  mergeBanner(HS.bannerBottom),
    templateLogos: cloneTemplateLogos(HS.templateLogos),
  });
  saveCustomTemplates(list);
  renderStep1();
};

window.deleteCustomTemplate = function (id) {
  saveCustomTemplates(loadCustomTemplates().filter(t => t.id !== id));
  renderStep1();
};

window.applyCustomTemplate = function (id) {
  const tmpl = loadCustomTemplates().find(t => t.id === id);
  if (!tmpl) return;
  HS.templateStyle = tmpl.templateStyle;
  HS.background    = { ...tmpl.background };
  HS.topText       = { ...tmpl.topText };
  HS.bottomText    = { ...tmpl.bottomText };
  HS.bannerTop    = mergeBanner(tmpl.bannerTop    || (tmpl.banner?.position !== 'bottom' ? tmpl.banner : null));
  HS.bannerBottom = mergeBanner(tmpl.bannerBottom || (tmpl.banner?.position === 'bottom' ? tmpl.banner : null));
  HS.templateLogos = cloneTemplateLogos(tmpl.templateLogos);
  HS.templateLogos.slots.forEach(s => {
    if (s.logoSrc && s.logoArtworkBounds) {
      cropSvgToArtwork(s.logoSrc, s.logoArtworkBounds).then(t => {
        if (t) { s.logoSrcTight = t.url; s.logoAspect = t.aspect; updateStep1Preview(); }
      }).catch(() => {});
    }
  });
  renderStep1();
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
  const previewState = stripSlotImages(HS);
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
  wireCanvasTextEditing(el);
  // Show where each variation's logo will land, the same dashed placeholder used
  // on the Variations page, so the template preview reads as a full layout.
  const lz = getLogoZone(HS, HS.templateStyle);
  const pctP = (val, total) => (val / total * 100).toFixed(4) + '%';
  const ph = document.createElement('div');
  ph.className = 'dzone hs-logo-placeholder';
  ph.style.cssText = `left:${pctP(lz.x, HS_W)};top:${pctP(lz.y, HS_H)};width:${pctP(lz.w, HS_W)};height:${pctP(lz.h, HS_H)};pointer-events:none;`;
  ph.innerHTML = '<span class="hs-ph-label">Variation logo</span>';
  el.appendChild(ph);
  wireQuickAddHover(el);
  // Clicking the canvas background (not on an interactive element) closes the
  // current submenu and returns to the main menu list.
  el.addEventListener('click', e => {
    if (!UI.hsMenu) return;
    const onInteractive = e.target.closest('.canvas-edit-zone,.tl-slot,.band-drag,.dzone,.qa-bar');
    if (!onInteractive) window.closeHsMenu(true);
  }, { capture: false });
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
// show hover actions (Edit / Delete), a size badge, a resize handle, and
// support free-drag to reposition the entire slot box.
export function paintTplSlotOverlays(parentEl, state) {
  const tl = state.templateLogos;
  if (!tl || !tl.count) return;
  if (state.templateStyle === 'hole-sign-logo-only') return;
  const slots = getTemplateLogoSlots(state, state.templateStyle);
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  slots.forEach((rect, i) => {
    const slot = tl.slots[i];
    const overlay = document.createElement('div');
    overlay.className = 'tl-slot' + (slot?.logoSrc ? ' has-logo' : '') + (UI.tlSelectedIdx === i ? ' selected' : '');
    overlay.style.cssText = `position:absolute;left:${pct(rect.x, HS_W)};top:${pct(rect.y, HS_H)};width:${pct(rect.w, HS_W)};height:${pct(rect.h, HS_H)};`;
    overlay.dataset.idx = i;

    // Resize handle present on all slots so empty ones are also draggable.
    const handle = document.createElement('div');
    handle.className = 'tl-slot-handle';
    overlay.appendChild(handle);

    if (slot?.logoSrc) {
      if (slot.bg && slot.bg !== 'transparent') overlay.style.background = slot.bg;
      if (slot.border?.color && slot.ratio !== 'fit') overlay.style.border = `1.5px solid ${slot.border.color}`;
      const img = document.createElement('img');
      img.src = slot.logoSrcTight || slot.logoSrc;
      img.alt = '';
      img.draggable = false;
      img.className = 'tl-slot-img';
      applyTlSlotImgStyle(img, slot);
      overlay.appendChild(img);
      const gh = document.createElement('div'); gh.className = 'tl-snap-guide h'; overlay.appendChild(gh);
      const gv = document.createElement('div'); gv.className = 'tl-snap-guide v'; overlay.appendChild(gv);

      // Hover actions: Edit opens side panel; ✕ removes
      const actions = document.createElement('div');
      actions.className = 'tl-slot-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'tl-slot-act-btn';
      editBtn.textContent = 'Edit';
      const delBtn = document.createElement('button');
      delBtn.className = 'tl-slot-act-btn danger';
      delBtn.textContent = '✕';
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      overlay.appendChild(actions);
      editBtn.addEventListener('click', e => {
        e.stopPropagation();
        UI.tlSelectedIdx = i;
        if (HS.editingVarId) {
          UI.hsVarMenuSlotIdx = i;
          window.openHsVarMenu?.('tplSlot');
        } else {
          UI.hsMenuSlotIdx = i;
          window.openHsMenu?.('tplSlot');
        }
      });
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        window.removeTlSlot(i);
      });

      // Size badge — shows slot dimensions as % of sign
      const badge = document.createElement('div');
      badge.className = 'tl-slot-size-badge';
      badge.textContent = `${Math.round(rect.w / HS_W * 100)}% × ${Math.round(rect.h / HS_H * 100)}%`;
      overlay.appendChild(badge);
    } else {
      const ph = document.createElement('div');
      ph.className = 'tl-slot-placeholder';
      ph.innerHTML = '<span>+</span><span class="tl-slot-ph-label">Add logo</span>';
      overlay.appendChild(ph);
    }

    // Wire free drag/resize for all slots. onTap fires on pointerup with no drag.
    // Double-tap (≤350ms, same slot) opens the visual options menu level.
    // Single tap navigates to logos section and opens picker on empty slots.
    wireTlSlotFreeDrag(overlay, handle, i, rect, () => {
      const now = Date.now();
      const isDoubleTap = (now - (UI.tlLastTapMs || 0)) < 350 && UI.tlLastTapSlot === i;
      UI.tlLastTapMs = now;
      UI.tlLastTapSlot = i;
      const cur = tlSource().slots[i];
      if (isDoubleTap && cur?.logoSrc) {
        UI.tlSelectedIdx = i;
        if (HS.editingVarId) {
          UI.hsVarMenuSlotIdx = i;
          window.openHsVarMenu?.('tplSlot');
        } else {
          UI.hsMenuSlotIdx = i;
          window.openHsMenu?.('tplSlot');
        }
      } else {
        if (!HS.editingVarId) window.openHsMenuSection?.('logos');
        if (!cur?.logoSrc) openTlLibPicker(i, overlay);
      }
    });

    parentEl.appendChild(overlay);
  });
}
