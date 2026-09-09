import { HS, UI, alignBtns, eyedropperBtn, fontSelect, mergeBanner, getEffectiveState, isVarCustomized, syncAlignBtns } from './state.js';
import { textLayerSource } from './text-layers.js';
import { addRow, cloneTemplateLogos, loadCustomTemplates, menuRow } from './design.js';
import { saveDraftInternal } from './draft.js';
import { renderBannerSection } from './banner.js';
import { closeTlSlotToolbar, renderTemplateLogoControls, renderTplSlotBody } from './template-logos.js';
import { cropSvgToArtwork } from './logo-utils.js';
import { HS_DEFAULT_TEMPLATES, HS_TEMPLATES, bannerDockSpecsFor } from '../hole-sign-data.js';
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

// Which draft fields each drilled-in section owns, and so which fields its
// own Save/Cancel/Reset act on. 'template' owns every field below because
// picking a template (setDraftTmpl) replaces all of them together — the
// section that triggers that bundle change commits/reverts it as one unit.
// Sections not listed here (logos/tplSlot/sponsor) have no per-section
// save/cancel of their own — their content only commits through the
// top-level Save, same as before this feature existed.
const HS_VAR_SECTION_FIELDS = {
  template: ['templateStyle', 'background', 'topText', 'bottomText', 'bannerTop', 'bannerBottom', 'templateLogos'],
  background: ['background'],
  bannerTop: ['bannerTop'],
  bannerBottom: ['bannerBottom'],
};

function fieldSnapshotEqual(field, a, b) {
  if (field === 'bannerTop' || field === 'bannerBottom') return JSON.stringify(mergeBanner(a)) === JSON.stringify(mergeBanner(b));
  if (field === 'templateLogos') return JSON.stringify(tlForCompare(a)) === JSON.stringify(tlForCompare(b));
  return JSON.stringify(a) === JSON.stringify(b);
}

// Deep-clones one field's value into a plain object this module owns —
// never the live object a setter (e.g. banner.js's `b.enabled = true`, which
// mutates bannerSource()'s returned object in place rather than replacing
// it) still holds a reference to. Anything read into a snapshot or into a
// "reset to default" without going through this would otherwise silently
// mutate alongside the very field it was meant to freeze.
function cloneFieldValue(field, value) {
  if (field === 'bannerTop' || field === 'bannerBottom') return mergeBanner(value);
  if (field === 'templateLogos') return cloneTemplateLogos(value);
  if (field === 'templateStyle') return value;
  return value ? { ...value } : value;
}

function draftFieldDefault(field) {
  const globalVal = field === 'templateStyle' ? HS.templateStyle : HS[field];
  return cloneFieldValue(field, globalVal);
}

// Whether any field this section owns currently differs from the project
// default in the live draft — drives both the section header's Reset button
// and (indirectly, via the same fields) whether Save would write anything.
function draftSectionCustomized(key) {
  const fields = HS_VAR_SECTION_FIELDS[key];
  if (!fields || !HS.editingDraft) return false;
  return fields.some(f => !fieldSnapshotEqual(f, HS.editingDraft[f], draftFieldDefault(f)));
}

// Merges one field's current draft value into v.template — preserving
// whatever other fields a previous section-level (or the top-level) Save
// already committed there, instead of replacing the whole object the way a
// single "apply everything at once" commit used to. Deletes the field's key
// (and v.template/v.templateId entirely, once empty) when the draft now
// matches the project default, so a field that's been reset doesn't linger
// as a no-op override.
function commitDraftField(v, field) {
  const d = HS.editingDraft;
  const draftVal = d[field];
  const tpl = v.template ? { ...v.template } : {};
  if (!fieldSnapshotEqual(field, draftVal, draftFieldDefault(field))) {
    tpl[field] = cloneFieldValue(field, draftVal);
  } else {
    delete tpl[field];
  }
  if (Object.keys(tpl).length === 0) {
    delete v.template;
    delete v.templateId;
  } else {
    v.template = tpl;
    v.templateId = tpl.templateStyle || d.templateStyle || HS.templateStyle;
  }
}

