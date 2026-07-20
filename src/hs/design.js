import { HS, UI, eyedropperBtn, mergeBanner } from './state.js';
import './text-layers.js';
import { goStep } from './app.js';
import { renderBannerSection, wireBannerHeightHandles, wireBannerSpacingHandles, wireCanvasTextEditing, wireElementDrag, wireQuickAddHover } from './banner.js';
import { applyTlSlotImgStyle, openTlLibPicker, openTlSidePanel, redrawTplPreview, renderTemplateLogoControls, renderTplSlotBody, snapTlSlotsToDefaults, tlSource, wireTlSlotFreeDrag } from './template-logos.js';
import { applyHsStep1Zoom, initHsStep1Canvas } from './var-canvas.js';
import { cropSvgToArtwork } from './logo-utils.js';
import { saveDraftInternal } from './export.js';
import { HS_DEFAULT_TEMPLATES, HS_FONTS, HS_H, HS_TEMPLATES, HS_W, emptyBanner, emptyTemplateLogos } from '../hole-sign-data.js';
import { escXml, getBannerRect, getLogoZone, getTemplateLogoSlots, renderHoleSignInto } from '../hole-sign-render.js';
import { wrapText } from '../text-utils.js';
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
// `handler` is the global fn invoked with the section key on click.
export function menuRow(key, label, hint, handler = 'openHsMenu') {
  return `
    <button class="hs-menu-row" onclick="${handler}('${key}')">
      <span class="hs-menu-row-label">${label}</span>
      <span class="hs-menu-row-hint">${hint}</span>
      <span class="hs-menu-row-chev"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span>
    </button>`;
}

