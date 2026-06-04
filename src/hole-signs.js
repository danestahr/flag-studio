import './style.css';
import { PDFDocument, PDFName, PDFString, PDFOperator, rgb } from 'pdf-lib';
import JSZip from 'jszip';
import {
  loadLogosForProject, uploadLogo, deleteLogo,
  saveHoleSignConfig, loadHoleSignConfig,
  loadProject, updateProject, generateShareToken,
  loadOrderIntake, getFeedback, supabase,
} from './supabase.js';
import { HS_FONTS, HS_TEMPLATES, HS_W, HS_H, emptyTemplateLogos, normalizeTplLogoSize, HS_TPL_LOGO_MIN, HS_TPL_LOGO_MAX, emptyBanner, HS_BANNER_MIN_H, HS_BANNER_MAX_H } from './hole-sign-data.js';
import { makeHoleSignSvg, renderHoleSignInto, getLogoZone, getTemplateLogoSlots, getBannerRect, getTextRegions, escXml, HS_TPL_LOGO_SAFE_FRAC } from './hole-sign-render.js';

// ── State ──────────────────────────────────────────────────
const HS = {
  projectId: null,
  projectName: '',
  templateStyle: 'hole-sign-1',
  background: { type: 'color', color: '#FFFFFF', imageUrl: null, storagePath: null },
  topText:    { text: '', font: 'dm-serif', size: 300, color: '#111110' },
  bottomText: { text: '', font: 'dm-serif', size: 300, color: '#111110' },
  banner:     emptyBanner(),
  templateLogos: emptyTemplateLogos(),
  library: [],
  variations: [],
  activeVarId: null,
  editingVarId: null,
  editingDraft: null,
  feedback: [],
};

let _hsDragLogoId = null;
let _hsFeedbackChannel = null;

// Browser eyedropper (Chrome/Edge ≥ 95). Picks a screen color and dispatches an
// `input` event on the target <input type=color>, so the existing oninput
// handler fires the normal color-change path.
const SUPPORTS_EYEDROPPER = typeof window !== 'undefined' && 'EyeDropper' in window;
const EYEDROPPER_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 7l6 6"/><path d="M14 4l3 3a2.121 2.121 0 0 1 0 3l-1.5 1.5-6-6L11 4a2.121 2.121 0 0 1 3 0z"/><path d="M9.5 8.5L3 15v3h3l6.5-6.5"/></svg>`;
function eyedropperBtn(inputId) {
  if (!SUPPORTS_EYEDROPPER) return '';
  return `<button type="button" class="eyedropper-btn" onclick="runEyedropper('${inputId}')" title="Pick color from screen">${EYEDROPPER_SVG}</button>`;
}
window.runEyedropper = async function (inputId) {
  if (!('EyeDropper' in window)) return;
  try {
    const r = await new window.EyeDropper().open();
    const inp = document.getElementById(inputId);
    if (!inp) return;
    inp.value = r.sRGBHex;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  } catch { /* user canceled */ }
};

// Deep-merge a stored banner config onto the empty-banner defaults so older
// saved configs (missing newer fields) stay valid. Also used to clone a banner.
function mergeBanner(b) {
  const base = emptyBanner();
  if (!b) return base;
  return {
    ...base, ...b,
    bg:      { ...base.bg,      ...(b.bg      || {}) },
    topText: { ...base.topText, ...(b.topText || {}) },
    subText: { ...base.subText, ...(b.subText || {}) },
  };
}

// Merge any per-variation template override onto HS for rendering.
// A variation's `v.template` (when set) snapshots a custom template's
// templateStyle/background/topText/bottomText and wins over the global state.
// When this variation is actively being edited, the unsaved draft wins
// over both, so the preview reflects in-progress edits live.
function getEffectiveState(v) {
  if (!v) return HS;
  const out = { ...HS };
  if (v.template) {
    if (v.template.templateStyle) out.templateStyle = v.template.templateStyle;
    if (v.template.background)    out.background    = v.template.background;
    if (v.template.topText)       out.topText       = v.template.topText;
    if (v.template.bottomText)    out.bottomText    = v.template.bottomText;
    if (v.template.banner)        out.banner        = v.template.banner;
    if (v.template.templateLogos) out.templateLogos = v.template.templateLogos;
  }
  if (HS.editingVarId === v.id && HS.editingDraft) {
    const d = HS.editingDraft;
    if (d.templateStyle) out.templateStyle = d.templateStyle;
    if (d.background)    out.background    = d.background;
    if (d.topText)       out.topText       = d.topText;
    if (d.bottomText)    out.bottomText    = d.bottomText;
    if (d.banner)        out.banner        = d.banner;
    if (d.templateLogos) out.templateLogos = d.templateLogos;
  }
  return out;
}

// Returns a variation-shaped object with the editing draft's sponsorText
// merged in, so live previews of the variation being edited reflect
// unsaved sponsor text changes.
function getEffectiveVariation(v) {
  if (!v) return v;
  if (HS.editingVarId === v.id && HS.editingDraft && 'sponsorText' in HS.editingDraft) {
    return { ...v, sponsorText: HS.editingDraft.sponsorText };
  }
  return v;
}

// ── Init ───────────────────────────────────────────────────
async function init() {
  const projectId = new URLSearchParams(window.location.search).get('project');
  if (!projectId) { window.location.href = '/'; return; }
  HS.projectId = projectId;

  try {
    const [project, hsCfg, logos] = await Promise.all([
      loadProject(projectId),
      loadHoleSignConfig(projectId),
      loadLogosForProject(projectId),
    ]);

    HS.projectName = project.name || '';
    HS.library = logos;

    if (hsCfg) {
      const c = hsCfg.colors || {};
      HS.templateStyle = hsCfg.template_style || 'hole-sign-1';
      if (c.background) HS.background = { ...HS.background, ...c.background };
      if (c.topText)    HS.topText    = { ...HS.topText,    ...c.topText };
      if (c.bottomText) HS.bottomText = { ...HS.bottomText, ...c.bottomText };
      if (c.banner)     HS.banner     = mergeBanner(c.banner);
      if (c.templateLogos) {
        HS.templateLogos = { ...emptyTemplateLogos(), ...c.templateLogos };
        HS.templateLogos.slots = (c.templateLogos.slots || []).map(s => ({ ...s, logoSrcTight: undefined }));
        HS.templateLogos.slots.forEach(s => {
          if (s.logoSrc && s.logoArtworkBounds) {
            cropSvgToArtwork(s.logoSrc, s.logoArtworkBounds).then(t => {
              if (t) { s.logoSrcTight = t.url; s.logoAspect = t.aspect; updateStep1Preview(); }
            }).catch(() => {});
          }
        });
      }
      if (hsCfg.variations && hsCfg.variations.length) {
        HS.variations = hsCfg.variations;
        HS.variations.forEach(v => {
          if (!v.templateId) v.templateId = HS.templateStyle;
          if (v.logoId && !v.logoSrc) {
            const lib = HS.library.find(l => l.id === v.logoId);
            if (lib) v.logoSrc = lib.src;
          }
          // Clear any persisted blob URL — blob URLs don't survive reload.
          // The renderer will fall back to v.logoSrc (the durable public URL)
          // until the async re-crop below resolves.
          v.logoSrcTight = undefined;
          if (v.logoSrc && v.logoArtworkBounds) {
            cropSvgToArtwork(v.logoSrc, v.logoArtworkBounds).then(tight => {
              if (tight) { v.logoSrcTight = tight.url; v.logoAspect = tight.aspect; }
            }).catch(() => {});
          }
          // Backward-compat migration: an earlier apply path snapshotted the
          // whole template state (including an empty templateLogos) into
          // v.template. That empty override now blocks the project default
          // from flowing through. Strip it so the variation re-inherits.
          if (v.template?.templateLogos) {
            const tl = v.template.templateLogos;
            const isEmpty = (tl.count ?? 0) === 0 && (!tl.slots || tl.slots.length === 0);
            if (isEmpty) delete v.template.templateLogos;
            if (v.template && Object.keys(v.template).filter(k => k !== 'sourceId').length === 0) {
              delete v.template;
            }
          }
        });
        HS.activeVarId = HS.variations[0].id;
      }
    }

    const nameInput = document.getElementById('projectNameInput');
    if (nameInput) nameInput.value = HS.projectName;
    loadOrderIntake(projectId).then(intake => {
      if (intake) renderCustomerSection(intake);
    }).catch(() => {});
    const refreshFeedback = () => {
      getFeedback(projectId, 'hole-signs').then(fb => {
        HS.feedback = fb || [];
        renderVarList();
      }).catch(() => {});
    };
    refreshFeedback();
    if (_hsFeedbackChannel) _hsFeedbackChannel.unsubscribe();
    _hsFeedbackChannel = supabase
      .channel('hs-feedback-' + projectId)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'variation_feedback', filter: `project_id=eq.${projectId}` },
        refreshFeedback,
      )
      .subscribe();
  } catch (err) {
    console.error('Could not load project', err);
  }

  updateSidebar();
  goStep(1);
}

function renderCustomerSection(intake) {
  const el = document.getElementById('customerSection');
  if (!el) return;
  const fmt = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
  const addr = [intake.address_line1, intake.address_line2, intake.city, intake.state_province, intake.postal_code, intake.country].filter(Boolean).join(', ');
  const colors = Array.isArray(intake.flag_colors) ? intake.flag_colors : [];
  el.innerHTML = `
    <div class="sdivider"></div>
    <div class="cs-wrap">
      <div class="cs-header" onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.cs-toggle').classList.toggle('open')">
        <span class="cs-title">Customer</span>
        <span class="cs-toggle open">▾</span>
      </div>
      <div class="cs-body">
        <div class="cs-row">
          <span class="cs-label">Event</span>
          <span class="cs-value">${intake.event_name}${intake.event_date ? ' · ' + fmt(intake.event_date) : ''}</span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Contact</span>
          <span class="cs-value">${intake.contact_name}<br><span style="color:var(--gray-600)">${intake.contact_email}</span></span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Ship to</span>
          <span class="cs-value">${addr}</span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Setup</span>
          <span class="cs-value">${intake.flag_setup === 'different' ? 'Different front & back' : 'Same front & back'}</span>
        </div>
        ${colors.length ? `<div class="cs-row"><span class="cs-label">Colors</span><div class="cs-colors">${colors.map(c => `<div class="cs-swatch" style="background:${c.hex || c}" title="${c.name || c}"></div>`).join('')}</div></div>` : ''}
        ${intake.design_notes ? `<div class="cs-row"><span class="cs-label">Notes</span><span class="cs-notes">${intake.design_notes}</span></div>` : ''}
      </div>
    </div>`;
  el.style.display = '';
}

// ── Nav ────────────────────────────────────────────────────
function goStep(n) {
  document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('visible', i === n - 1));
  document.querySelectorAll('.step-item').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i === n - 1) s.classList.add('active');
    else if (i < n - 1) s.classList.add('done');
  });
  if (n === 1) { _hsMenu = null; _hsMenuAnimate = false; _qaLogosOpen = null; renderStep1(); }
  if (n === 2) renderStep2();
  if (n === 3) renderGallery();
  window.scrollTo(0, 0);
}

window.tryGoStep = (n) => { goStep(n); };

// ── Sidebar ────────────────────────────────────────────────
function updateSidebar() {
  const vc = document.getElementById('sumVC');
  if (vc) {
    vc.textContent = HS.variations.length || '—';
    vc.style.color = HS.variations.length ? 'var(--black)' : 'var(--gray-400)';
  }
}

window.setProjectName = function (val) {
  HS.projectName = val;
  if (HS.projectId) updateProject(HS.projectId, { name: val || null }).catch(() => {});
};

// Font picker as a dropdown (scales as more fonts are added). `onchange` is the
// inline handler body receiving `this.value`.
function fontSelect(onchange, current) {
  return `<select class="tl-select hs-font-select" onchange="${onchange}">
    ${HS_FONTS.map(f => `<option value="${f.id}"${current === f.id ? ' selected' : ''}>${f.name}</option>`).join('')}
  </select>`;
}

// ── Step 1: Design ─────────────────────────────────────────
function renderTextControls(which, textState) {
  const cap = which.charAt(0).toUpperCase() + which.slice(1);
  return `
    <div class="hs-section">
      <div class="hs-section-title">${cap === 'Top' ? 'Top' : 'Bottom'} text <span class="hs-optional">(optional)</span></div>
      <input class="hexin" style="width:100%" placeholder="Add Text..." value="${escXml(textState.text)}"
        oninput="setHsTextProp('${which}','text',this.value)">
      ${fontSelect(`setHsTextProp('${which}','font',this.value)`, textState.font)}
      <div style="display:flex;align-items:center;gap:8px">
        <input type="range" min="80" max="1000" value="${textState.size}"
          oninput="setHsTextProp('${which}','size',this.value)"
          style="flex:1">
        <span id="hs${cap}SizeLabel" style="font-size:12px;color:var(--gray-600);min-width:50px">${textState.size}pt</span>
      </div>
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="hsText${which}Swatch" value="${textState.color}"
          oninput="setHsTextProp('${which}','color',this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${textState.color}"
          oninput="setHsTextColorHex('${which}',this.value)">
        ${eyedropperBtn('hsText' + which + 'Swatch')}
      </div>
    </div>`;
}

// Step-1 design controls behave as a menu: `_hsMenu === null` shows the option
// list; otherwise it holds the open section key and the controls column shows
// that section's controls with a Back/Save header. `_hsMenuAnimate` makes the
// slide transition fire only on menu navigation, not on every live re-render.
let _hsMenu = null;
let _hsMenuAnimate = false;
// Same list → section pattern for the per-variation editor (template override).
let _hsVarMenu = null;
let _hsVarMenuAnimate = false;

