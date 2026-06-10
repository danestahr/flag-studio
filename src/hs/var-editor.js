import { HS, UI, alignBtns, fontSelect, mergeBanner, getEffectiveState } from './state.js';
import { cloneTemplateLogos, loadCustomTemplates, menuRow } from './design.js';
import { renderBannerSection } from './banner.js';
import { closeTlSlotToolbar, renderTemplateLogoControls } from './template-logos.js';
import { cropSvgToArtwork } from './logo-utils.js';
import { HS_TEMPLATES } from '../hole-sign-data.js';
import { escXml } from '../hole-sign-render.js';
import { renderVarList, renderVarTmplRow } from './variations.js';
import { renderVariationPreview } from './var-canvas.js';

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
  };
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
window.closeHsVarMenu = function ()  { UI.hsVarMenu = null; UI.hsVarMenuAnimate = true; renderEditor(); };

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

  if (UI.hsVarMenu === 'logos' && activeTmpl.id === 'hole-sign-logo-only') UI.hsVarMenu = null;
  if ((UI.hsVarMenu === 'top' || UI.hsVarMenu === 'bottom') && !activeTmpl.supportsText) UI.hsVarMenu = null;
  if (UI.hsVarMenu === 'banner') UI.hsVarMenu = 'bannerTop';
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
      rows.push(menuRow('top',    'Top text',    d.topText.text    ? escXml(d.topText.text)    : 'Empty', 'openHsVarMenu'));
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
