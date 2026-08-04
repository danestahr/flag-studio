import { HS, UI, alignBtns, eyedropperBtn, fontSelect, mergeBanner, getEffectiveState, syncAlignBtns } from './state.js';
import { textLayerSource } from './text-layers.js';
import { cloneTemplateLogos, loadCustomTemplates, menuRow } from './design.js';
import { saveDraftInternal } from './export.js';
import { renderBannerSection } from './banner.js';
import { closeTlSlotToolbar, renderTemplateLogoControls, renderTplSlotBody } from './template-logos.js';
import { cropSvgToArtwork } from './logo-utils.js';
import { HS_DEFAULT_TEMPLATES, HS_TEMPLATES, migrateBannerCaptions } from '../hole-sign-data.js';
import { escXml } from '../hole-sign-render.js';
import { renderVarList, renderVarTmplRow } from './variations.js';
import { renderVariationPreview } from './var-canvas.js';
import { uploadLogo } from '../supabase.js';

// ── Per-variation editor ───────────────────────────────────

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
    textLayers: (v.textLayers !== undefined ? v.textLayers : (HS.textLayers || [])).map(l => ({ ...l })),
  };
  (HS.editingDraft.templateLogos.slots || []).forEach(s => {
    if (s && s.logoSrc && s.logoArtworkBounds) {
      cropSvgToArtwork(s.logoSrc, s.logoArtworkBounds).then(t => {
        if (t) { s.logoSrcTight = t.url; s.logoAspect = t.aspect; renderVariationPreview(); }
      }).catch(() => {});
    }
  });
  UI.tlSelectedIdxs.clear();
  UI.hsVarMenu = null;
  UI.hsVarMenuAnimate = false;
  closeTlSidePanel();
  closeTlSlotToolbar();
  renderEditor();
  renderVariationPreview();
};

window.cancelEditVar = function () {
  HS.editingVarId = null;
  HS.editingDraft = null;
  UI.tlSelectedIdxs.clear();
  closeTlSidePanel();
  closeTlSlotToolbar();
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
};

window.applyEditVar = function () {
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!v || !HS.editingDraft) return;
  const d = HS.editingDraft;

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

  // Text layers override — only store if they differ from the global
  if (JSON.stringify(d.textLayers) !== JSON.stringify(HS.textLayers)) {
    v.textLayers = d.textLayers.map(l => ({ ...l }));
  } else {
    delete v.textLayers;
  }

  HS.editingVarId = null;
  HS.editingDraft = null;
  UI.tlSelectedIdxs.clear();
  closeTlSidePanel();
  closeTlSlotToolbar();
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
  saveDraftInternal().catch(() => {});
};

window.revertVarOverrides = function () {
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!v) return;
  delete v.template;
  delete v.templateId;
  delete v.sponsorText;
  delete v.textLayers;
  HS.editingVarId = null;
  HS.editingDraft = null;
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
  saveDraftInternal().catch(() => {});
};