// Builds HS.editingDraft from a variation's current effective state (global
// template + this variation's own overrides flattened together) and points
// HS.editingVarId/activeVarId at it. Shared by the full pencil-edit flow
// (startEditVar, below) and the Variations-page "quick edit" click-to-edit
// affordances (beginQuickEdit, below) — the only difference between the two
// is whether the full side-panel editor is shown.
function seedEditingDraft(v) {
  HS.activeVarId = v.id;
  HS.editingVarId = v.id;
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
}

window.startEditVar = function (id) {
  const v = HS.variations.find(v => v.id === id);
  if (!v) return;
  seedEditingDraft(v);
  UI.hsFullEditorOpen = true;
  UI.tlSelectedIdxs.clear();
  UI.hsVarMenu = null;
  UI.hsVarMenuAnimate = false;
  closeTlSlotToolbar();
  renderEditor();
  renderVariationPreview();
};

// Silently begins (or continues) editing `v` without opening the full
// side-panel editor — used by the Variations-page quick-edit affordances
// (click a template logo slot / background / text band directly on the
// canvas) so a single click can write into this variation's draft, ready for
// applyEditVar() to persist, with no visible panel or Apply step.
export function beginQuickEdit(v) {
  if (HS.editingVarId === v.id && HS.editingDraft) return;
  seedEditingDraft(v);
}

window.cancelEditVar = function () {
  HS.editingVarId = null;
  HS.editingDraft = null;
  UI.hsFullEditorOpen = false;
  UI.tlSelectedIdxs.clear();
  UI.hsVarMenu = null;
  closeTlSlotToolbar();
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
};

window.applyEditVar = function () {
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!v || !HS.editingDraft) return;
  const d = HS.editingDraft;

  // Commits every template-shaped field via the same merge commitDraftField
  // uses for a single section's own Save — safe to re-run here even for
  // fields already committed by an earlier per-section Save (or reverted by
  // that section's own Cancel/Back): the draft's current value already
  // matches whatever's true, so recommitting it is a no-op.
  HS_VAR_SECTION_FIELDS.template.forEach(f => commitDraftField(v, f));

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
  UI.hsFullEditorOpen = false;
  UI.tlSelectedIdxs.clear();
  UI.hsVarMenu = null;
  closeTlSlotToolbar();
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
  saveDraftInternal().catch(() => {});
};

// Shared cleanup for the applyQuick* functions below — same as the tail of
// applyEditVar, minus the parts (tlSelectedIdxs/side-panel closes) that only
// matter for the full editor, which quick-edit never opens.
function finishQuickEdit() {
  HS.editingVarId = null;
  HS.editingDraft = null;
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
  saveDraftInternal().catch(() => {});
}

// The three functions below are the quick-edit counterparts to
// applyEditVar() — used when a canvas click (see beginQuickEdit callers in
// design.js/banner.js/var-canvas.js) only ever changed one piece of content,
// never position/layout. Unlike applyEditVar's tpl/textLayers snapshots
// (freeze the *entire* object the moment anything in it differs, position
// included — correct for the full editor, where dragging a slot is exactly
// the kind of intentional position customization that should stick), these
// write into a small per-field sparse map (v.templateLogoOverrides,
// v.backgroundOverride, v.textLayerOverrides) that getEffectiveState (see
// state.js) layers onto whatever templateLogos/background/textLayers
// resolves to — so a later reposition in the Design step still reaches a
// variation whose only customization was picking a different image or
// editing a line of text.

// Commits slot `idx`'s picked image/display settings — not its position —
// as a per-slot override.
export function applyQuickLogoSlot(idx) {
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  const slot = HS.editingDraft?.templateLogos?.slots?.[idx];
  if (v && slot) {
    const { freeX, freeY, freeW, freeH, ...content } = slot;
    v.templateLogoOverrides = v.templateLogoOverrides || {};
    v.templateLogoOverrides[idx] = content;
  }
  finishQuickEdit();
}

// Commits the picked background image — not the rest of the background
// (color, opacity, greyscale, overlay, image position/scale) — as an
// override.
// Commits one free text layer's edited text — not its position/size/font/
// color, and not any other layer — as a per-layer override.
export function applyQuickTextLayer(layerId) {
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  const layer = (HS.editingDraft?.textLayers || []).find(l => l.id === layerId);
  if (v && layer) {
    v.textLayerOverrides = v.textLayerOverrides || {};
    v.textLayerOverrides[layerId] = { text: layer.text };
  }
  finishQuickEdit();
}