function buildBackgroundSection() {
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
    bgControls = `
      <div class="hs-bg-img-row" style="margin-top:4px">
        <img src="${bg.imageUrl}" style="width:60px;height:40px;object-fit:cover;border-radius:6px;border:1px solid var(--gray-100)">
        <button class="btn sm" onclick="removeBgImage()">Remove image</button>
      </div>`;
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

function buildTemplateSection() {
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

function buildMyTemplatesSection() {
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
function menuRow(key, label, hint, handler = 'openHsMenu') {
  return `
    <button class="hs-menu-row" onclick="${handler}('${key}')">
      <span class="hs-menu-row-label">${label}</span>
      <span class="hs-menu-row-hint">${hint}</span>
      <span class="hs-menu-row-chev">›</span>
    </button>`;
}

function renderDesignMenuList(activeTmpl) {
  const rows = [];
  rows.push(menuRow('template', 'Template', escXml(activeTmpl.name)));
  const customs = loadCustomTemplates();
  rows.push(menuRow('mytemplates', 'My templates', customs.length ? `${customs.length} saved` : 'None'));
  const bg = HS.background;
  const bgHint = bg.type === 'color'
    ? `<span class="hs-menu-swatch" style="background:${escXml(bg.color)}"></span>`
    : (bg.imageUrl ? 'Image' : 'No image');
  rows.push(menuRow('background', 'Background', bgHint));
  rows.push(menuRow('banner', 'Banner', HS.banner?.enabled ? 'On' : 'Off'));
  if (activeTmpl.supportsText) {
    rows.push(menuRow('top', 'Top text', HS.topText.text ? escXml(HS.topText.text) : 'Empty'));
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
  banner: 'Banner', top: 'Top text', bottom: 'Bottom text', logos: 'Template logos',
};

function renderDesignSection(key) {
  let body = '';
  if (key === 'template')         body = buildTemplateSection();
  else if (key === 'mytemplates') body = buildMyTemplatesSection();
  else if (key === 'background')  body = buildBackgroundSection();
  else if (key === 'banner')      body = renderBannerControls();
  else if (key === 'top')         body = renderTextControls('top', HS.topText);
  else if (key === 'bottom')      body = renderTextControls('bottom', HS.bottomText);
  else if (key === 'logos')       body = renderTemplateLogoControls();
  return `
    <div class="hs-menu-section-header">
      <button class="hs-menu-back" onclick="closeHsMenu(false)">← Back</button>
      <span class="hs-menu-section-title">${HS_MENU_TITLES[key] || ''}</span>
      <button class="btn sm primary" onclick="closeHsMenu(true)">Save</button>
    </div>
    ${body}`;
}

window.openHsMenu = function (key) { _hsMenu = key; _hsMenuAnimate = true; renderStep1(); };
window.closeHsMenu = function (save) {
  _hsMenu = null;
  _hsMenuAnimate = true;
  renderStep1();
  if (save) {
    saveDraftInternal().then(() => {
      const el = document.getElementById('saveStatus');
      if (el) { el.textContent = 'Saved'; setTimeout(() => { el.textContent = ''; }, 1500); }
    }).catch(() => {});
  }
};

function renderStep1() {
  const panel = document.getElementById('panel-1');
  const activeTmpl = HS_TEMPLATES.find(t => t.id === HS.templateStyle) || HS_TEMPLATES[0];
  // A section may have become unavailable (e.g. logo-only template hides text).
  if (_hsMenu === 'logos' && activeTmpl.id === 'hole-sign-logo-only') _hsMenu = null;
  if ((_hsMenu === 'top' || _hsMenu === 'bottom') && !activeTmpl.supportsText) _hsMenu = null;

  const controlsInner = _hsMenu === null ? renderDesignMenuList(activeTmpl) : renderDesignSection(_hsMenu);
  const animClass = _hsMenuAnimate ? ' hs-controls-enter' : '';
  _hsMenuAnimate = false;

  panel.innerHTML = `
    <div>
      <div class="ptitle">Design</div>
      <div class="psub">Choose a template, set the background, and configure text.</div>
    </div>
    <div class="hs-design-layout">
      <div class="hs-design-preview-col">
        <div class="canvas-zoom-row">
          <span class="canvas-zoom-value" id="hsStep1ZoomValue">100%</span>
          <button class="canvas-zoom-reset" id="hsStep1ZoomReset" onclick="setHsStep1Zoom(100)" style="display:none">Reset</button>
          <span class="canvas-zoom-hint">⌘ + scroll to zoom</span>
        </div>
        <div class="canvas-scroll hs-step1-scroll" id="hsStep1Scroll">
          <div class="hs-step1-zoom-wrap" id="hsStep1ZoomWrap">
            <div class="hs-sign-thumb" id="hsStep1Preview"></div>
          </div>
        </div>
      </div>
      <div class="hs-design-controls${animClass}">${controlsInner}</div>
    </div>`;

  window.goStep = goStep;

  applyHsStep1Zoom(_hsStep1Zoom);
  wireCanvasZoom('hsStep1Scroll', 'hsStep1ZoomWrap', () => _hsStep1Zoom, applyHsStep1Zoom);
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
  // Update immediately and keep the alignment exactly as set — no auto-correct
  // while editing (the controls already constrain alignment when chosen).
  updateStep1Preview();
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

// Clean state a built-in template starts from. Clicking a built-in card resets
// the canvas to these values; any subsequent edits surface as "Changes made"
// on that card so the user knows the built-in default has been customized.
const HS_BUILTIN_DEFAULTS = {
  background: { type: 'color', color: '#FFFFFF', imageUrl: null, storagePath: null },
  topText:    { text: '', font: 'dm-serif', size: 300, color: '#111110' },
  bottomText: { text: '', font: 'dm-serif', size: 300, color: '#111110' },
};

function applyBuiltInDefaults() {
  HS.background = { ...HS_BUILTIN_DEFAULTS.background };
  HS.topText    = { ...HS_BUILTIN_DEFAULTS.topText };
  HS.bottomText = { ...HS_BUILTIN_DEFAULTS.bottomText };
  HS.banner     = emptyBanner();
  HS.templateLogos = emptyTemplateLogos();
}

function hasBuiltInTemplateChanges() {
  return JSON.stringify(HS.background) !== JSON.stringify(HS_BUILTIN_DEFAULTS.background)
      || JSON.stringify(HS.topText)    !== JSON.stringify(HS_BUILTIN_DEFAULTS.topText)
      || JSON.stringify(HS.bottomText) !== JSON.stringify(HS_BUILTIN_DEFAULTS.bottomText)
      || !!HS.banner?.enabled
      || (HS.templateLogos?.count ?? 0) !== 0;
}

window.setHsTemplate = function (templateId) {
  HS.templateStyle = templateId;
  applyBuiltInDefaults();
  renderStep1();
};

// ── Custom templates (localStorage) ───────────────────────
function loadCustomTemplates() {
  try { return JSON.parse(localStorage.getItem('hs_custom_templates') || '[]'); }
  catch { return []; }
}

function saveCustomTemplates(list) {
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
    banner:        mergeBanner(HS.banner),
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
  HS.banner        = mergeBanner(tmpl.banner);
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

function cloneTemplateLogos(tl) {
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

// ── Banner controls ───────────────────────────────────────
// Like tlSource(): Step 1 edits HS.banner; the per-variation editor edits
// HS.editingDraft.banner. Returns the object the active surface should mutate.
function bannerSource() {
  if (HS.editingVarId && HS.editingDraft) {
    HS.editingDraft.banner = HS.editingDraft.banner || emptyBanner();
    return HS.editingDraft.banner;
  }
  HS.banner = HS.banner || emptyBanner();
  return HS.banner;
}

function redrawBannerStructural() {
  if (HS.editingVarId) { renderEditor(); renderVariationPreview(); }
  else renderStep1();
}
function redrawBannerPreview() {
  if (HS.editingVarId) renderVariationPreview();
  else updateStep1Preview();
}

function renderBannerTextControls(key, label, t) {
  return `
    <div class="hs-section">
      <div class="hs-section-title">${label} <span class="hs-optional">(optional)</span></div>
      <input class="hexin" style="width:100%" placeholder="Add Text..." value="${escXml(t.text)}"
        oninput="setBannerTextProp('${key}','text',this.value)">
      ${fontSelect(`setBannerTextProp('${key}','font',this.value)`, t.font)}
      <div style="display:flex;align-items:center;gap:8px">
        <input type="range" min="80" max="1000" value="${t.size}"
          oninput="setBannerTextProp('${key}','size',this.value)" style="flex:1">
        <span id="hsBanner${key}SizeLabel" style="font-size:12px;color:var(--gray-600);min-width:50px">${t.size}pt</span>
      </div>
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="hsBanner${key}Swatch" value="${t.color}"
          oninput="setBannerTextProp('${key}','color',this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${t.color}"
          oninput="setBannerTextColorHex('${key}',this.value)">
        ${eyedropperBtn('hsBanner' + key + 'Swatch')}
      </div>
    </div>`;
}

function renderBannerControls() {
  const b = bannerSource();
  const enabled = !!b.enabled;
  const enableToggle = `
    <div class="hs-section">
      <div class="hs-section-title">Banner <span class="hs-optional">(full-width strip)</span></div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${enabled ? ' active' : ''}" onclick="setBannerEnabled(true)">On</button>
        <button class="hs-tog-btn${!enabled ? ' active' : ''}" onclick="setBannerEnabled(false)">Off</button>
      </div>
    </div>`;
  if (!enabled) return enableToggle;

  const heightPct = Math.round((b.height - HS_BANNER_MIN_H) / (HS_BANNER_MAX_H - HS_BANNER_MIN_H) * 100);
  const bg = b.bg || {};
  let bgControls;
  if (bg.type === 'image') {
    if (bg.imageUrl) {
      bgControls = `
        <div class="hs-bg-img-row" style="margin-top:4px">
          <img src="${bg.imageUrl}" style="width:60px;height:40px;object-fit:cover;border-radius:6px;border:1px solid var(--gray-100)">
          <button class="btn sm" onclick="removeBannerImage()">Remove</button>
        </div>
        <div class="tl-row"><div class="tl-row-label">Image X</div><div class="tl-size-slider"><input type="range" min="0" max="100" value="${bg.imageX ?? 50}" oninput="setBannerImagePos('imageX',this.value)"></div></div>
        <div class="tl-row"><div class="tl-row-label">Image Y</div><div class="tl-size-slider"><input type="range" min="0" max="100" value="${bg.imageY ?? 50}" oninput="setBannerImagePos('imageY',this.value)"></div></div>
        <div class="tl-row"><div class="tl-row-label">Scale</div><div class="tl-size-slider"><input type="range" min="100" max="300" value="${bg.imageScale ?? 100}" oninput="setBannerImagePos('imageScale',this.value)"><span class="tl-size-value" id="hsBannerScaleVal">${bg.imageScale ?? 100}%</span></div></div>`;
    } else {
      bgControls = `
        <div style="margin-top:4px">
          <button class="btn sm" onclick="document.getElementById('hsBannerImgFile').click()">Upload image</button>
          <input type="file" id="hsBannerImgFile" accept="image/*" style="display:none" onchange="handleBannerImageUpload(event)">
        </div>`;
    }
  } else {
    bgControls = `
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="hsBannerBgSwatch" value="${bg.color || '#E5E5E5'}"
          oninput="setBannerBgColor(this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${bg.color || '#E5E5E5'}"
          oninput="setBannerBgColorHex(this.value)" placeholder="#000000">
        ${eyedropperBtn('hsBannerBgSwatch')}
      </div>`;
  }

  return `
    ${enableToggle}
    <div class="hs-section">
      <div class="hs-section-title">Position &amp; height</div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${b.position !== 'bottom' ? ' active' : ''}" onclick="setBannerPosition('top')">Top</button>
        <button class="hs-tog-btn${b.position === 'bottom' ? ' active' : ''}" onclick="setBannerPosition('bottom')">Bottom</button>
      </div>
      <div class="tl-row" style="margin-top:8px">
        <div class="tl-row-label">Height</div>
        <div class="tl-size-slider">
          <input type="range" min="${HS_BANNER_MIN_H}" max="${HS_BANNER_MAX_H}" step="10" value="${b.height}" oninput="setBannerHeight(this.value)">
          <span class="tl-size-value" id="hsBannerHeightVal">${heightPct}%</span>
        </div>
      </div>
    </div>
    <div class="hs-section">
      <div class="hs-section-title">Banner background</div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${(bg.type || 'color') === 'color' ? ' active' : ''}" onclick="setBannerBgType('color')">Color</button>
        <button class="hs-tog-btn${bg.type === 'image' ? ' active' : ''}" onclick="setBannerBgType('image')">Image</button>
      </div>
      ${bgControls}
    </div>
    ${renderBannerTextControls('topText', 'Title', b.topText)}
    ${renderBannerTextControls('subText', 'Sub-text', b.subText)}`;
}

window.setBannerEnabled = function (on) { bannerSource().enabled = !!on; redrawBannerStructural(); };
window.setBannerPosition = function (pos) { bannerSource().position = pos; redrawBannerStructural(); };
window.setBannerHeight = function (val) {
  const b = bannerSource();
  b.height = Math.max(HS_BANNER_MIN_H, Math.min(HS_BANNER_MAX_H, parseInt(val, 10) || HS_BANNER_MIN_H));
  const lbl = document.getElementById('hsBannerHeightVal');
  if (lbl) lbl.textContent = Math.round((b.height - HS_BANNER_MIN_H) / (HS_BANNER_MAX_H - HS_BANNER_MIN_H) * 100) + '%';
  redrawBannerPreview();
};
window.setBannerBgType = function (type) { bannerSource().bg.type = type; redrawBannerStructural(); };
window.setBannerBgColor = function (val) { bannerSource().bg.color = val; redrawBannerPreview(); };
window.setBannerBgColorHex = function (val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  bannerSource().bg.color = c;
  const s = document.getElementById('hsBannerBgSwatch'); if (s) s.value = c;
  redrawBannerPreview();
};
window.handleBannerImageUpload = async function (e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !HS.projectId) return;
  try {
    const logo = await uploadLogo(HS.projectId, file);
    const b = bannerSource();
    b.bg.imageUrl = logo.src;
    b.bg.storagePath = logo.storagePath;
    redrawBannerStructural();
  } catch (err) { console.error('Banner image upload failed', err); }
};
window.removeBannerImage = function () {
  const b = bannerSource();
  b.bg.imageUrl = null;
  b.bg.storagePath = null;
  redrawBannerStructural();
};
window.setBannerImagePos = function (key, val) {
  bannerSource().bg[key] = parseInt(val, 10);
  if (key === 'imageScale') {
    const lbl = document.getElementById('hsBannerScaleVal');
    if (lbl) lbl.textContent = (parseInt(val, 10) || 100) + '%';
  }
  redrawBannerPreview();
};
window.setBannerTextProp = function (key, prop, val) {
  const obj = bannerSource()[key];
  if (prop === 'size') {
    obj.size = parseInt(val, 10);
    const lbl = document.getElementById('hsBanner' + key + 'SizeLabel');
    if (lbl) lbl.textContent = obj.size + 'pt';
    redrawBannerPreview();
  } else if (prop === 'font') {
    obj.font = val;
    redrawBannerPreview();
  } else {
    obj[prop] = val;
    redrawBannerPreview();
  }
};
window.setBannerTextColorHex = function (key, val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  bannerSource()[key].color = c;
  const s = document.getElementById('hsBanner' + key + 'Swatch'); if (s) s.value = c;
  redrawBannerPreview();
};

// ── Hover quick-add ───────────────────────────────────────
// Hovering near the top or bottom edge of a preview reveals a small toolbar
// offering what can be placed in that band (banner / text / logos), so the
// available options are discoverable directly on the template.
// Which band (top/bottom) currently has its inline logo-count selector expanded.
let _qaLogosOpen = null;

function quickAddTemplateInfo() {
  const editing = !!(HS.editingVarId && HS.editingDraft);
  const tid = editing ? HS.editingDraft.templateStyle : HS.templateStyle;
  const tmpl = HS_TEMPLATES.find(t => t.id === tid) || HS_TEMPLATES[0];
  return { supportsText: tmpl.supportsText, allowsLogos: tid !== 'hole-sign-logo-only' };
}

function currentTemplateLogos() {
  return (HS.editingVarId && HS.editingDraft)
    ? (HS.editingDraft.templateLogos || emptyTemplateLogos())
    : (HS.templateLogos || emptyTemplateLogos());
}

function currentBanner() {
  return (HS.editingVarId && HS.editingDraft) ? (HS.editingDraft.banner || emptyBanner()) : (HS.banner || emptyBanner());
}
function currentText(which) {
  const src = (HS.editingVarId && HS.editingDraft) ? HS.editingDraft : HS;
  return which === 'bottom' ? src.bottomText : src.topText;
}

function buildQuickAddBar(position) {
  const { supportsText, allowsLogos } = quickAddTemplateInfo();
  const chips = [];

  // Banner: hide the option once a banner already exists on the sign.
  const banner = currentBanner();
  if (!banner.enabled) chips.push(`<button class="qa-chip" onclick="quickAdd('banner','${position}')">+ Banner</button>`);

  // Text: hide the option for a band that already has text.
  if (supportsText) {
    const hasText = !!(currentText(position).text || '').trim();
    if (!hasText) chips.push(`<button class="qa-chip" onclick="quickAdd('text','${position}')">+ ${position === 'bottom' ? 'Bottom' : 'Top'} text</button>`);
  }

  // Logos: when this band already has logos, show only the 1/2/3 count + Remove.
  if (allowsLogos) {
    const tl = currentTemplateLogos();
    const logosHere = tl.count > 0 && tl.vAlign === position;
    if (logosHere || _qaLogosOpen === position) {
      const cur = logosHere ? tl.count : 1;
      const nums = [1, 2, 3].map(n =>
        `<button class="qa-num${cur === n ? ' active' : ''}" onclick="quickAddLogosCount('${position}',${n})">${n}</button>`).join('');
      chips.push(`<span class="qa-bar-label">Logos</span><span class="qa-nums">${nums}</span><button class="qa-chip qa-remove" onclick="quickAddLogosRemove('${position}')">Remove</button>`);
    } else {
      chips.push(`<button class="qa-chip" onclick="quickAddLogos('${position}')">+ Logos</button>`);
    }
  }

  const label = chips.length ? `<span class="qa-bar-label">Add to ${position}</span>` : '';
  return `<div class="qa-bar qa-${position}">${label}${chips.join('')}</div>`;
}

function wireQuickAddHover(previewEl) {
  if (!previewEl) return;
  ['top', 'bottom'].forEach(pos => {
    const wrap = document.createElement('div');
    wrap.innerHTML = buildQuickAddBar(pos);
    previewEl.appendChild(wrap.firstElementChild);
  });
  const topBar = previewEl.querySelector('.qa-top');
  const botBar = previewEl.querySelector('.qa-bottom');
  // Assign (not addEventListener) so re-renders overwrite rather than stack.
  previewEl.onmousemove = e => {
    const r = previewEl.getBoundingClientRect();
    const ry = (e.clientY - r.top) / r.height;
    if (topBar) topBar.classList.toggle('show', ry < 0.28);
    if (botBar) botBar.classList.toggle('show', ry > 0.72);
  };
  previewEl.onmouseleave = () => {
    if (topBar) topBar.classList.remove('show');
    if (botBar) botBar.classList.remove('show');
  };
}

window.quickAdd = function (kind, position) {
  const editing = !!(HS.editingVarId && HS.editingDraft);
  const openMenu = editing ? window.openHsVarMenu : window.openHsMenu;
  if (kind === 'banner') {
    const b = bannerSource();
    b.enabled = true;
    b.position = position;
    openMenu('banner');
  } else if (kind === 'text') {
    openMenu(position === 'bottom' ? 'bottom' : 'top');
  }
};

function quickAddRedraw() {
  if (HS.editingVarId) renderVariationPreview();
  else updateStep1Preview();
}

// "+ Logos" tap: expand the inline count selector and place one logo by default.
window.quickAddLogos = function (position) {
  const tl = tlSource();
  if (!tl.count) { tl.count = 1; ensureTlSlots(); }
  tl.vAlign = position;
  correctTplHAlign();
  _qaLogosOpen = position;
  quickAddRedraw();
};

// Picking a number in the inline selector updates how many logo slots there are.
window.quickAddLogosCount = function (position, n) {
  const tl = tlSource();
  tl.count = n;
  ensureTlSlots();
  tl.vAlign = position;
  correctTplHAlign();
  _qaLogosOpen = position;
  quickAddRedraw();
};

// Remove all template logos from the band.
window.quickAddLogosRemove = function () {
  const tl = tlSource();
  tl.count = 0;
  ensureTlSlots();
  _tlSelectedIdx = null;
  _qaLogosOpen = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  quickAddRedraw();
};

// ── Drag-to-snap (banner + logo block) ────────────────────
// Press a band element in the preview and drag up/down; the nearest edge
// highlights and the element snaps to top or bottom on release. `kind` is
// 'banner' (sets banner.position) or 'logos' (sets templateLogos.vAlign).
function bandRectFor(kind, state) {
  if (kind === 'banner') return getBannerRect(state);
  const slots = getTemplateLogoSlots(state, state.templateStyle);
  if (!slots.length) return null;
  const x0 = Math.min(...slots.map(s => s.x)), y0 = Math.min(...slots.map(s => s.y));
  const x1 = Math.max(...slots.map(s => s.x + s.w)), y1 = Math.max(...slots.map(s => s.y + s.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function applyBandPosition(kind, pos) {
  if (kind === 'banner') bannerSource().position = pos;
  else { const tl = tlSource(); tl.vAlign = pos; correctTplHAlign(); }
  if (HS.editingVarId) { renderEditor(); renderVariationPreview(); }
  else renderStep1();
}

// Shared snap-drag. Shows top/bottom drop targets and, only if the pointer
// actually moved, snaps `kind` to the nearest edge on release — so a plain
// click (e.g. on a logo slot) still falls through to its select/add handler.
function beginBandSnap(previewEl, kind, e, captureEl) {
  if (e.button != null && e.button !== 0) return;
  e.preventDefault();
  captureEl.setPointerCapture?.(e.pointerId);
  const pctV = (v, total) => (v / total * 100).toFixed(4) + '%';
  const state = getEffectiveState(HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null);
  const rect = bandRectFor(kind, state);
  const bandH = rect ? rect.h : HS_H * 0.2;
  const mk = atTop => {
    const t = document.createElement('div');
    t.className = 'band-drop-target';
    t.style.cssText = `position:absolute;left:0;width:100%;height:${pctV(bandH, HS_H)};${atTop ? 'top:0;' : 'bottom:0;'}z-index:5;`;
    previewEl.appendChild(t);
    return t;
  };
  const topT = mk(true), botT = mk(false);

  // A ghost of the section follows the cursor so the move is visible.
  const ghost = document.createElement('div');
  ghost.className = 'band-ghost';
  ghost.style.cssText = `position:absolute;left:${pctV(rect ? rect.x : 0, HS_W)};width:${pctV(rect ? rect.w : HS_W, HS_W)};height:${pctV(bandH, HS_H)};z-index:7;display:none;`;
  if (kind === 'banner') {
    const bg = state.banner.bg || {};
    if (bg.type === 'image' && bg.imageUrl) {
      ghost.style.backgroundImage = `url(${bg.imageUrl})`;
      ghost.style.backgroundSize = 'cover';
      ghost.style.backgroundPosition = 'center';
    } else {
      ghost.style.background = bg.color || '#E5E5E5';
    }
    // Match the rendered banner text: same font, color, and size (scaled from
    // sign coords to the preview's layout size so the ghost reads identically).
    const sc = (previewEl.clientHeight || HS_H) / HS_H;
    const fam = id => (HS_FONTS.find(f => f.id === id)?.family) || "'DM Sans', sans-serif";
    const line = t => (t && t.text && t.text.trim())
      ? `<div style="font-family:${fam(t.font)};font-size:${Math.max(1, Math.round(t.size * sc))}px;line-height:1.1;color:${escXml(t.color || '#111110')}">${escXml(t.text)}</div>`
      : '';
    const title = line(state.banner.topText);
    const sub = line(state.banner.subText);
    ghost.innerHTML = (title || sub)
      ? `<div class="band-ghost-text">${title}${sub}</div>`
      : `<span class="band-ghost-label">Banner</span>`;
  } else {
    const slots = (state.templateLogos?.slots || []).filter(s => s?.logoSrc);
    ghost.innerHTML = slots.length
      ? `<div class="band-ghost-logos">${slots.map(s => `<img src="${escXml(s.logoSrcTight || s.logoSrc)}">`).join('')}</div>`
      : `<span class="band-ghost-label">Logos</span>`;
  }
  previewEl.appendChild(ghost);

  const startY = e.clientY;
  let pos = 'top', moved = false;
  const onMove = ev => {
    if (Math.abs(ev.clientY - startY) > 4) moved = true;
    const r = previewEl.getBoundingClientRect();
    pos = (ev.clientY - r.top) / r.height < 0.5 ? 'top' : 'bottom';
    topT.classList.toggle('active', pos === 'top');
    botT.classList.toggle('active', pos === 'bottom');
    if (moved) {
      previewEl.classList.add('band-dragging');
      ghost.style.display = '';
      const hPx = bandH / HS_H * r.height;
      const topPx = Math.max(0, Math.min(r.height - hPx, (ev.clientY - r.top) - hPx / 2));
      ghost.style.top = (topPx / r.height * 100) + '%';
    }
  };
  const onUp = () => {
    captureEl.removeEventListener('pointermove', onMove);
    captureEl.removeEventListener('pointerup', onUp);
    topT.remove(); botT.remove(); ghost.remove();
    previewEl.classList.remove('band-dragging');
    if (moved) {
      _tlJustDragged = true;              // suppress the synthetic click
      setTimeout(() => { _tlJustDragged = false; }, 0);
      applyBandPosition(kind, pos);
    }
  };
  captureEl.addEventListener('pointermove', onMove);
  captureEl.addEventListener('pointerup', onUp);
  onMove(e);
}

function wireElementDrag(previewEl, kind) {
  const state = getEffectiveState(HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null);
  const rect = bandRectFor(kind, state);
  if (!rect) return;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  const ov = document.createElement('div');
  ov.className = 'band-drag';
  ov.style.cssText = `position:absolute;left:${pct(rect.x, HS_W)};top:${pct(rect.y, HS_H)};width:${pct(rect.w, HS_W)};height:${pct(rect.h, HS_H)};cursor:grab;z-index:2;`;
  ov.title = `Drag to move ${kind === 'banner' ? 'banner' : 'logos'} to top or bottom`;
  ov.addEventListener('pointerdown', e => { ov.style.cursor = 'grabbing'; beginBandSnap(previewEl, kind, e, ov); });
  previewEl.appendChild(ov);
}

// Inline canvas text editing: tap a text band to edit it in place. The input
// is styled to match (font, color, size scaled from sign coords) and covers the
// SVG text with the band's background; committing on blur/Enter re-renders.
let _canvasEdit = null;          // { kind, caret } — text band being edited inline
let _canvasRerendering = false;  // true while a live re-render swaps the input

// Caret helpers for the contenteditable inline editor (plain single-text-node).
function caretOffset(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  const r = sel.getRangeAt(0);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}
function setCaret(el, offset) {
  const sel = window.getSelection();
  const range = document.createRange();
  const node = el.firstChild;
  if (node && node.nodeType === 3) range.setStart(node, Math.max(0, Math.min(offset, node.textContent.length)));
  else range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
function selectAll(el) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

function wireCanvasTextEditing(previewEl) {
  const editing = HS.editingVarId && HS.editingDraft;
  const state = getEffectiveState(editing ? HS.variations.find(v => v.id === HS.editingVarId) : null);
  // Keep the active text band alive even if its text is momentarily cleared.
  const forceText = (_canvasEdit && (_canvasEdit.kind === 'top' || _canvasEdit.kind === 'bottom')) ? [_canvasEdit.kind] : [];
  const regions = getTextRegions(state, state.templateStyle, forceText);
  const sc = (previewEl.clientHeight || HS_H) / HS_H;
  const fam = id => (HS_FONTS.find(f => f.id === id)?.family) || "'DM Sans', sans-serif";
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  const textObj = kind => kind === 'bannerTitle' ? state.banner.topText
    : kind === 'bannerSub' ? state.banner.subText
    : kind === 'top' ? state.topText : state.bottomText;
  const setText = (kind, value) => {
    if (kind === 'bannerTitle') bannerSource().topText.text = value;
    else if (kind === 'bannerSub') bannerSource().subText.text = value;
    else {
      const obj = editing ? HS.editingDraft : HS;
      const k = kind === 'top' ? 'topText' : 'bottomText';
      obj[k] = { ...obj[k], text: value };
    }
  };
  // Live: re-render the preview only (re-runs this wiring, which restores the
  // input below). Final: also refresh the side controls.
  const rerenderLive = () => { _canvasRerendering = true; if (editing) renderVariationPreview(); else updateStep1Preview(); _canvasRerendering = false; };
  const rerenderFinal = () => { if (editing) { renderEditor(); renderVariationPreview(); } else updateStep1Preview(); };

  const fontStyle = kind => `text-align:center;overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap;line-height:1.1;color:${textObj(kind).color || '#111110'};font-family:${fam(textObj(kind).font)};font-size:${Math.max(9, Math.round((textObj(kind).size || 200) * sc))}px;`;

  const enterEdit = (zone, kind) => {
    const t = textObj(kind);
    // contenteditable (flex-centered) so the text wraps and stays vertically
    // centered in place — it doesn't jump to the top the way a textarea would.
    const input = document.createElement('div');
    input.className = 'canvas-edit-input';
    input.contentEditable = 'true';
    input.dataset.ph = 'Add Text...';
    input.textContent = t.text || '';
    input.style.cssText = `width:100%;height:100%;box-sizing:border-box;outline:none;display:flex;align-items:center;justify-content:center;${fontStyle(kind)}`;
    // The SVG text for this band is hidden while editing (no halo), so the live
    // editor sits over the band background without needing an opaque cover.
    zone.innerHTML = '';
    zone.appendChild(input);
    input.focus();
    const caret = (_canvasEdit && _canvasEdit.kind === kind) ? _canvasEdit.caret : null;
    if (caret != null) setCaret(input, caret); else selectAll(input);

    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      _canvasEdit = null;
      setText(kind, input.textContent);
      rerenderFinal();
    };
    input.addEventListener('input', () => {
      _canvasEdit = { kind, caret: caretOffset(input) };
      setText(kind, input.textContent);
      rerenderLive(); // text adapts immediately; input is re-created + re-focused
    });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); finalize(); }
    });
    input.addEventListener('blur', () => { if (!_canvasRerendering) finalize(); });
  };

  Object.entries(regions).forEach(([kind, rect]) => {
    const t = textObj(kind);
    const isBanner = kind.startsWith('banner');
    const zone = document.createElement('div');
    zone.className = 'canvas-edit-zone';
    zone.dataset.kind = kind;
    // Banner band is draggable → grab hand on the empty box; text bands are
    // purely editable → text cursor across the band.
    zone.style.cssText = `position:absolute;left:${pct(rect.x, HS_W)};top:${pct(rect.y, HS_H)};width:${pct(rect.w, HS_W)};height:${pct(rect.h, HS_H)};z-index:3;cursor:${isBanner ? 'grab' : 'text'};display:flex;align-items:center;justify-content:center;`;
    if (isBanner) zone.addEventListener('pointerdown', e => { if (!e.target.closest('.canvas-edit-hotspot')) beginBandSnap(previewEl, 'banner', e, zone); });

    // Transparent, content-sized hotspot over the actual text: I-beam + click to
    // edit. Pressing it never starts a banner drag.
    const hot = document.createElement('div');
    hot.className = 'canvas-edit-hotspot';
    hot.style.cssText = `max-width:96%;cursor:text;${fontStyle(kind)}color:transparent;`;
    hot.textContent = t.text && t.text.trim() ? t.text : 'Add Text...';
    const startEdit = e => {
      e.stopPropagation();
      if (_tlJustDragged || zone.querySelector('.canvas-edit-input')) return;
      _canvasEdit = { kind, caret: null };
      enterEdit(zone, kind);
    };
    hot.addEventListener('pointerdown', e => e.stopPropagation());
    hot.addEventListener('click', startEdit);
    zone.appendChild(hot);
    // Clicking the empty area of a (non-draggable) text band also edits it.
    if (!isBanner) zone.addEventListener('click', startEdit);

    previewEl.appendChild(zone);
  });

  // Restore an in-progress inline edit after a live re-render.
  if (_canvasEdit) {
    const zone = previewEl.querySelector(`.canvas-edit-zone[data-kind="${_canvasEdit.kind}"]`);
    if (zone) enterEdit(zone, _canvasEdit.kind);
    else _canvasEdit = null;
  }
}

function updateStep1Preview() {
  const el = document.getElementById('hsStep1Preview');
  if (!el) return;
  el.innerHTML = '';
  // Background SVG. Strip the template-logo slots so the interactive DOM
  // overlays own the slot display (otherwise the SVG copy bleeds out from
  // behind the live overlay during drag/resize — the "halo").
  const previewState = stripSlotImages(HS);
  // Don't draw the text that's being edited inline (the live editor shows it),
  // so the SVG copy doesn't bleed around the editor — the text "halo".
  if (_canvasEdit) previewState.hideText = [_canvasEdit.kind];
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
}

// Return a shallow clone of `state` with the template-logo slot images zeroed
// out, so the SVG keeps the strip layout but skips drawing the slot bitmaps.
function stripSlotImages(state) {
  return {
    ...state,
    templateLogos: state.templateLogos ? {
      ...state.templateLogos,
      slots: (state.templateLogos.slots || []).map(() => null),
    } : state.templateLogos,
  };
}

// Paint interactive DOM overlays on top of a preview SVG so the user can click
// to assign/replace/remove logos and drag/resize within each slot. Used from
// Step 1 and from the per-variation editor preview in Step 2.
function paintTplSlotOverlays(parentEl, state) {
  const tl = state.templateLogos;
  if (!tl || !tl.count) return;
  if (state.templateStyle === 'hole-sign-logo-only') return;
  const slots = getTemplateLogoSlots(state, state.templateStyle);
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  slots.forEach((rect, i) => {
    const slot = tl.slots[i];
    const overlay = document.createElement('div');
    overlay.className = 'tl-slot' + (slot?.logoSrc ? ' has-logo' : '') + (_tlSelectedIdx === i ? ' selected' : '');
    overlay.style.cssText = `position:absolute;left:${pct(rect.x, HS_W)};top:${pct(rect.y, HS_H)};width:${pct(rect.w, HS_W)};height:${pct(rect.h, HS_H)};`;
    overlay.dataset.idx = i;

    if (slot?.logoSrc) {
      if (slot.bg && slot.bg !== 'transparent') overlay.style.background = slot.bg;
      if (slot.border?.color && slot.ratio !== 'fit') overlay.style.border = `2px solid ${slot.border.color}`;
      const img = document.createElement('img');
      img.src = slot.logoSrcTight || slot.logoSrc;
      img.alt = '';
      img.draggable = false;
      img.className = 'tl-slot-img';
      applyTlSlotImgStyle(img, slot);
      overlay.appendChild(img);
      const gh = document.createElement('div'); gh.className = 'tl-snap-guide h'; overlay.appendChild(gh);
      const gv = document.createElement('div'); gv.className = 'tl-snap-guide v'; overlay.appendChild(gv);
      if (_tlSelectedIdx === i) {
        const handle = document.createElement('div');
        handle.className = 'tl-slot-handle';
        overlay.appendChild(handle);
        wireTlSlotDragResize(overlay, img, handle, i);
      }
    } else {
      const ph = document.createElement('div');
      ph.className = 'tl-slot-placeholder';
      ph.innerHTML = '<span>+</span><span class="tl-slot-ph-label">Add logo</span>';
      overlay.appendChild(ph);
    }

    // Unselected slots can be dragged to snap the whole logo block top/bottom;
    // a plain click still selects/adds (beginBandSnap only acts after movement).
    if (_tlSelectedIdx !== i) {
      if (slot?.logoSrc) overlay.style.cursor = 'grab';
      overlay.addEventListener('pointerdown', e => beginBandSnap(parentEl, 'logos', e, overlay));
    }

    overlay.addEventListener('click', e => {
      e.stopPropagation();
      if (_tlJustDragged) return;
      const cur = tlSource().slots[i];
      if (!cur?.logoSrc) {
        openTlLibPicker(i, overlay);
      } else {
        const wasSelected = _tlSelectedIdx === i;
        _tlSelectedIdx = i;
        redrawTplPreview();
        const anchor = document.querySelector(`.tl-slot[data-idx="${i}"]`) || overlay;
        if (wasSelected) closeTlSlotToolbar();
        else openTlSlotToolbar(i, anchor);
      }
    });
    overlay.addEventListener('dblclick', e => {
      e.stopPropagation();
      const cur = tlSource().slots[i];
      if (cur?.logoSrc) {
        _tlSelectedIdx = i;
        closeTlSlotToolbar();
        openTlSidePanel(i);
        redrawTplPreview();
      }
    });

    parentEl.appendChild(overlay);
  });
}

// ── Template logo controls ────────────────────────────────
// Which hAlign options are valid given count + whether text shares the band.
// Anything that would put a logo on top of the text is dropped.
function validHAlignsFor(count, hasText) {
  if (!count || !hasText) return ['left','center','spread','right'];
  if (count === 1) return ['left','right'];
  if (count === 2) return ['left','right','spread'];
  return ['left','right']; // count === 3
}

function tlBandHasText() {
  const tl = tlSource();
  if (!tl || !tl.count) return false;
  const src = HS.editingVarId && HS.editingDraft ? HS.editingDraft : HS;
  const t = tl.vAlign === 'bottom' ? src.bottomText : src.topText;
  return !!(t && t.text && t.text.trim());
}

// If current hAlign just became invalid, snap to the closest still-valid value
// (preferring 'left' as the safe default). Returns true if anything changed.
function correctTplHAlign() {
  const tl = tlSource();
  if (!tl || !tl.count) return false;
  const valid = validHAlignsFor(tl.count, tlBandHasText());
  if (valid.includes(tl.hAlign)) return false;
  tl.hAlign = valid[0];
  if (tl.hAlign === 'spread') tl.stack = 'horizontal';
  return true;
}

function renderTemplateLogoControls() {
  const tl = tlSource();
  const countBtns = [0,1,2,3].map(n => `<button class="hs-tog-btn${tl.count===n?' active':''}" onclick="setTplCount(${n})">${n||'Off'}</button>`).join('');
  if (!tl.count) {
    return `
      <div class="hs-section">
        <div class="hs-section-title">Template logos <span class="hs-optional">(optional)</span></div>
        <div class="hs-bg-toggle">${countBtns}</div>
      </div>`;
  }
  const valid = validHAlignsFor(tl.count, tlBandHasText());
  const opt = (val, label, current) => `<option value="${val}"${current===val?' selected':''}>${label}</option>`;
  const hOpt = (val, label) => {
    const disabled = !valid.includes(val);
    return `<option value="${val}"${tl.hAlign===val?' selected':''}${disabled?' disabled':''}>${label}${disabled?' — overlaps text':''}</option>`;
  };
  const stackDisabled = tl.hAlign === 'spread' || tl.count < 2;
  return `
    <div class="hs-section">
      <div class="hs-section-title">Template logos</div>
      <div class="tl-row"><div class="tl-row-label">Logos</div><div class="hs-bg-toggle">${countBtns}</div></div>
      ${(() => {
        const sz = normalizeTplLogoSize(tl.size);
        const pct = Math.round((sz - HS_TPL_LOGO_MIN) / (HS_TPL_LOGO_MAX - HS_TPL_LOGO_MIN) * 100);
        return `
      <div class="tl-row">
        <div class="tl-row-label">Size</div>
        <div class="tl-size-slider">
          <input type="range" min="${HS_TPL_LOGO_MIN}" max="${HS_TPL_LOGO_MAX}" step="10" value="${sz}" oninput="setTplSize(this.value)">
          <span class="tl-size-value" id="tlSizeValue">${pct}%</span>
        </div>
      </div>`;
      })()}
      <div class="tl-row">
        <div class="tl-row-label">Vertical</div>
        <select class="tl-select" onchange="setTplVAlign(this.value)">
          ${opt('top','Top',tl.vAlign)}${opt('bottom','Bottom',tl.vAlign)}
        </select>
      </div>
      <div class="tl-row">
        <div class="tl-row-label">Horizontal</div>
        <select class="tl-select" onchange="setTplHAlign(this.value)">
          ${hOpt('left','Left')}${hOpt('center','Center')}${hOpt('spread','Spread')}${hOpt('right','Right')}
        </select>
      </div>
      <div class="tl-row${stackDisabled?' disabled':''}">
        <div class="tl-row-label">Stack</div>
        <select class="tl-select" onchange="setTplStack(this.value)" ${stackDisabled?'disabled':''}>
          ${opt('horizontal','Horizontal',tl.stack)}${opt('vertical','Vertical',tl.stack)}
        </select>
      </div>
      <div class="tl-hint">Click a slot in the preview to add a logo. Double-click to fine-tune.</div>
    </div>`;
}

// The same template-logo controls power Step 1 (project default) and the
// per-variation editor (HS.editingDraft.templateLogos). `tlSource` returns the
// object that the active surface should mutate.
function tlSource() {
  if (HS.editingVarId && HS.editingDraft) {
    HS.editingDraft.templateLogos = HS.editingDraft.templateLogos || emptyTemplateLogos();
    return HS.editingDraft.templateLogos;
  }
  HS.templateLogos = HS.templateLogos || emptyTemplateLogos();
  return HS.templateLogos;
}

// Structural redraw — count/align changes can show/hide rows or repaint
// thumbnails, so we re-render the whole controls panel in addition to the
// preview.
function redrawTplStructural() {
  if (HS.editingVarId) {
    renderEditor();
    renderVariationPreview();
  } else {
    renderStep1();
  }
}

// Lightweight redraw for scale/color tweaks that only need the canvas refreshed.
function redrawTplPreview() {
  if (HS.editingVarId) renderVariationPreview();
  else updateStep1Preview();
}

function ensureTlSlots() {
  const tl = tlSource();
  while (tl.slots.length < tl.count) tl.slots.push(null);
  if (tl.slots.length > tl.count) tl.slots.length = tl.count;
}

window.setTplCount = function (n) {
  const tl = tlSource();
  tl.count = n;
  ensureTlSlots();
  correctTplHAlign();
  _tlSelectedIdx = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  redrawTplStructural();
};
window.setTplSize = function (k) {
  const tl = tlSource();
  const n = normalizeTplLogoSize(parseInt(k, 10));
  tl.size = n;
  const lbl = document.getElementById('tlSizeValue');
  if (lbl) {
    const pct = Math.round((n - HS_TPL_LOGO_MIN) / (HS_TPL_LOGO_MAX - HS_TPL_LOGO_MIN) * 100);
    lbl.textContent = pct + '%';
  }
  redrawTplPreview();
};
window.setTplVAlign = function (k) {
  const tl = tlSource();
  tl.vAlign = k;
  correctTplHAlign();
  redrawTplStructural();
};
window.setTplHAlign = function (k) {
  const tl = tlSource();
  const valid = validHAlignsFor(tl.count, tlBandHasText());
  if (!valid.includes(k)) return;
  tl.hAlign = k;
  if (k === 'spread') tl.stack = 'horizontal';
  redrawTplStructural();
};
window.setTplStack = function (k) { tlSource().stack = k; redrawTplStructural(); };

let _tlSelectedIdx = null;
let _tlPickerEl = null;
let _tlJustDragged = false;

function applyTlSlotImgStyle(img, slot) {
  const fit = slot.fit || 'width';
  // In fit mode the slot is sized to the logo's aspect — no safe-area inset.
  const safeFrac = (slot.ratio === 'fit') ? 0 : HS_TPL_LOGO_SAFE_FRAC;
  const safe = 1 - 2 * safeFrac;
  const effScale = (slot.scale ?? 100) * safe;
  const tx = slot.tx ?? 50;
  const ty = slot.ty ?? 50;
  if (fit === 'height') {
    img.style.height = effScale + '%';
    img.style.width  = 'auto';
  } else {
    img.style.width  = effScale + '%';
    img.style.height = 'auto';
  }
  img.style.position = 'absolute';
  img.style.left = tx + '%';
  img.style.top  = ty + '%';
  img.style.transform = 'translate(-50%, -50%)';
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  img.style.pointerEvents = 'none';
}

function wireTlSlotDragResize(overlay, img, handle, idx) {
  let mode = null, startX, startY, startTx, startTy, startScale;
  overlay.addEventListener('pointerdown', e => {
    if (e.target === handle) return;
    mode = 'move';
    overlay.setPointerCapture(e.pointerId);
    const slot = HS.templateLogos.slots[idx];
    startX = e.clientX; startY = e.clientY;
    startTx = slot.tx ?? 50; startTy = slot.ty ?? 50;
    e.preventDefault();
  });
  handle.addEventListener('pointerdown', e => {
    mode = 'resize';
    handle.setPointerCapture(e.pointerId);
    const slot = HS.templateLogos.slots[idx];
    startX = e.clientX; startY = e.clientY;
    startScale = slot.scale ?? 100;
    e.stopPropagation();
    e.preventDefault();
  });
  const SNAP_PCT = 4; // % within which to snap to center on each axis
  const onMove = e => {
    if (!mode) return;
    const slot = HS.templateLogos.slots[idx];
    const rect = overlay.getBoundingClientRect();
    if (mode === 'move') {
      const dx = (e.clientX - startX) / rect.width  * 100;
      const dy = (e.clientY - startY) / rect.height * 100;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) _tlJustDragged = true;
      let nx = startTx + dx;
      let ny = startTy + dy;
      const snapX = Math.abs(nx - 50) < SNAP_PCT;
      const snapY = Math.abs(ny - 50) < SNAP_PCT;
      if (snapX) nx = 50;
      if (snapY) ny = 50;
      overlay.classList.toggle('snap-x', snapX);
      overlay.classList.toggle('snap-y', snapY);
      slot.tx = nx;
      slot.ty = ny;
      applyTlSlotImgStyle(img, slot);
    } else if (mode === 'resize') {
      const dx = (e.clientX - startX) / rect.width * 100 * 2;
      if (Math.abs(dx) > 0.5) _tlJustDragged = true;
      slot.scale = Math.max(10, Math.min(400, startScale + dx));
      applyTlSlotImgStyle(img, slot);
    }
  };
  overlay.addEventListener('pointermove', onMove);
  handle.addEventListener('pointermove', onMove);
  const onUp = () => {
    mode = null;
    overlay.classList.remove('snap-x', 'snap-y');
    // Reset the drag-flag after the synthetic click would have fired.
    setTimeout(() => { _tlJustDragged = false; }, 0);
  };
  overlay.addEventListener('pointerup', onUp);
  handle.addEventListener('pointerup', onUp);
}

function openTlLibPicker(idx, anchorEl) {
  closeTlLibPicker();
  const picker = document.createElement('div');
  picker.className = 'tl-lib-picker';
  const libHtml = HS.library.length
    ? HS.library.map(l => `<div class="tl-lp-item" data-lid="${l.id}" title="${escXml(l.name)}"><img src="${l.src}" alt=""></div>`).join('')
    : '<div class="tl-lp-empty">No logos uploaded yet</div>';
  picker.innerHTML = `${libHtml}<div class="tl-lp-upload" id="tlLpUpload">+ Upload image</div><input type="file" id="tlLpFile" accept="image/*" style="display:none">`;
  document.body.appendChild(picker);
  _tlPickerEl = picker;

  const r = anchorEl.getBoundingClientRect();
  const ph = picker.offsetHeight;
  const pw = picker.offsetWidth;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const gap = 6;
  const spaceBelow = vh - r.bottom;
  const placeAbove = spaceBelow < ph + gap && r.top > ph + gap;
  const top = placeAbove ? (r.top + window.scrollY - ph - gap) : (r.bottom + window.scrollY + gap);
  const left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + vw - pw - 8));
  picker.style.left = left + 'px';
  picker.style.top  = top + 'px';

  picker.querySelectorAll('.tl-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      const logo = HS.library.find(l => l.id === el.dataset.lid);
      if (logo) assignTlSlot(idx, logo);
      closeTlLibPicker();
    });
  });
  const fileInput = picker.querySelector('#tlLpFile');
  picker.querySelector('#tlLpUpload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const logo = await uploadLogo(HS.projectId, file);
      HS.library.push(logo);
      assignTlSlot(idx, logo);
    } catch (err) { console.error('Upload failed', err); }
    closeTlLibPicker();
  });

  setTimeout(() => {
    const close = ev => {
      if (!ev.target.closest('.tl-lib-picker')) {
        closeTlLibPicker();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

function closeTlLibPicker() {
  if (_tlPickerEl) { _tlPickerEl.remove(); _tlPickerEl = null; }
}

function openTlSlotToolbar(idx, anchorEl) {
  closeTlSlotToolbar();
  const tb = document.createElement('div');
  tb.id = 'tlSlotToolbar';
  tb.className = 'tl-slot-toolbar';
  tb.innerHTML = `
    <button class="tl-tb-btn" data-act="replace">Replace</button>
    <button class="tl-tb-btn" data-act="finetune">Fine-tune</button>
    <button class="tl-tb-btn danger" data-act="remove">Remove</button>`;
  document.body.appendChild(tb);

  tb.addEventListener('click', e => {
    const act = e.target.dataset?.act;
    if (!act) return;
    closeTlSlotToolbar();
    const liveAnchor = document.querySelector(`.tl-slot[data-idx="${idx}"]`) || anchorEl;
    if (act === 'replace')   openTlLibPicker(idx, liveAnchor);
    if (act === 'finetune')  openTlSidePanel(idx);
    if (act === 'remove')    removeTlSlot(idx);
  });

  const r = anchorEl.getBoundingClientRect();
  // Default above; flip below if there's not enough headroom.
  const th = tb.offsetHeight;
  const tw = tb.offsetWidth;
  const placeAbove = r.top > th + 12;
  const top  = placeAbove ? (r.top + window.scrollY - th - 6) : (r.bottom + window.scrollY + 6);
  const left = Math.max(8, Math.min(window.scrollX + window.innerWidth - tw - 8,
    r.left + window.scrollX + r.width / 2 - tw / 2));
  tb.style.top  = top + 'px';
  tb.style.left = left + 'px';

  setTimeout(() => {
    const close = ev => {
      if (!ev.target.closest('#tlSlotToolbar') && !ev.target.closest('.tl-slot') && !ev.target.closest('.tl-lib-picker') && !ev.target.closest('#tlSidePanel')) {
        closeTlSlotToolbar();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

function closeTlSlotToolbar() {
  const tb = document.getElementById('tlSlotToolbar');
  if (tb) tb.remove();
}

function assignTlSlot(idx, logo) {
  ensureTlSlots();
  const slot = {
    logoId: logo.id,
    logoSrc: logo.src,
    fit: 'width',
    tx: 50, ty: 50, scale: 100,
  };
  tlSource().slots[idx] = slot;
  _tlSelectedIdx = idx;
  prepareLogo(slot, logo.src).then(() => redrawTplPreview()).catch(() => {});
  redrawTplPreview();
}

function openTlSidePanel(idx) {
  closeTlSidePanel();
  const slot = HS.templateLogos.slots[idx];
  if (!slot) return;
  const hasBg = !!(slot.bg && slot.bg !== 'transparent');
  const bgColor = hasBg ? slot.bg : '#FFFFFF';
  const hasBorder = !!(slot.border && slot.border.color);
  const borderColor = hasBorder ? slot.border.color : '#000000';
  const ratio = slot.ratio || '2:1';
  const ratioOpt = (val, label) =>
    `<option value="${val}"${ratio === val ? ' selected' : ''}>${label}</option>`;
  const panel = document.createElement('div');
  panel.id = 'tlSidePanel';
  panel.className = 'tl-side-panel';
  panel.innerHTML = `
    <div class="tl-sp-header">
      <div class="tl-sp-title">Slot ${idx + 1}</div>
      <button class="tl-sp-close" onclick="closeTlSidePanel()">✕</button>
    </div>
    <div class="tl-sp-body">
      <div class="hs-editor-section">
        <div class="hs-editor-label">Ratio</div>
        <select class="tl-select" onchange="setTlSlotRatio(${idx}, this.value)">
          ${ratioOpt('fit','Fit logo')}${ratioOpt('1:1','1:1')}${ratioOpt('2:1','2:1')}${ratioOpt('3:1','3:1')}${ratioOpt('4:1','4:1')}
        </select>
      </div>
      <div class="hs-editor-section">
        <div class="hs-editor-label">Fit</div>
        <div class="hs-bg-toggle">
          <button class="hs-tog-btn${(slot.fit||'width')==='width'?' active':''}" onclick="setTlSlotFit(${idx},'width')">Width</button>
          <button class="hs-tog-btn${slot.fit==='height'?' active':''}" onclick="setTlSlotFit(${idx},'height')">Height</button>
        </div>
        <div style="font-size:11px;color:var(--gray-400);margin-top:4px">Drag to reposition and the corner handle to resize. The safe-area padding stays in effect at scale 100%.</div>
      </div>
      <div class="hs-editor-section">
        <div class="hs-editor-label">Scale</div>
        <input type="range" id="tlSpScale" min="10" max="400" value="${slot.scale ?? 100}" oninput="setTlSlotScale(${idx}, this.value); document.getElementById('tlSpScaleLabel').textContent=this.value+'%'">
        <div style="display:flex;justify-content:space-between"><span style="font-size:11px;color:var(--gray-400)">10%</span><span id="tlSpScaleLabel" style="font-size:11px;color:var(--gray-600)">${slot.scale ?? 100}%</span><span style="font-size:11px;color:var(--gray-400)">400%</span></div>
      </div>
      <div class="hs-editor-section">
        <div class="tl-toggle-row">
          <div class="hs-editor-label" style="margin:0">Background</div>
          <label class="tl-switch">
            <input type="checkbox"${hasBg?' checked':''} onchange="setTlSlotBgMode(${idx}, this.checked?'color':'transparent')">
            <span class="tl-switch-slider"></span>
          </label>
        </div>
        ${hasBg ? `
        <div class="color-row">
          <input type="color" class="hs-color-swatch" id="tlSpBgSwatch" value="${bgColor}"
            oninput="setTlSlotBgColor(${idx}, this.value)">
          <input type="text" class="hexin" id="tlSpBgHex" style="flex:1" maxlength="7" value="${bgColor}"
            oninput="setTlSlotBgHex(${idx}, this.value)">
          ${eyedropperBtn('tlSpBgSwatch')}
        </div>` : ''}
      </div>
      ${ratio === 'fit' ? '' : `
      <div class="hs-editor-section">
        <div class="tl-toggle-row">
          <div class="hs-editor-label" style="margin:0">Border</div>
          <label class="tl-switch">
            <input type="checkbox"${hasBorder?' checked':''} onchange="setTlSlotBorderMode(${idx}, this.checked?'on':'off')">
            <span class="tl-switch-slider"></span>
          </label>
        </div>
        ${hasBorder ? `
        <div class="color-row">
          <input type="color" class="hs-color-swatch" id="tlSpBorderSwatch" value="${borderColor}"
            oninput="setTlSlotBorderColor(${idx}, this.value)">
          <input type="text" class="hexin" id="tlSpBorderHex" style="flex:1" maxlength="7" value="${borderColor}"
            oninput="setTlSlotBorderHex(${idx}, this.value)">
          ${eyedropperBtn('tlSpBorderSwatch')}
        </div>` : ''}
      </div>`}
      <div class="hs-editor-section">
        <button class="btn sm" onclick="resetTlSlot(${idx})">Reset position</button>
        <button class="btn sm" style="color:#dc2626;border-color:#fecaca" onclick="removeTlSlot(${idx})">Remove logo</button>
      </div>
    </div>`;
  document.body.appendChild(panel);
}

window.closeTlSidePanel = function () {
  const p = document.getElementById('tlSidePanel');
  if (p) p.remove();
};

function activeSlot(idx) { return tlSource().slots[idx]; }

window.setTlSlotFit = function (idx, fit) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.fit = fit;
  slot.scale = 100;
  slot.tx = 50; slot.ty = 50;
  redrawTplPreview();
  openTlSidePanel(idx);
};
window.setTlSlotScale = function (idx, val) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.scale = parseInt(val, 10) || 100;
  redrawTplPreview();
};
window.resetTlSlot = function (idx) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.tx = 50; slot.ty = 50; slot.scale = 100;
  redrawTplPreview();
  openTlSidePanel(idx);
};
window.removeTlSlot = function (idx) {
  tlSource().slots[idx] = null;
  _tlSelectedIdx = null;
  closeTlSidePanel();
  redrawTplPreview();
};
window.setTlSlotBgMode = function (idx, mode) {
  const slot = activeSlot(idx); if (!slot) return;
  if (mode === 'transparent') {
    if (slot.bg && slot.bg !== 'transparent') slot.bgLast = slot.bg;
    slot.bg = null;
  } else {
    slot.bg = slot.bgLast || slot.bg || '#FFFFFF';
  }
  openTlSidePanel(idx);
  redrawTplPreview();
};
window.setTlSlotBgColor = function (idx, color) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.bg = color;
  const hex = document.getElementById('tlSpBgHex');
  if (hex) hex.value = color;
  redrawTplPreview();
};
window.setTlSlotBgHex = function (idx, val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
  const slot = activeSlot(idx); if (!slot) return;
  slot.bg = c;
  const swatch = document.getElementById('tlSpBgSwatch');
  if (swatch) swatch.value = c;
  redrawTplPreview();
};
window.setTlSlotRatio = function (idx, val) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.ratio = val;
  redrawTplPreview();
};
window.setTlSlotBorderMode = function (idx, mode) {
  const slot = activeSlot(idx); if (!slot) return;
  if (mode === 'off') {
    if (slot.border) slot.borderLast = slot.border;
    slot.border = null;
  } else {
    slot.border = slot.borderLast || slot.border || { color: '#000000' };
  }
  openTlSidePanel(idx);
  redrawTplPreview();
};
window.setTlSlotBorderColor = function (idx, color) {
  const slot = activeSlot(idx); if (!slot) return;
  slot.border = { ...(slot.border || {}), color };
  const hex = document.getElementById('tlSpBorderHex');
  if (hex) hex.value = color;
  redrawTplPreview();
};
window.setTlSlotBorderHex = function (idx, val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
  const slot = activeSlot(idx); if (!slot) return;
  slot.border = { ...(slot.border || {}), color: c };
  const swatch = document.getElementById('tlSpBorderSwatch');
  if (swatch) swatch.value = c;
  redrawTplPreview();
};

// ── Step 2: Variations ─────────────────────────────────────
function renderStep2() {
  const panel = document.getElementById('panel-2');
  panel.innerHTML = `
    <div>
      <div class="ptitle">Variations</div>
      <div class="psub">Upload sponsor logos and build one variation per sponsor. <strong>Each sign is printed front and back</strong> with the same design.</div>
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
        <div class="hs-var-tmpl-row" id="hsVarTmplRow"></div>
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
  wireCanvasZoom('hsCanvasScroll', 'hsZoomWrap', () => _hsZoom, applyHsZoom);

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

function buildLibStrip() {
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
    el.addEventListener('dragstart', () => { _hsDragLogoId = logo.id; el.classList.add('dragging'); });
    el.addEventListener('dragend',   () => { _hsDragLogoId = null;    el.classList.remove('dragging'); });
    strip.appendChild(el);
  });
}

async function deleteHsLibLogo(logo) {
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

function addVariationForLogo(logo) {
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

function selectVariation(id) {
  HS.activeVarId = id;
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
}

window.selectHsVariation = function (id) { selectVariation(id); };

function renderVarTmplRow() {
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

let _hsZoom = 100;

function applyHsZoom(pct) {
  _hsZoom = pct;
  const wrap = document.getElementById('hsZoomWrap');
  const label = document.getElementById('hsZoomValue');
  const reset = document.getElementById('hsZoomReset');
  if (wrap) wrap.style.width = pct + '%';
  if (label) label.textContent = pct + '%';
  if (reset) reset.style.display = pct === 100 ? 'none' : '';
}

window.setHsZoom = function (val) {
  const pct = Math.max(40, Math.min(400, parseInt(val, 10) || 100));
  applyHsZoom(pct);
};

// Step 1 zoom — height-based so 100% fits the canvas vertically (showing the
// whole sign by default in the viewport-sized scroll container).
let _hsStep1Zoom = 100;

function applyHsStep1Zoom(pct) {
  _hsStep1Zoom = pct;
  const wrap = document.getElementById('hsStep1ZoomWrap');
  const label = document.getElementById('hsStep1ZoomValue');
  const reset = document.getElementById('hsStep1ZoomReset');
  if (wrap) wrap.style.height = pct + '%';
  if (label) label.textContent = pct + '%';
  if (reset) reset.style.display = pct === 100 ? 'none' : '';
}

window.setHsStep1Zoom = function (val) {
  const pct = Math.max(40, Math.min(400, parseInt(val, 10) || 100));
  applyHsStep1Zoom(pct);
};

function wireCanvasZoom(scrollId, wrapId, getZoom, applyZoom) {
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

function renderVarList() {
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
    banner:        mergeBanner(eff.banner),
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
  _tlSelectedIdx = null;
  _hsVarMenu = null;
  _hsVarMenuAnimate = false;
  _qaLogosOpen = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  renderEditor();
  renderVariationPreview();
};

window.cancelEditVar = function () {
  HS.editingVarId = null;
  HS.editingDraft = null;
  _tlSelectedIdx = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
};

function tlForCompare(tl) {
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
  if (JSON.stringify(mergeBanner(d.banner)) !== JSON.stringify(mergeBanner(HS.banner))) tpl.banner = mergeBanner(d.banner);
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
  _tlSelectedIdx = null;
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
    HS.editingDraft.banner        = mergeBanner(HS.banner);
    HS.editingDraft.templateLogos = cloneTemplateLogos(HS.templateLogos);
  } else if (key.startsWith('custom:')) {
    const tmpl = loadCustomTemplates().find(t => t.id === key.slice(7));
    if (!tmpl) return;
    HS.editingDraft.templateStyle = tmpl.templateStyle;
    HS.editingDraft.background    = { ...tmpl.background };
    HS.editingDraft.topText       = { ...tmpl.topText };
    HS.editingDraft.bottomText    = { ...tmpl.bottomText };
    HS.editingDraft.banner        = mergeBanner(tmpl.banner);
    HS.editingDraft.templateLogos = cloneTemplateLogos(tmpl.templateLogos);
  } else {
    HS.editingDraft.templateStyle = key;
  }
  _tlSelectedIdx = null;
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

function renderDraftTextControls(which, label, optional) {
  const d = HS.editingDraft;
  const k = which === 'top' ? 'topText' : which === 'bottom' ? 'bottomText' : 'sponsorText';
  const st = d[k] || { text: '', font: 'dm-serif', size: 300, color: '#111110' };
  return `
    <div class="hs-editor-section">
      <div class="hs-editor-label">${label}${optional ? ' <span class="hs-optional">(optional)</span>' : ''}</div>
      <input class="hexin" style="width:100%" placeholder="Add Text..." value="${escXml(st.text)}"
        oninput="setDraftText('${which}','text',this.value)">
      ${fontSelect(`setDraftText('${which}','font',this.value)`, st.font)}
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
  template: 'Template', background: 'Background', banner: 'Banner',
  top: 'Top text', bottom: 'Bottom text', logos: 'Template logos', sponsor: 'Sponsor name',
};

function buildVarTemplateSection(d, customs) {
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

function buildVarBackgroundSection(d) {
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

window.openHsVarMenu = function (key) { _hsVarMenu = key; _hsVarMenuAnimate = true; renderEditor(); };
window.closeHsVarMenu = function () { _hsVarMenu = null; _hsVarMenuAnimate = true; renderEditor(); };

function renderEditor() {
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
  if (_hsVarMenu === 'logos' && activeTmpl.id === 'hole-sign-logo-only') _hsVarMenu = null;
  if ((_hsVarMenu === 'top' || _hsVarMenu === 'bottom') && !activeTmpl.supportsText) _hsVarMenu = null;
  if (_hsVarMenu === 'sponsor' && !sponsorVisible) _hsVarMenu = null;

  let body;
  if (_hsVarMenu === null) {
    const rows = [];
    rows.push(menuRow('template', 'Template', escXml(activeTmpl.name), 'openHsVarMenu'));
    const bg = d.background;
    const bgHint = bg.type === 'color'
      ? `<span class="hs-menu-swatch" style="background:${escXml(bg.color)}"></span>`
      : 'Image';
    rows.push(menuRow('background', 'Background', bgHint, 'openHsVarMenu'));
    rows.push(menuRow('banner', 'Banner', d.banner?.enabled ? 'On' : 'Off', 'openHsVarMenu'));
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
    if (_hsVarMenu === 'template')        section = buildVarTemplateSection(d, customs);
    else if (_hsVarMenu === 'background') section = buildVarBackgroundSection(d);
    else if (_hsVarMenu === 'banner')     section = renderBannerControls();
    else if (_hsVarMenu === 'top')        section = renderDraftTextControls('top', 'Top text', true);
    else if (_hsVarMenu === 'bottom')     section = renderDraftTextControls('bottom', 'Bottom text', true);
    else if (_hsVarMenu === 'logos')      section = renderTemplateLogoControls();
    else if (_hsVarMenu === 'sponsor')    section = renderDraftTextControls('sponsor', 'Sponsor name', true)
      + '<div style="font-size:11px;color:var(--gray-400);margin-top:-8px;margin-bottom:8px;padding:0 2px">Displayed in the logo zone when no logo is uploaded.</div>';
    body = `
      <div class="hs-menu-section-header">
        <button class="hs-menu-back" onclick="closeHsVarMenu()">← Back</button>
        <span class="hs-menu-section-title">${HS_VAR_MENU_TITLES[_hsVarMenu] || ''}</span>
      </div>
      ${section}`;
  }

  const animClass = _hsVarMenuAnimate ? ' hs-controls-enter' : '';
  _hsVarMenuAnimate = false;

  list.innerHTML = `
    <div class="var-editor">
      <div class="var-editor-header">
        <div class="var-editor-title">Editing: ${escXml(v.name)}</div>
        <button class="vbtn" title="Cancel" onclick="cancelEditVar()">✕</button>
      </div>
      <div class="hs-editor-body${animClass}">${body}</div>
    </div>`;
}

function renderVariationPreview() {
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
  if (isEditingActive && _canvasEdit) bgState.hideText = [_canvasEdit.kind];
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
  const lz = getLogoZone(effState, variation.templateId);
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
      if (_hsActiveZone?.dzone === dzone) { hideHsToolbar(); return; }
      if (_hsActiveZone) _hsActiveZone.dzone.classList.remove('selected');
      _hsActiveZone = { dzone, variation };
      dzone.classList.add('selected');
      showHsToolbar(dzone);
    });
  } else {
    dzone.style.cursor = 'pointer';
    dzone.addEventListener('click', e => {
      e.stopPropagation();
      if (_hsActiveZone?.dzone === dzone) { hideHsToolbar(); return; }
      if (_hsActiveZone) _hsActiveZone.dzone.classList.remove('selected');
      _hsActiveZone = { dzone, variation };
      dzone.classList.add('selected');
      showHsToolbar(dzone, true);
    });
  }

  dzone.addEventListener('dragover',  e => { e.preventDefault(); dzone.classList.add('drag-over'); });
  dzone.addEventListener('dragleave', ()  => dzone.classList.remove('drag-over'));
  dzone.addEventListener('drop', e => {
    e.preventDefault();
    dzone.classList.remove('drag-over');
    if (!_hsDragLogoId) return;
    const logo = HS.library.find(l => l.id === _hsDragLogoId);
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
    _hsDragLogoId = null;
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

function positionWrap(wrap, ld) {
  wrap.style.left   = ld.x + '%';
  wrap.style.top    = ld.y + '%';
  wrap.style.width  = ld.w + '%';
  wrap.style.height = 'auto';
}

// Render a DOM overlay for the variation's sponsor text inside the logo zone.
// Click to select, drag the corner handle to resize. Updates sponsorText.size
// live on the variation (and on HS.editingDraft.sponsorText when in editor).
function setupHsInteraction(dz, wrap, handle, variation) {
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
      let nx = Math.max(0, Math.min(100, startX + dx));
      let ny = Math.max(0, Math.min(100, startY + dy));

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

let _hsActiveZone = null;

function ensureHsToolbar() {
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
    if (!_hsActiveZone) return;
    _hsActiveZone.variation.logoId = null;
    _hsActiveZone.variation.logoSrc = null;
    delete _hsActiveZone.variation.sponsorText;
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
    if (!file || !_hsActiveZone) return;
    try {
      const logo = await uploadLogo(HS.projectId, file);
      HS.library.push(logo);
      buildLibStrip();
      const capturedVar = _hsActiveZone.variation;
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

function renderHsLibPicker() {
  const picker = document.getElementById('hsLibPicker');
  if (!picker || !_hsActiveZone) return;
  const { variation } = _hsActiveZone;
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
      if (!logo || !_hsActiveZone) return;
      const pickedVar = _hsActiveZone.variation;
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
    if (!_hsActiveZone) return;
    const v = _hsActiveZone.variation;
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

function showHsToolbar(dz, openPicker = false) {
  ensureHsToolbar();
  const v = _hsActiveZone?.variation;
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

// Scan alpha channel on a 256×256 canvas to find opaque pixel bounds (fractions of image size)
async function detectArtworkBounds(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const SZ = 256;
      const canvas = document.createElement('canvas');
      canvas.width = SZ; canvas.height = SZ;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, SZ, SZ);
      let d;
      try { d = ctx.getImageData(0, 0, SZ, SZ).data; } catch { resolve(null); return; }
      let minX = SZ, maxX = -1, minY = SZ, maxY = -1;
      for (let y = 0; y < SZ; y++) {
        for (let x = 0; x < SZ; x++) {
          if (d[(y * SZ + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) { resolve(null); return; }
      resolve({
        x: minX / SZ, y: minY / SZ,
        w: (maxX - minX + 1) / SZ, h: (maxY - minY + 1) / SZ,
        natW: img.naturalWidth  || SZ,
        natH: img.naturalHeight || SZ,
      });
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Fetch SVG, tighten viewBox to artwork bounds, return { url, aspect } or null
async function cropSvgToArtwork(src, ab) {
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.includes('<svg')) return null;
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return null;
    let vpX = 0, vpY = 0, vpW = 0, vpH = 0;
    const vb = svg.getAttribute('viewBox');
    if (vb) {
      [vpX, vpY, vpW, vpH] = vb.trim().split(/[\s,]+/).map(Number);
    } else {
      vpW = parseFloat(svg.getAttribute('width')) || 0;
      vpH = parseFloat(svg.getAttribute('height')) || 0;
    }
    if (!vpW || !vpH) return null;
    const nx = vpX + ab.x * vpW, ny = vpY + ab.y * vpH;
    const nw = ab.w * vpW,       nh = ab.h * vpH;
    svg.setAttribute('viewBox', `${nx} ${ny} ${nw} ${nh}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
    return { url, aspect: nh / nw };
  } catch { return null; }
}

// Detect bounds, crop SVG viewBox, store tight src + aspect on variation
async function prepareLogo(variation, src) {
  const ab = await detectArtworkBounds(src);
  variation.logoArtworkBounds = ab;
  if (!ab) return;
  const tight = await cropSvgToArtwork(src, ab);
  if (tight) {
    if (variation.logoSrcTight?.startsWith('blob:')) URL.revokeObjectURL(variation.logoSrcTight);
    variation.logoSrcTight = tight.url;
    variation.logoAspect   = tight.aspect;
  } else {
    // Raster fallback: compute actual artwork aspect from canvas bounds + natural dimensions.
    // ab.w and ab.h are fractions of natural width and height respectively (canvas was square
    // but fractions map 1:1 to natural coords), so artwork pixel dims are ab.w*natW × ab.h*natH.
    const artW = ab.w * ab.natW;
    const artH = ab.h * ab.natH;
    variation.logoAspect = artW > 0 ? artH / artW : 1;
  }
}

function applyFillToVariation(variation) {
  const lz = getLogoZone(HS, variation.templateId);
  const aspect = variation.logoAspect ?? 1;
  const byHeight = 100 * (lz.h / lz.w) / aspect;
  const newW = Math.min(100, byHeight) * 0.97;
  if (!variation.logoData) variation.logoData = { x: 50, y: 50, w: 90 };
  variation.logoData.w = Math.round(newW * 10) / 10;
  variation.logoData.x = 50;
  variation.logoData.y = 50;
}

function fillHsLogo() {
  const variation = _hsActiveZone?.variation;
  if (!variation?.logoSrc) return;
  applyFillToVariation(variation);
  hideHsToolbar();
  renderVarList();
  renderVariationPreview();
}

function hideHsToolbar() {
  const tb = document.getElementById('hsZoneToolbar');
  if (tb) tb.style.display = 'none';
  const picker = document.getElementById('hsLibPicker');
  if (picker) picker.style.display = 'none';
  if (_hsActiveZone?.dzone) _hsActiveZone.dzone.classList.remove('selected');
  _hsActiveZone = null;
}

// ── Step 3: Gallery ─────────────────────────────────────────
function renderGallery() {
  const panel = document.getElementById('panel-3');
  panel.innerHTML = `
    <div>
      <div class="ptitle">Gallery & export</div>
      <div class="psub">Review all variations and export or share.</div>
    </div>
    <div class="s5layout">
      <div>
        <div class="hs-gallery-grid" id="hsGalleryGrid"></div>
      </div>
      <div class="review-card">
        <div class="rc-title">Selected</div>
        <div class="hs-gallery-selected" id="hsGallerySelected"></div>
        <div id="hsGallerySelectedName" style="font-size:13px;font-weight:500;text-align:center;margin-bottom:.5rem;color:var(--gray-600)"></div>
        <div class="exp-row">
          <button class="btn sm" id="hsExpPdf" onclick="exportHsPDF()">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PDF
          </button>
          <button class="btn sm" id="hsExpPng" onclick="exportHsPNG()">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PNG
          </button>
          <button class="btn sm" id="hsExpSvg" onclick="exportHsSVG()">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>SVG
          </button>
        </div>
        <button class="btn sm" style="width:100%;justify-content:center" onclick="exportHsAllPNG()">Export all PNG</button>
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--gray-100)">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-400);font-weight:500;margin-bottom:6px">Print files</div>
          <button class="btn sm primary" id="hsExpPrintBtn" style="width:100%;justify-content:center" onclick="downloadHsPrint()">↓ Download print sheets (zip)</button>
          <div id="hsExpPrintStatus" style="font-size:12px;color:var(--gray-600);min-height:14px;margin-top:6px"></div>
        </div>
        <div class="share-section">
          <div class="rc-title">Share</div>
          <button class="btn sm primary" onclick="generateHsShareLink()">Generate share link</button>
          <div class="share-link-box" id="hsShareLinkBox" style="display:none">
            <input class="share-link-input" id="hsShareLinkInput" readonly>
            <button class="btn sm" onclick="copyHsShareLink()">Copy</button>
          </div>
          <div id="hsShareStatus" style="font-size:12px;color:var(--gray-400)"></div>
        </div>
      </div>
    </div>
    <div class="arow">
      <button class="btn" onclick="tryGoStep(2)">← Back</button>
    </div>`;

  // Build gallery grid
  const grid = document.getElementById('hsGalleryGrid');
  if (!HS.variations.length) {
    grid.innerHTML = '<div style="font-size:13px;color:var(--gray-400);grid-column:1/-1">No variations yet.</div>';
    return;
  }

  HS.variations.forEach((v, i) => {
    const item = document.createElement('div');
    item.className = 'hs-gallery-item' + (i === 0 ? ' selected' : '');
    item.id = 'hsgal-' + v.id;
    item.setAttribute('onclick', `selectHsGallery('${v.id}')`);
    item.innerHTML = `<div class="hs-gallery-thumb" id="hsgalthumb-${v.id}"></div><div class="hs-gallery-name">${escXml(v.name)}</div>`;
    grid.appendChild(item);
  });

  HS.variations.forEach(v => {
    const el = document.getElementById('hsgalthumb-' + v.id);
    if (el) renderHoleSignInto(el, getEffectiveState(v), getEffectiveVariation(v));
  });

  if (HS.variations.length) {
    selectHsGallery(HS.variations[0].id);
  }
}

window.selectHsGallery = function (id) {
  document.querySelectorAll('.hs-gallery-item').forEach(el => el.classList.remove('selected'));
  const item = document.getElementById('hsgal-' + id);
  if (item) item.classList.add('selected');
  const v = HS.variations.find(v => v.id === id);
  const nameEl = document.getElementById('hsGallerySelectedName');
  if (nameEl && v) nameEl.textContent = v.name;
  const sel = document.getElementById('hsGallerySelected');
  if (sel && v) renderHoleSignInto(sel, getEffectiveState(v), getEffectiveVariation(v));
  window._hsGallerySelectedId = id;
};

// ── Export ─────────────────────────────────────────────────
function hsSlug(s) { return (s || 'hole-sign').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''); }
function dl(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

window.exportHsSVG = async function () {
  const id = window._hsGallerySelectedId;
  const v = HS.variations.find(v => v.id === id) || HS.variations[0];
  if (!v) return;
  const btn = document.getElementById('hsExpSvg');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const svgString = await hsBuildPortableSvg(v);
    dl(URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml' })), hsSlug(v.name) + '.svg');
  } catch (err) {
    console.error('Hole sign SVG export failed', err);
    alert('SVG export failed.');
  } finally {
    if (btn) {
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>SVG';
      btn.disabled = false;
    }
  }
};

window.exportHsPNG = async function () {
  const id = window._hsGallerySelectedId;
  const v = HS.variations.find(v => v.id === id) || HS.variations[0];
  if (!v) return;
  const btn = document.getElementById('hsExpPng');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const blob = await hsRasterize(v);
    dl(URL.createObjectURL(blob), hsSlug(v.name) + '.png');
  } catch (err) {
    console.error('Hole sign PNG export failed', err);
    alert('PNG export failed.');
  } finally {
    if (btn) {
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PNG';
      btn.disabled = false;
    }
  }
};

window.exportHsPDF = async function () {
  const id = window._hsGallerySelectedId;
  const v = HS.variations.find(v => v.id === id) || HS.variations[0];
  if (!v) return;
  const btn = document.getElementById('hsExpPdf');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const blob = await hsRasterize(v);
    const pngBytes = await blob.arrayBuffer();
    const ptW = 21.25 * 72;
    const ptH = Math.round(ptW * HS_H / HS_W);
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([ptW, ptH]);
    const pngImage = await pdfDoc.embedPng(pngBytes);
    page.drawImage(pngImage, { x: 0, y: 0, width: ptW, height: ptH });
    const pdfBytes = await pdfDoc.save();
    dl(URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' })), hsSlug(v.name) + '.pdf');
  } catch (err) {
    console.error('Hole sign PDF export failed', err);
    alert('PDF export failed.');
  } finally {
    if (btn) {
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PDF';
      btn.disabled = false;
    }
  }
};

window.exportHsAllPNG = async function () {
  for (const v of HS.variations) {
    try {
      const blob = await hsRasterize(v);
      dl(URL.createObjectURL(blob), hsSlug(v.name) + '.png');
      await new Promise(r => setTimeout(r, 400));
    } catch (err) { console.error('PNG export failed for', v.name, err); }
  }
};

// ── Print sheets ───────────────────────────────────────────
// Layout: 5 cols × 2 rows = 10 signs per sheet, each rotated 90° CW.
// Sheet: 91.25" × 42.5" @ 300 DPI. Sign native: 6375×5475 (= 21.25" × 18.25").
// After rotation, cell is 5475×6375 (= 18.25" × 21.25"), matching the grid.
const HS_PRINT = {
  cols: 5,
  rows: 2,
  perSheet: 10,
  sheetWIn: 91.25,
  sheetHIn: 42.5,
  dpi: 300,
};

// Build a 90° CW rotated PNG blob for one sign. Used for both front and back —
// the back sheet keeps the same per-sign orientation (text stays readable);
// only the cell positions change (rows are swapped).
async function buildRotatedSignPng(signCanvas) {
  const c = document.createElement('canvas');
  c.width  = HS_H;   // 5475 (rotated cell width)
  c.height = HS_W;   // 6375 (rotated cell height)
  const ctx = c.getContext('2d');
  ctx.save();
  // Rotate 90° CW: move origin to top-right, then rotate
  ctx.translate(HS_H, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(signCanvas, 0, 0);
  ctx.restore();
  return await new Promise((resolve, reject) =>
    c.toBlob(b => b ? resolve(b) : reject(new Error('rotate toBlob failed')), 'image/png'));
}

// Render the full-resolution PNG for a single variation (no rotation).
async function rasterizeSignNative(variation) {
  const str = await hsBuildPortableSvg(variation);
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = HS_W;
      c.height = HS_H;
      c.getContext('2d').drawImage(img, 0, 0, HS_W, HS_H);
      URL.revokeObjectURL(blobUrl);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

// Build two Optional Content Group "groups" on the document:
//   ▸ Thru   — contains one OCG named "Green Box" per cell (cut lines)
//   ▸ Art    — contains one OCG named "Sign" per cell (sign artwork)
// Each group head is itself an OCG so toggling the parent in Acrobat hides
// everything beneath it; individual items can also be toggled one at a time.
function createLayerGroups(doc, page, cellCount) {
  const context = doc.context;

  // Intent [View, Design] tells design tools (Illustrator, Inkscape) that the
  // OCG is editable, not just a viewer toggle. Without /Design, Illustrator
  // tends to flatten OCGs into a single layer on import.
  const intent = [PDFName.of('View'), PDFName.of('Design')];
  const ocg = (name) => context.register(context.obj({
    Type: 'OCG',
    Name: PDFString.of(name),
    Intent: intent,
  }));

  const thruHead = ocg('Thru');
  const artHead  = ocg('Art');

  const greenBoxes = [];
  const signs = [];
  for (let i = 0; i < cellCount; i++) {
    greenBoxes.push(ocg('Green Box'));
    signs.push(ocg('Sign'));
  }

  const allOcgs = [thruHead, artHead, ...greenBoxes, ...signs];
  const oc = context.obj({
    OCGs: allOcgs,
    D: {
      Order: [
        [thruHead, ...greenBoxes],
        [artHead, ...signs],
      ],
      ON: allOcgs,
      OFF: [],
      BaseState: PDFName.of('ON'),
    },
  });
  doc.catalog.set(PDFName.of('OCProperties'), oc);

  // Wire each OCG into the page resources under a short property name
  // so BDC operators can reference them by alias.
  const resources = page.node.Resources();
  const PropertiesKey = PDFName.of('Properties');
  let properties = resources.get(PropertiesKey);
  if (!properties) {
    properties = context.obj({});
    resources.set(PropertiesKey, properties);
  }

  const names = {
    thru: 'OCThru',
    art: 'OCArt',
    greenBox: [],
    sign: [],
  };
  properties.set(PDFName.of(names.thru), thruHead);
  properties.set(PDFName.of(names.art),  artHead);
  for (let i = 0; i < cellCount; i++) {
    const gb = `OCGB${i}`;
    const sg = `OCSG${i}`;
    names.greenBox.push(gb);
    names.sign.push(sg);
    properties.set(PDFName.of(gb), greenBoxes[i]);
    properties.set(PDFName.of(sg), signs[i]);
  }
  return names;
}

function beginLayer(page, layerName) {
  page.pushOperators(PDFOperator.of('BDC', [PDFName.of('OC'), PDFName.of(layerName)]));
}
function endLayer(page) {
  page.pushOperators(PDFOperator.of('EMC'));
}

window.downloadHsPrint = async function () {
  if (!HS.variations.length) { alert('No variations to export.'); return; }

  const btn = document.getElementById('hsExpPrintBtn');
  const status = document.getElementById('hsExpPrintStatus');
  const origLabel = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const setStatus = msg => { if (status) status.textContent = msg; };

  try {
    // Build flat sequence: variation repeated by its qty.
    const sequence = [];
    HS.variations.forEach(v => {
      const qty = Math.max(1, parseInt(v.qty, 10) || 1);
      for (let i = 0; i < qty; i++) sequence.push(v);
    });
    const total = sequence.length;
    if (!total) { alert('No signs to print (set Qty on variations).'); return; }
    const sheets = Math.ceil(total / HS_PRINT.perSheet);

    setStatus(`Rendering ${total} sign${total === 1 ? '' : 's'} across ${sheets} sheet${sheets === 1 ? '' : 's'}…`);

    // Render each unique variation once at native size, then re-use across cells.
    const nativeBySig = new Map();
    const sigOf = v => v.id;
    for (let i = 0; i < sequence.length; i++) {
      const v = sequence[i];
      if (nativeBySig.has(sigOf(v))) continue;
      setStatus(`Rendering variation ${nativeBySig.size + 1}/${HS.variations.length}: ${v.name}…`);
      nativeBySig.set(sigOf(v), await rasterizeSignNative(v));
    }

    // Pre-compute rotated PNG once per variation (same orientation for both sides).
    const rotated = new Map();
    for (const [sig, canvas] of nativeBySig) {
      rotated.set(sig, await buildRotatedSignPng(canvas));
    }

    // Build the PDFs.
    const ptW = HS_PRINT.sheetWIn * 72;
    const ptH = HS_PRINT.sheetHIn * 72;
    const cellWpt = ptW / HS_PRINT.cols;
    const cellHpt = ptH / HS_PRINT.rows;

    // Cut-line guide: 21" tall × 18" wide rectangle centered in each cell.
    // 1px (1pt) stroke, color #bfd730. Marks where the finished sign is trimmed
    // from the print sheet; the surrounding area is bleed.
    const CUT_W_PT = 18 * 72;
    const CUT_H_PT = 21 * 72;
    const CUT_X_OFF = (cellWpt - CUT_W_PT) / 2;
    const CUT_Y_OFF = (cellHpt - CUT_H_PT) / 2;
    const CUT_COLOR = rgb(0xbf / 255, 0xd7 / 255, 0x30 / 255);
    const drawCutLine = (page, col, row) => {
      const x = col * cellWpt + CUT_X_OFF;
      const y = (HS_PRINT.rows - 1 - row) * cellHpt + CUT_Y_OFF;
      page.drawRectangle({
        x, y,
        width: CUT_W_PT,
        height: CUT_H_PT,
        borderColor: CUT_COLOR,
        borderWidth: 1,
      });
    };

    const zip = new JSZip();

    for (let s = 0; s < sheets; s++) {
      setStatus(`Building sheet ${s + 1} of ${sheets}…`);
      const start = s * HS_PRINT.perSheet;
      const cells = sequence.slice(start, start + HS_PRINT.perSheet);

      // Front PDF
      const frontDoc = await PDFDocument.create();
      const frontPage = frontDoc.addPage([ptW, ptH]);
      const frontNames = createLayerGroups(frontDoc, frontPage, cells.length);

      // Place sign images inside the "Art" group (each named "Sign")
      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        const sig = sigOf(cells[i]);
        const pngBytes = await (rotated.get(sig)).arrayBuffer();
        const img = await frontDoc.embedPng(pngBytes);
        const x = col * cellWpt;
        const y = (HS_PRINT.rows - 1 - row) * cellHpt;
        beginLayer(frontPage, frontNames.art);
        beginLayer(frontPage, frontNames.sign[i]);
        frontPage.drawImage(img, { x, y, width: cellWpt, height: cellHpt });
        endLayer(frontPage);
        endLayer(frontPage);
      }
      // Draw cut lines inside the "Thru" group (each named "Green Box")
      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        beginLayer(frontPage, frontNames.thru);
        beginLayer(frontPage, frontNames.greenBox[i]);
        drawCutLine(frontPage, col, row);
        endLayer(frontPage);
        endLayer(frontPage);
      }
      const frontBytes = await frontDoc.save();

      // Back PDF — same per-sign orientation, but rows are swapped so that when
      // the paper is duplexed (flipped along the long edge), each cell on the
      // back aligns with its corresponding cell on the front through the paper.
      const backDoc = await PDFDocument.create();
      const backPage = backDoc.addPage([ptW, ptH]);
      const backNames = createLayerGroups(backDoc, backPage, cells.length);

      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        const sig = sigOf(cells[i]);
        const pngBytes = await (rotated.get(sig)).arrayBuffer();
        const img = await backDoc.embedPng(pngBytes);
        const swappedRow = HS_PRINT.rows - 1 - row;
        const x = col * cellWpt;
        const y = (HS_PRINT.rows - 1 - swappedRow) * cellHpt;
        beginLayer(backPage, backNames.art);
        beginLayer(backPage, backNames.sign[i]);
        backPage.drawImage(img, { x, y, width: cellWpt, height: cellHpt });
        endLayer(backPage);
        endLayer(backPage);
      }
      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        const swappedRow = HS_PRINT.rows - 1 - row;
        beginLayer(backPage, backNames.thru);
        beginLayer(backPage, backNames.greenBox[i]);
        drawCutLine(backPage, col, swappedRow);
        endLayer(backPage);
        endLayer(backPage);
      }
      const backBytes = await backDoc.save();

      const num = String(s + 1).padStart(2, '0');
      zip.file(`sheet-${num}-front.pdf`, frontBytes);
      zip.file(`sheet-${num}-back.pdf`,  backBytes);
    }

    setStatus('Zipping…');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const projName = HS.projectName ? hsSlug(HS.projectName) : 'hole-signs';
    dl(URL.createObjectURL(zipBlob), `${projName}-print-sheets.zip`);
    setStatus(`Done — ${total} signs on ${sheets} sheet${sheets === 1 ? '' : 's'} (${sheets * 2} files).`);
  } catch (err) {
    console.error('Hole sign print export failed', err);
    setStatus('Export failed: ' + (err.message || err));
    alert('Print export failed. See console for details.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origLabel || '↓ Download print sheets (zip)'; }
  }
};

async function hsInlineHrefs(svgEl) {
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  await Promise.all(Array.from(svgEl.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ctMime = (res.headers.get('content-type') ?? '').split(';')[0];
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mime = ctMime || mimeMap[ext] || 'image/png';
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is on failure */ }
  }));
}

// Fetch the Google Fonts CSS and inline each woff2 url() as a base64 data URI.
// This is required because <img src=blob:svg> can't see the host document's
// @font-face rules — without inlining, DM Sans / DM Serif Display fall back to
// generic serif/sans-serif when rasterized.
let _fontCssCache = null;
async function getEmbeddedFontCss() {
  if (_fontCssCache !== null) return _fontCssCache;
  try {
    const cssUrl = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=DM+Serif+Display&display=swap';
    const res = await fetch(cssUrl);
    let css = await res.text();
    const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+\.woff2)\)/g)].map(m => m[1]))];
    for (const url of urls) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const dataUri = `data:font/woff2;base64,${btoa(bin)}`;
        css = css.split(url).join(dataUri);
      } catch (err) { console.warn('Font fetch failed:', url, err); }
    }
    _fontCssCache = css;
    return css;
  } catch (err) {
    console.warn('Could not embed fonts:', err);
    _fontCssCache = '';
    return '';
  }
}

async function hsBuildPortableSvg(variation) {
  const { content } = makeHoleSignSvg(getEffectiveState(variation), getEffectiveVariation(variation));
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'image/svg+xml');
  await hsInlineHrefs(doc.documentElement);

  // Embed @font-face rules so DM Sans / DM Serif Display render correctly
  // when this SVG is loaded into an Image for canvas rasterization.
  const fontCss = await getEmbeddedFontCss();
  if (fontCss) {
    const svgEl = doc.documentElement;
    const ns = 'http://www.w3.org/2000/svg';
    const defs = doc.createElementNS(ns, 'defs');
    const style = doc.createElementNS(ns, 'style');
    style.setAttribute('type', 'text/css');
    style.textContent = fontCss;
    defs.appendChild(style);
    svgEl.insertBefore(defs, svgEl.firstChild);
  }

  let str = new XMLSerializer().serializeToString(doc.documentElement);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  return str;
}

async function hsRasterize(variation) {
  const str = await hsBuildPortableSvg(variation);
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = HS_W; c.height = HS_H;
      c.getContext('2d').drawImage(img, 0, 0, HS_W, HS_H);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

// ── Share ──────────────────────────────────────────────────
window.generateHsShareLink = async function () {
  const status = document.getElementById('hsShareStatus');
  if (!HS.projectId) { if (status) status.textContent = 'No project loaded.'; return; }
  if (status) status.textContent = 'Saving…';
  try {
    await saveDraftInternal();
    if (status) status.textContent = 'Generating link…';
    const token = await generateShareToken(HS.projectId);
    const url = `${window.location.origin}/review.html?token=${token}`;
    const input = document.getElementById('hsShareLinkInput');
    const box   = document.getElementById('hsShareLinkBox');
    if (input) input.value = url;
    if (box)   box.style.display = 'flex';
    if (status) status.textContent = '';
  } catch (err) {
    console.error(err);
    if (status) status.textContent = 'Could not generate link.';
  }
};

window.copyHsShareLink = function () {
  const input = document.getElementById('hsShareLinkInput');
  if (!input) return;
  input.select();
  document.execCommand('copy');
  const status = document.getElementById('hsShareStatus');
  if (status) { status.textContent = 'Copied!'; setTimeout(() => { status.textContent = ''; }, 2000); }
};

// ── Save ───────────────────────────────────────────────────
async function saveDraftInternal() {
  if (!HS.projectId) return;
  // Strip blob: URLs from logoSrcTight before persisting — they're regenerable
  // from logoArtworkBounds + logoSrc on load and would otherwise be dead refs.
  const variations = HS.variations.map(v => {
    const { logoSrcTight, ...rest } = v;
    return rest;
  });
  // Strip blob URLs from template-logo slots before persisting; they're regenerable
  // from logoArtworkBounds + logoSrc on load.
  const tplLogos = HS.templateLogos ? {
    ...HS.templateLogos,
    slots: (HS.templateLogos.slots || []).map(({ logoSrcTight, ...rest }) => rest),
  } : emptyTemplateLogos();
  await saveHoleSignConfig(HS.projectId, {
    templateStyle: HS.templateStyle,
    colors: {
      background: HS.background,
      topText:    HS.topText,
      bottomText: HS.bottomText,
      banner:     HS.banner,
      templateLogos: tplLogos,
    },
    variations,
    oneOffs: [],
  });
  if (HS.projectName) {
    await updateProject(HS.projectId, { name: HS.projectName });
  }
}

window.saveDraft = async function () {
  const btn = document.getElementById('saveDraftBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await saveDraftInternal();
    if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save draft'; btn.disabled = false; }, 2000); }
  } catch (err) {
    console.error(err);
    if (btn) { btn.textContent = 'Save failed'; setTimeout(() => { btn.textContent = 'Save draft'; btn.disabled = false; }, 2000); }
  }
};

// Expose goStep globally
window.goStep = goStep;

// ── Start ──────────────────────────────────────────────────
init();