// Replaces the editing draft's docked banner-caption layers (dropping the
// ones that belonged to whatever template it had before) with fresh clones of
// `sourceLayers` — either the project default's own docked layers (reverting
// to project default) or a template's seed specs / migrated legacy captions
// (picking a template). Mirrors design.js's applyDefaultTemplate/
// applyCustomTemplate, scoped to HS.editingDraft instead of the global state.
function reseedDraftDockedLayers(sourceLayers) {
  const draft = HS.editingDraft;
  draft.textLayers = (draft.textLayers || []).filter(l => !l.dock);
  sourceLayers.forEach(spec => {
    draft.textLayers.push({ ...spec, id: 'tl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) });
  });
}

// A template's banner caption specs — either its own `bannerTopTextLayers`/
// `bannerBottomTextLayers` seed arrays (new-shape templates) or migrated from
// a legacy `bannerTop.topText`/`subText` pair (older "My templates" entries).
function bannerDockSpecsFor(tmpl) {
  const top = Array.isArray(tmpl.bannerTopTextLayers) ? tmpl.bannerTopTextLayers : migrateBannerCaptions(tmpl.bannerTop, 'top');
  const bottom = Array.isArray(tmpl.bannerBottomTextLayers) ? tmpl.bannerBottomTextLayers : migrateBannerCaptions(tmpl.bannerBottom, 'bottom');
  return [...top, ...bottom];
}

window.setDraftTmpl = function (key) {
  if (!HS.editingDraft) return;
  if (key === '__default__') {
    HS.editingDraft.templateStyle = HS.templateStyle;
    HS.editingDraft.background    = { ...HS.background };
    HS.editingDraft.topText       = { ...HS.topText };
    HS.editingDraft.bottomText    = { ...HS.bottomText };
    HS.editingDraft.bannerTop     = mergeBanner(HS.bannerTop);
    HS.editingDraft.bannerBottom  = mergeBanner(HS.bannerBottom);
    reseedDraftDockedLayers((HS.textLayers || []).filter(l => l.dock).map(l => ({ ...l })));
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
    reseedDraftDockedLayers(bannerDockSpecsFor(tmpl));
    HS.editingDraft.templateLogos = cloneTemplateLogos(tmpl.templateLogos);
  } else if (key.startsWith('default:')) {
    const tmpl = HS_DEFAULT_TEMPLATES.find(t => t.id === key.slice(8));
    if (!tmpl) return;
    HS.editingDraft.templateStyle = tmpl.templateStyle;
    HS.editingDraft.background    = { ...tmpl.background };
    HS.editingDraft.topText       = { ...tmpl.topText };
    HS.editingDraft.bottomText    = { ...tmpl.bottomText };
    HS.editingDraft.bannerTop     = mergeBanner(tmpl.bannerTop);
    HS.editingDraft.bannerBottom  = mergeBanner(tmpl.bannerBottom);
    reseedDraftDockedLayers(bannerDockSpecsFor(tmpl));
    HS.editingDraft.templateLogos = cloneTemplateLogos(tmpl.templateLogos);
  } else {
    HS.editingDraft.templateStyle = key;
  }
  UI.tlSelectedIdxs.clear();
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

window.handleDraftBgImageUpload = async function (e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !HS.projectId || !HS.editingDraft) return;
  try {
    const logo = await uploadLogo(HS.projectId, file);
    HS.editingDraft.background = { ...HS.editingDraft.background, imageUrl: logo.src, storagePath: logo.storagePath };
    renderEditor();
    renderVariationPreview();
  } catch (err) {
    console.error('Background image upload failed', err);
  }
};

window.removeDraftBgImage = function () {
  if (!HS.editingDraft) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, imageUrl: null, storagePath: null };
  renderEditor();
  renderVariationPreview();
};

window.setDraftBgImgOpacity = function (val) {
  if (!HS.editingDraft) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, imageOpacity: parseInt(val, 10) };
  const lbl = document.getElementById('hsDraftBgImgOpLbl');
  if (lbl) lbl.textContent = val + '%';
  renderVariationPreview();
};

window.setDraftBgImgGreyscale = function (on) {
  if (!HS.editingDraft) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, imageGreyscale: !!on };
  renderVariationPreview();
};

window.setDraftBgOverlayColor = function (val) {
  if (!HS.editingDraft) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, overlayColor: val };
  const hex = document.getElementById('hsDraftBgOvColorSwatch');
  if (hex) hex.nextElementSibling.value = val;
  renderVariationPreview();
};

window.setDraftBgOverlayColorHex = function (val) {
  if (!HS.editingDraft) return;
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, overlayColor: c };
  const swatch = document.getElementById('hsDraftBgOvColorSwatch');
  if (swatch) swatch.value = c;
  renderVariationPreview();
};

window.setDraftBgOverlayOpacity = function (val) {
  if (!HS.editingDraft) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, overlayOpacity: parseInt(val, 10) };
  const lbl = document.getElementById('hsDraftBgOvOpLbl');
  if (lbl) lbl.textContent = val + '%';
  renderVariationPreview();
};

window.setDraftBgOverlayBlend = function (val) {
  if (!HS.editingDraft) return;
  HS.editingDraft.background = { ...HS.editingDraft.background, overlayBlend: val };
  renderVariationPreview();
};