window.revertVarOverrides = function () {
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!v) return;
  delete v.template;
  delete v.templateId;
  delete v.sponsorText;
  delete v.textLayers;
  delete v.templateLogoOverrides;
  delete v.backgroundOverride;
  delete v.textLayerOverrides;
  HS.editingVarId = null;
  HS.editingDraft = null;
  UI.hsFullEditorOpen = false;
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
  // Swapping templates replaces the whole templateLogos slot list, so a
  // currently-open per-slot panel would be showing a stale/mismatched slot —
  // back it out to the slot list level, same as removeTlSlot() does when the
  // slot it was showing disappears out from under it.
  if (UI.hsVarMenu === 'tplSlot') UI.hsVarMenu = 'logos';
  closeTlSlotToolbar();
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
  logos: 'Template logos', sponsor: 'Sponsor text', tplSlot: 'Logo options',
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
    </div>`;
}

// Color and image are independent layers, not exclusive alternatives — see
// the comment on buildBackgroundSection() in design.js.
export function buildVarBackgroundSection(d) {
  const bg = d.background;
  const color = bg.color || '#FFFFFF';
  const overlayColor = bg.overlayColor || '#000000';
  const overlayOp = bg.overlayOpacity ?? 50;
  const overlayOn = bg.overlayEnabled !== false;
  const imgOp = bg.imageOpacity ?? 100;
  const blendModes = ['normal','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','color','luminosity'];
  const imageControls = bg.imageUrl ? `
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
      </div>` : ''}` : `
      <div style="margin-top:4px">
        <button class="btn sm" onclick="document.getElementById('hsDraftBgFile').click()">Upload image</button>
        <input type="file" id="hsDraftBgFile" accept="image/*" style="display:none" onchange="handleDraftBgImageUpload(event)">
      </div>`;
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">Background</div>
      <div class="tl-row-label" style="font-size:12px;font-weight:600;color:var(--black)">Color</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <input type="color" class="hs-color-swatch" id="hsDraftBgSwatch" value="${color}"
          oninput="setDraftBgColor(this.value)">
        <input type="text" class="hexin" id="hsDraftBgHex" style="flex:1" maxlength="7" value="${color}"
          oninput="setDraftBgColorHex(this.value)">
        ${eyedropperBtn('hsDraftBgSwatch')}
      </div>
      <div class="tl-row-label" style="font-size:12px;font-weight:600;color:var(--black);margin-top:14px">Image</div>
      ${imageControls}
    </div>`;
}

function buildVarQtySection(v) {
  const qty = v.qty ?? 1;
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">Quantity</div>
      <div class="qty-stepper">
        <button class="qty-btn" type="button" onclick="setVarQtyDelta(-1)" aria-label="Decrease quantity"><i class="fa-solid fa-minus" aria-hidden="true"></i></button>
        <input class="var-qty-input" type="number" min="1" step="1" id="hsVarQtyInput" value="${qty}" onchange="setVarQty(this.value)">
        <button class="qty-btn" type="button" onclick="setVarQtyDelta(1)" aria-label="Increase quantity"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
      </div>
    </div>`;
}

function commitVarQty(next) {
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!v) return;
  v.qty = Math.max(1, next);
  const input = document.getElementById('hsVarQtyInput');
  if (input) input.value = v.qty;
  renderVarList();
  saveDraftInternal().catch(() => {});
}

window.setVarQtyDelta = function (delta) {
  const base = parseInt(document.getElementById('hsVarQtyInput')?.value, 10) || 1;
  commitVarQty(base + delta);
};

window.setVarQty = function (val) {
  commitVarQty(parseInt(val, 10) || 1);
};

window.openHsVarMenu = function (key) {
  const fields = HS_VAR_SECTION_FIELDS[key];
  UI.hsVarSectionSnapshot = (fields && HS.editingDraft)
    ? { key, values: Object.fromEntries(fields.map(f => [f, cloneFieldValue(f, HS.editingDraft[f])])) }
    : null;
  UI.hsVarMenu = key;
  UI.hsVarMenuAnimate = true;
  renderEditor();
};
window.closeHsVarMenu = function ()  { UI.hsVarMenu = null; UI.hsVarSectionSnapshot = null; UI.hsVarMenuAnimate = true; renderEditor(); };