export function renderDesignMenuList(activeTmpl) {
  const rows = [];
  rows.push(menuRow('template', 'Template', escXml(activeTmpl.name)));
  const bg = HS.background;
  const bgHint = bg.type === 'color'
    ? `<span class="hs-menu-swatch" style="background:${escXml(bg.color)}"></span>`
    : (bg.imageUrl ? 'Image' : 'No image');
  rows.push(menuRow('background', 'Background', bgHint));
  rows.push(menuRow('bannerTop',    'Top banner',    HS.bannerTop?.enabled    ? 'On' : 'Off'));
  rows.push(menuRow('bannerBottom', 'Bottom banner', HS.bannerBottom?.enabled ? 'On' : 'Off'));
  if (activeTmpl.id !== 'hole-sign-logo-only') {
    const c = HS.templateLogos?.count ?? 0;
    rows.push(menuRow('logos', 'Template logos', c ? `${c} logo${c > 1 ? 's' : ''}` : 'Off'));
  }
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
    <div class="p1-header">
      <div>
        <div class="ptitle">Design</div>
        <div class="psub">Choose a template, set the background, and configure text.</div>
      </div>
      <div class="p1-header-actions">
        <button class="btn primary" onclick="goStep(2)">Next: Variations <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        <button class="btn sm save-draft-btn" id="saveDraftBtn" onclick="saveDraft()" style="display:none">Save draft</button>
      </div>
    </div>
    <div class="hs-design-layout">
      <div class="hs-design-preview-col">
        <div class="var-canvas-panel" id="hsStep1CanvasPanel"></div>
      </div>
      <div class="hs-design-controls${animClass}">${controlsInner}</div>
    </div>`;

  window.goStep = goStep;

  initHsStep1Canvas(document.getElementById('hsStep1CanvasPanel'));
  applyHsStep1Zoom(UI.hsStep1Zoom);
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
  HS_DEFAULT_TEMPLATES.forEach(t => {
    const el = document.getElementById('hs-dtmpl-' + t.id);
    if (el) renderHoleSignInto(el, t, { templateId: t.templateStyle });
  });
}

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

// Swapping templates changes *structure* (background, banners, logo layout)
// — the user's own caption text shouldn't have to be retyped just because
// the surrounding template changed. Capture it beforehand (falling back to
// whichever slot — plain text band vs. banner — currently holds it, since
// different templates put the same caption in different places)...
function captureUserCaptions() {
  return {
    primary:      HS.topText?.text?.trim()           || HS.bannerTop?.topText?.text?.trim()    || '',
    primarySub:   HS.bannerTop?.subText?.text?.trim() || '',
    secondary:    HS.bottomText?.text?.trim()          || HS.bannerBottom?.topText?.text?.trim() || '',
    secondarySub: HS.bannerBottom?.subText?.text?.trim() || '',
  };
}

// ...then re-apply it into whichever slot the *new* template structure
// actually uses. Only overwrites when the user had actually typed something
// — an untouched template's own placeholder/blank text is left alone, so a
// pristine template swap still looks like that template, not a mash-up.
function restoreUserCaptions(prev) {
  if (prev.primary) {
    if (HS.bannerTop?.enabled) HS.bannerTop.topText.text = prev.primary;
    else HS.topText.text = prev.primary;
  }
  if (prev.primarySub && HS.bannerTop?.enabled) HS.bannerTop.subText.text = prev.primarySub;
  if (prev.secondary) {
    if (HS.bannerBottom?.enabled) HS.bannerBottom.topText.text = prev.secondary;
    else HS.bottomText.text = prev.secondary;
  }
  if (prev.secondarySub && HS.bannerBottom?.enabled) HS.bannerBottom.subText.text = prev.secondarySub;
}

window.pickOnboardingTemplate = function (templateId) {
  UI.hsOnboarding = false;
  HS.templateStyle = templateId;
  applyBuiltInDefaults();
  renderStep1();
};

window.setHsTemplate = function (templateId) {
  const prev = captureUserCaptions();
  HS.templateStyle = templateId;
  applyBuiltInDefaults();
  restoreUserCaptions(prev);
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
  const prev = captureUserCaptions();
  HS.templateStyle = tmpl.templateStyle;
  HS.background    = { ...tmpl.background };
  HS.topText       = { ...tmpl.topText };
  HS.bottomText    = { ...tmpl.bottomText };
  HS.bannerTop    = mergeBanner(tmpl.bannerTop    || (tmpl.banner?.position !== 'bottom' ? tmpl.banner : null));
  HS.bannerBottom = mergeBanner(tmpl.bannerBottom || (tmpl.banner?.position === 'bottom' ? tmpl.banner : null));
  HS.templateLogos = cloneTemplateLogos(tmpl.templateLogos);
  restoreUserCaptions(prev);
  HS.templateLogos.slots.forEach(s => {
    if (s.logoSrc && s.logoArtworkBounds) {
      cropSvgToArtwork(s.logoSrc, s.logoArtworkBounds).then(t => {
        if (t) { s.logoSrcTight = t.url; s.logoAspect = t.aspect; updateStep1Preview(); }
      }).catch(() => {});
    }
  });
  renderStep1();
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
  HS.templateLogos = cloneTemplateLogos(tmpl.templateLogos);
  restoreUserCaptions(prev);
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
  wireQuickAddHover(el);
  // Clicking the canvas background (not on an interactive element) closes the
  // current submenu and returns to the main menu list.
  el.addEventListener('click', e => {
    if (!UI.hsMenu) return;
    const onInteractive = e.target.closest('.canvas-edit-zone,.tl-slot,.band-drag,.dzone,.qa-bar,.hs-tl-overlay,.hs-banner-height-handle,.hs-banner-spacing-handle');
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
      delBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
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
      ph.innerHTML = '<span><i class="fa-solid fa-plus" aria-hidden="true"></i></span><span class="tl-slot-ph-label">Add logo</span>';
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

function repositionToolbar(anchorEl, toolbarId = 'hsTlToolbar') {
  const tb = document.getElementById(toolbarId);
  if (!tb) return;
  const r = anchorEl.getBoundingClientRect();
  const tw = tb.offsetWidth || 380;
  const th = tb.offsetHeight || 44;
  const gap = 8;
  const top = r.top >= th + gap * 2 ? r.top - th - gap : r.bottom + gap;
  tb.style.top  = Math.max(gap, Math.min(window.innerHeight - th - gap, top)) + 'px';
  tb.style.left = Math.max(gap, Math.min(window.innerWidth  - tw - gap, r.left + r.width / 2 - tw / 2)) + 'px';
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

function snapNearest(val, snaps, threshold) {
  let best = val, bestDist = threshold;
  for (const s of snaps) {
    const d = Math.abs(val - s);
    if (d < bestDist) { best = s; bestDist = d; }
  }
  return best;
}

export function paintTextLayerOverlays(parentEl, state) {
  parentEl.querySelectorAll('.hs-tl-overlay').forEach(el => el.remove());
  const layers = state.textLayers || [];
  if (!layers.length) return;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  const { ySnaps, xSnaps } = getSnapTargets(state);

  layers.forEach(layer => {
    const sc = parentEl.offsetHeight / HS_H;
    const fontFamily = HS_FONTS.find(f => f.id === layer.font)?.family || "'DM Serif Display', serif";
    const fsPx = Math.max(8, Math.round(layer.size * sc));
    const isActive = UI.activeTextLayerId === layer.id;

    const overlay = document.createElement('div');
    overlay.className = 'hs-tl-overlay' + (isActive ? ' selected' : '');
    overlay.dataset.tlId = layer.id;
    // No fixed height — auto-sizes to text content. Wrapping + font-size changes
    // both flow into height naturally, giving real-time resize feedback.
    overlay.style.cssText = `position:absolute;left:${pct(layer.x, HS_W)};top:${pct(layer.y, HS_H)};width:${pct(layer.w, HS_W)};`;

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
    overlay.appendChild(textDiv);

    // ── Resize / scale handles ────────────────────────────────────────────────
    // All handles are always in the DOM; CSS controls opacity/pointer-events.

    // Left-edge handle — drags left edge, keeps right edge fixed
    const lh = document.createElement('div');
    lh.className = 'hs-tl-resize-l';
    let lhStartX, lhStartLayerX, lhStartW;
    lh.addEventListener('pointerdown', e => {
      e.stopPropagation();
      lh.setPointerCapture(e.pointerId);
      lhStartX = e.clientX; lhStartLayerX = layer.x; lhStartW = layer.w;
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    lh.addEventListener('pointermove', e => {
      if (!lh.hasPointerCapture(e.pointerId)) return;
      const sx = parentEl.offsetWidth / HS_W;
      const dx = (e.clientX - lhStartX) / sx;
      const rightEdge = lhStartLayerX + lhStartW;
      const newW = Math.max(layer.size, Math.round(lhStartW - dx));
      layer.x = rightEdge - newW; layer.w = newW;
      overlay.style.left  = pct(layer.x, HS_W);
      overlay.style.width = pct(newW, HS_W);
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
      rh.setPointerCapture(e.pointerId);
      rhStartX = e.clientX; rhStartW = layer.w;
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    rh.addEventListener('pointermove', e => {
      if (!rh.hasPointerCapture(e.pointerId)) return;
      const sx = parentEl.offsetWidth / HS_W;
      const newW = Math.max(layer.size, Math.round(rhStartW + (e.clientX - rhStartX) / sx));
      layer.w = newW;
      overlay.style.width = pct(newW, HS_W);
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
        chStartW = layer.w; chStartLayerX = layer.x;
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
        textDiv.style.fontSize = Math.max(8, Math.round(newSize * sc)) + 'px';

        // Scale the box's width along with the font size (same ratio), growing
        // outward from its center — otherwise the box lags behind and the text
        // just wraps onto more lines instead of visibly growing.
        const ratio = newSize / chStartSize;
        const newW = Math.max(newSize, Math.round(chStartW * ratio));
        layer.w = newW;
        layer.x = chStartLayerX + Math.round((chStartW - newW) / 2);
        overlay.style.width = pct(newW, HS_W);
        overlay.style.left  = pct(layer.x, HS_W);

        // Sync toolbar slider live
        const slider = document.getElementById('hsTlSizeSlider');
        const val    = document.getElementById('hsTlSizeVal');
        if (slider) slider.value = newSize;
        if (val) val.textContent = newSize;
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

    overlay.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.remove('selected'));
      overlay.classList.add('selected');
      UI.activeTextLayerId = layer.id;
      window.openTextLayerToolbar?.(layer.id, overlay);
    });

    overlay.addEventListener('dblclick', e => {
      e.stopPropagation();
      window.enterTextLayerEditMode?.(layer.id, overlay);
    });

    let startCX, startCY, startX, startY, didDrag = false;

    overlay.addEventListener('pointerdown', e => {
      if (e.target.closest('.hs-tl-editor-wrap, .hs-tl-resize-l, .hs-tl-resize-r, .hs-tl-resize-corner')) return;
      overlay.setPointerCapture(e.pointerId);
      startCX = e.clientX; startCY = e.clientY;
      startX = layer.x;    startY = layer.y;
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
      if (e.shiftKey) {
        nx = snapNearest(nx, xSnaps, 200);
        ny = snapNearest(ny, ySnaps, 200);
      }
      layer.x = nx; layer.y = ny;
      overlay.style.left = pct(nx, HS_W);
      overlay.style.top  = pct(ny, HS_H);
    });

    overlay.addEventListener('pointerup', () => {
      document.body.style.cursor = '';
      if (didDrag) {
        if (HS.editingVarId) window._hsRenderVariationPreview?.();
        else updateStep1Preview();
        if (UI.activeTextLayerId === layer.id) {
          const newOverlay = parentEl.querySelector(`.hs-tl-overlay[data-tl-id="${layer.id}"]`);
          if (newOverlay) requestAnimationFrame(() => window.openTextLayerToolbar?.(layer.id, newOverlay));
        }
      }
      didDrag = false;
    });

    parentEl.appendChild(overlay);
  });
}