window.setDraftBgOverlayEnabled = function (on) {
  if (!HS.editingDraft) return;
  const overlayOpacity = (on && !(HS.editingDraft.background.overlayOpacity > 0)) ? 50 : HS.editingDraft.background.overlayOpacity;
  HS.editingDraft.background = { ...HS.editingDraft.background, overlayEnabled: !!on, overlayOpacity };
  renderEditor();
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
  renderVariationPreview();
  if (key === 'align') syncAlignBtns(val);
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
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="hsDraft${which}Swatch" value="${st.color}"
          oninput="setDraftText('${which}','color',this.value)">
        <input type="text" class="hexin" id="hsDraft${which}Hex" style="flex:1" maxlength="7" value="${st.color}"
          oninput="setDraftTextColorHex('${which}',this.value)">
        ${eyedropperBtn('hsDraft' + which + 'Swatch')}
      </div>
    </div>`;
}

const HS_VAR_MENU_TITLES = {
  template: 'Template', background: 'Background',
  bannerTop: 'Top banner', bannerBottom: 'Bottom banner',
  top: 'Top text', bottom: 'Bottom text', logos: 'Template logos', sponsor: 'Sponsor text',
  tplSlot: 'Logo options', textLayers: 'Text layers',
};

export function buildVarTemplateSection(d, customs) {
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">Template</div>
      <select class="hs-editor-select" onchange="setDraftTmpl(this.value)">
        <optgroup label="Layouts">
          ${HS_TEMPLATES.map(t => `<option value="${t.id}"${d.templateStyle === t.id ? ' selected' : ''}>${escXml(t.name)}</option>`).join('')}
        </optgroup>
        <optgroup label="Default templates">
          ${HS_DEFAULT_TEMPLATES.map(t => `<option value="default:${t.id}">${escXml(t.name)}</option>`).join('')}
        </optgroup>
        ${customs.length ? `<optgroup label="My templates">
          ${customs.map(t => `<option value="custom:${t.id}">${escXml(t.name)}</option>`).join('')}
        </optgroup>` : ''}
      </select>
      <button class="hs-editor-link" onclick="setDraftTmpl('__default__')"><i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i> Revert to project default</button>
    </div>`;
}