// Commits this section's own fields into v.template (merging — see
// commitDraftField) and returns to the main menu list, without touching
// anything else the draft may be mid-editing in another section.
window.saveHsVarSection = function () {
  const key = UI.hsVarMenu;
  const fields = HS_VAR_SECTION_FIELDS[key];
  const v = HS.variations.find(v => v.id === HS.editingVarId);
  if (!fields || !v || !HS.editingDraft) return;
  fields.forEach(f => commitDraftField(v, f));
  UI.hsVarSectionSnapshot = null;
  UI.hsVarMenu = null;
  UI.hsVarMenuAnimate = true;
  renderEditor();
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
  saveDraftInternal().catch(() => {});
};

// Reverts this section's own fields to whatever they were the moment it was
// opened (see openHsVarMenu's snapshot), discarding only its own in-progress
// edits, then returns to the main menu list.
window.cancelHsVarSection = function () {
  const key = UI.hsVarMenu;
  const fields = HS_VAR_SECTION_FIELDS[key];
  const snap = UI.hsVarSectionSnapshot;
  if (fields && snap?.key === key && HS.editingDraft) {
    fields.forEach(f => { HS.editingDraft[f] = snap.values[f]; });
  }
  UI.hsVarSectionSnapshot = null;
  UI.hsVarMenu = null;
  UI.hsVarMenuAnimate = true;
  renderEditor();
  renderVariationPreview();
};

// Resets this section's own fields to the project default, live in the
// draft — stays in the section (unlike Save/Cancel) so the reset can still
// be tweaked further before deciding to Save or Cancel. 'template' resets
// via setDraftTmpl('__default__'), which already covers every field this
// section owns (and re-renders itself).
window.resetHsVarSectionField = function () {
  const key = UI.hsVarMenu;
  if (key === 'template') { window.setDraftTmpl('__default__'); return; }
  const fields = HS_VAR_SECTION_FIELDS[key];
  if (!fields || !HS.editingDraft) return;
  fields.forEach(f => { HS.editingDraft[f] = draftFieldDefault(f); });
  renderEditor();
  renderVariationPreview();
};

// Most in-section field setters (background color/opacity/overlay, banner
// style/position, etc. — in this file and banner.js) only call
// renderVariationPreview() after each edit, not the full renderEditor() —
// a full re-render would blow away focus/cursor position in whatever hex
// input or slider the user is mid-edit in. That leaves the section header's
// Reset link (only shown once the section differs from default) unable to
// react to those edits the normal way, so patch just that one button in
// place instead — called from renderVariationPreview() (var-canvas.js)
// itself, since virtually every such setter already calls that as its
// common refresh, giving this a free ride on all of them without touching
// each call site individually.
export function refreshHsVarSectionReset() {
  const key = UI.hsVarMenu;
  if (!HS_VAR_SECTION_FIELDS[key]) return;
  const titlerow = document.querySelector('#hsVarList .hs-menu-section-titlerow');
  if (!titlerow) return;
  const visible = draftSectionCustomized(key);
  let btn = titlerow.querySelector('.hs-editor-link');
  if (visible && !btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hs-editor-link';
    btn.textContent = 'Reset';
    btn.addEventListener('click', () => window.resetHsVarSectionField());
    titlerow.appendChild(btn);
  } else if (!visible && btn) {
    btn.remove();
  }
}

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
  const isCustomized = isVarCustomized(v);

  if (UI.hsVarMenu === 'banner') UI.hsVarMenu = 'bannerTop';

  let body;
  if (UI.hsVarMenu === null) {
    // Mirrors renderDesignMenuList() (design.js) exactly — same rows, same
    // order, same add-vs-drill-in split — so the per-variation editor feels
    // like the same tool as the Templates step. Content this editor used to
    // surface as its own sidebar rows (top/bottom text, sponsor text, the
    // template-logo group settings) is still fully editable, just via
    // clicking the element directly on canvas instead — see var-canvas.js's
    // wireCanvasTextEditing/paintTplSlotOverlays, which already run whenever
    // this editor is open.
    const rows = [];
    rows.push(menuRow('template', 'Template', escXml(activeTmpl.name), 'openHsVarMenu'));
    const bg = d.background;
    const bgHint = `<span class="hs-menu-swatch" style="background:${escXml(bg.color || '#FFFFFF')}"></span>${bg.imageUrl ? ' + Image' : ''}`;
    rows.push(menuRow('background', 'Background', bgHint, 'openHsVarMenu'));
    rows.push(d.bannerTop?.enabled
      ? menuRow('bannerTop', 'Top banner', 'On', 'openHsVarMenu', 'fa-window-maximize')
      : addRow('Top banner', "quickAdd('banner','top')", 'fa-window-maximize'));
    rows.push(d.bannerBottom?.enabled
      ? menuRow('bannerBottom', 'Bottom banner', 'On', 'openHsVarMenu', 'fa-window-maximize hs-icon-flip')
      : addRow('Bottom banner', "quickAdd('banner','bottom')", 'fa-window-maximize hs-icon-flip'));
    rows.push(addRow('Text', 'addTextLayer()', 'fa-font'));
    rows.push(addRow('Images', 'addTplImage()', 'fa-image'));
    body = `
      ${buildVarQtySection(v)}
      <div class="hs-menu-list">${rows.join('')}</div>
      <div class="var-editor-actions">
        <button class="btn primary" onclick="applyEditVar()">Save</button>
        <button class="btn" onclick="cancelEditVar()">Cancel</button>
      </div>`;
  } else {
    let section = '';
    if (UI.hsVarMenu === 'template')        section = buildVarTemplateSection(d, customs);
    else if (UI.hsVarMenu === 'background') section = buildVarBackgroundSection(d);
    else if (UI.hsVarMenu === 'bannerTop')    section = renderBannerSection('top');
    else if (UI.hsVarMenu === 'bannerBottom') section = renderBannerSection('bottom');
    else if (UI.hsVarMenu === 'logos')      section = renderTemplateLogoControls();
    else if (UI.hsVarMenu === 'tplSlot')   section = `<div class="hs-section">${renderTplSlotBody(UI.hsVarMenuSlotIdx ?? 0)}</div>`;
    else if (UI.hsVarMenu === 'sponsor')    section = renderDraftTextControls('sponsor', 'Sponsor text', true)
      + '<div style="font-size:11px;color:var(--gray-400);margin-top:-8px;margin-bottom:8px;padding:0 2px">Displayed in the logo zone when no logo is set for this variation.</div>';
    // Only Template/Background/Top banner/Bottom banner get their own
    // Save/Cancel/Reset (see HS_VAR_SECTION_FIELDS) — Back on those cancels
    // (reverts to the section's own entry snapshot) exactly like the button
    // does, so there's one consistent way to leave without saving. The other
    // sections (logos/tplSlot/sponsor) keep plain navigation: their content
    // only ever commits through the top-level Save.
    const hasSectionSaveCancel = !!HS_VAR_SECTION_FIELDS[UI.hsVarMenu];
    const backFn = UI.hsVarMenu === 'tplSlot' ? "openHsVarMenu('logos')"
      : hasSectionSaveCancel ? 'cancelHsVarSection()'
      : 'closeHsVarMenu()';
    const sectionResetVisible = hasSectionSaveCancel && draftSectionCustomized(UI.hsVarMenu);
    body = `
      <div class="hs-menu-section-header">
        <button class="hs-menu-back" onclick="${backFn}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back</button>
        <div class="hs-menu-section-titlerow">
          <span class="hs-menu-section-title">${HS_VAR_MENU_TITLES[UI.hsVarMenu] || ''}</span>
          ${sectionResetVisible ? '<button class="hs-editor-link" onclick="resetHsVarSectionField()">Reset</button>' : ''}
        </div>
      </div>
      ${section}
      ${hasSectionSaveCancel ? `
      <div class="var-editor-actions">
        <button class="btn primary" onclick="saveHsVarSection()">Save</button>
        <button class="btn" onclick="cancelHsVarSection()">Cancel</button>
      </div>` : ''}`;
  }

  const animClass = UI.hsVarMenuAnimate ? ' hs-controls-enter' : '';
  UI.hsVarMenuAnimate = false;

  list.innerHTML = `
    <div class="var-editor">
      <div class="var-editor-header">
        <div class="var-editor-title">Editing: ${escXml(v.name)}</div>
        <div class="var-editor-header-actions">
          ${isCustomized ? '<button class="hs-editor-link" onclick="revertVarOverrides()">Reset</button>' : ''}
          <button class="vbtn" title="Cancel" aria-label="Cancel" onclick="cancelEditVar()"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="hs-editor-body${animClass}">${body}</div>
    </div>`;
}