export function buildVarBackgroundSection(d) {
  const bg = d.background;
  let bgControls;
  if (bg.type === 'color') {
    bgControls = `
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <input type="color" class="hs-color-swatch" id="hsDraftBgSwatch" value="${bg.color}"
          oninput="setDraftBgColor(this.value)">
        <input type="text" class="hexin" id="hsDraftBgHex" style="flex:1" maxlength="7" value="${bg.color}"
          oninput="setDraftBgColorHex(this.value)">
        ${eyedropperBtn('hsDraftBgSwatch')}
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
        <button class="btn sm" onclick="removeDraftBgImage()">Remove image</button>
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Opacity</div>
        <div class="tl-size-slider">
          <input type="range" min="0" max="100" value="${imgOp}" oninput="setDraftBgImgOpacity(this.value)">
          <span class="tl-size-value" id="hsDraftBgImgOpLbl">${imgOp}%</span>
        </div>
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Greyscale</div>
        <label class="tl-switch"><input type="checkbox"${bg.imageGreyscale ? ' checked' : ''} onchange="setDraftBgImgGreyscale(this.checked)"><span class="tl-switch-slider"></span></label>
      </div>
      <div class="tl-row" style="margin-top:10px">
        <div class="tl-row-label" style="font-size:12px;font-weight:600;color:var(--black)">Color overlay</div>
        <label class="tl-switch"><input type="checkbox"${overlayOn ? ' checked' : ''} onchange="setDraftBgOverlayEnabled(this.checked)"><span class="tl-switch-slider"></span></label>
      </div>
      ${overlayOn ? `
      <div class="color-row" style="margin-top:6px">
        <input type="color" class="hs-color-swatch" id="hsDraftBgOvColorSwatch" value="${overlayColor}" oninput="setDraftBgOverlayColor(this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${overlayColor}" oninput="setDraftBgOverlayColorHex(this.value)">
        ${eyedropperBtn('hsDraftBgOvColorSwatch')}
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Amount</div>
        <div class="tl-size-slider">
          <input type="range" min="0" max="100" value="${overlayOp}" oninput="setDraftBgOverlayOpacity(this.value)">
          <span class="tl-size-value" id="hsDraftBgOvOpLbl">${overlayOp}%</span>
        </div>
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Blend</div>
        <select class="hs-editor-select" style="flex:1" onchange="setDraftBgOverlayBlend(this.value)">
          ${blendModes.map(m => `<option value="${m}"${(bg.overlayBlend || 'normal') === m ? ' selected' : ''}>${m.charAt(0).toUpperCase() + m.slice(1).replace(/-/g,' ')}</option>`).join('')}
        </select>
      </div>` : ''}`;
  } else {
    bgControls = `
      <div style="margin-top:4px">
        <button class="btn sm" onclick="document.getElementById('hsDraftBgFile').click()">Upload image</button>
        <input type="file" id="hsDraftBgFile" accept="image/*" style="display:none" onchange="handleDraftBgImageUpload(event)">
      </div>`;
  }
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">Background</div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${bg.type === 'color' ? ' active' : ''}" onclick="setDraftBgType('color')">Color</button>
        <button class="hs-tog-btn${bg.type === 'image' ? ' active' : ''}" onclick="setDraftBgType('image')">Image</button>
      </div>
      ${bgControls}
    </div>`;
}

window.openHsVarMenu = function (key) { UI.hsVarMenu = key; UI.hsVarMenuAnimate = true; renderEditor(); };
window.closeHsVarMenu = function ()  { UI.hsVarMenu = null; UI.hsVarMenuAnimate = true; renderEditor(); };

// Bridge for template-logos.js to refresh the tplSlot section in the var editor
// without a circular import.
window._refreshVarTplSlot = function () {
  if (UI.hsVarMenu === 'tplSlot') renderEditor();
};

export function renderEditor() {
  const list = document.getElementById('hsVarList');
  if (!list) return;
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!v || !HS.editingDraft) { renderVarList(); return; }

  const d = HS.editingDraft;
  const customs = loadCustomTemplates();
  const activeTmpl = HS_TEMPLATES.find(t => t.id === d.templateStyle) || HS_TEMPLATES[0];
  const isCustomized = !!(v.template || v.sponsorText);

  if ((UI.hsVarMenu === 'top' || UI.hsVarMenu === 'bottom') && !activeTmpl.supportsText) UI.hsVarMenu = null;
  if (UI.hsVarMenu === 'banner') UI.hsVarMenu = 'bannerTop';

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
      rows.push(menuRow('top',    'Top text',    d.topText.text    ? escXml(d.topText.text)    : 'Empty', 'openHsVarMenu'));
      rows.push(menuRow('bottom', 'Bottom text', d.bottomText.text ? escXml(d.bottomText.text) : 'Empty', 'openHsVarMenu'));
    }
    {
      const c = d.templateLogos?.count ?? 0;
      rows.push(menuRow('logos', 'Template logos', c ? `${c} logo${c > 1 ? 's' : ''}` : 'Off', 'openHsVarMenu'));
    }
    rows.push(menuRow('sponsor', 'Sponsor text', d.sponsorText?.text ? escXml(d.sponsorText.text) : 'Empty', 'openHsVarMenu'));
    const tlCount = (d.textLayers || HS.textLayers || []).length;
    rows.push(menuRow('textLayers', 'Text layers', tlCount ? `${tlCount} layer${tlCount !== 1 ? 's' : ''}` : 'None', 'openHsVarMenu'));
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
    else if (UI.hsVarMenu === 'tplSlot')   section = `<div class="hs-section">${renderTplSlotBody(UI.hsVarMenuSlotIdx ?? 0)}</div>`;
    else if (UI.hsVarMenu === 'sponsor')    section = renderDraftTextControls('sponsor', 'Sponsor text', true)
      + '<div style="font-size:11px;color:var(--gray-400);margin-top:-8px;margin-bottom:8px;padding:0 2px">Displayed in the logo zone when no logo is set for this variation.</div>';
    else if (UI.hsVarMenu === 'textLayers') section = `
      <div class="hs-editor-section">
        <div class="hs-editor-label">Free text layers</div>
        <div style="font-size:12px;color:var(--gray-500);margin-bottom:8px">Text layers float freely on the canvas. Click a layer in the preview to select, drag to move, double-click to edit.</div>
        <button class="btn sm" onclick="addTextLayer()">+ Add text layer</button>
      </div>`;
    const backFn = UI.hsVarMenu === 'tplSlot' ? "openHsVarMenu('logos')" : 'closeHsVarMenu()';
    body = `
      <div class="hs-menu-section-header">
        <button class="hs-menu-back" onclick="${backFn}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back</button>
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
        <button class="vbtn" title="Cancel" aria-label="Cancel" onclick="cancelEditVar()"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
      <div class="hs-editor-body${animClass}">${body}</div>
    </div>`;
}
