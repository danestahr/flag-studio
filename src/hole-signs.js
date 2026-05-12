import './style.css';
import {
  loadLogosForProject, uploadLogo,
  saveHoleSignConfig, loadHoleSignConfig,
  loadProject, updateProject, generateShareToken,
  loadOrderIntake,
} from './supabase.js';
import { HS_FONTS, HS_TEMPLATES, HS_W, HS_H } from './hole-sign-data.js';
import { makeHoleSignSvg, renderHoleSignInto, getLogoZone, escXml } from './hole-sign-render.js';

// ── State ──────────────────────────────────────────────────
const HS = {
  projectId: null,
  projectName: '',
  templateStyle: 'hole-sign-1',
  background: { type: 'color', color: '#1A3A6B', imageUrl: null, storagePath: null },
  topText:    { text: '', font: 'dm-serif', size: 300, color: '#FFFFFF' },
  bottomText: { text: '', font: 'dm-serif', size: 300, color: '#FFFFFF' },
  library: [],
  variations: [],
  activeVarId: null,
};

let _hsDragLogoId = null;

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
      if (hsCfg.variations && hsCfg.variations.length) {
        HS.variations = hsCfg.variations;
        HS.variations.forEach(v => {
          if (!v.templateId) v.templateId = HS.templateStyle;
          if (v.logoId && !v.logoSrc) {
            const lib = HS.library.find(l => l.id === v.logoId);
            if (lib) v.logoSrc = lib.src;
          }
          // Re-crop tight SVG from saved artwork bounds (blob URLs don't survive reload)
          if (v.logoSrc && v.logoArtworkBounds) {
            cropSvgToArtwork(v.logoSrc, v.logoArtworkBounds).then(tight => {
              if (tight) { v.logoSrcTight = tight.url; v.logoAspect = tight.aspect; }
            }).catch(() => {});
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
  if (n === 1) renderStep1();
  if (n === 2) renderStep2();
  if (n === 3) renderGallery();
  window.scrollTo(0, 0);
}

window.tryGoStep = (n) => {
  const cur = [...document.querySelectorAll('.panel')].findIndex(p => p.classList.contains('visible')) + 1;
  if (n > cur) return;
  goStep(n);
};

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

// ── Step 1: Design ─────────────────────────────────────────
function renderTextControls(which, textState) {
  const cap = which.charAt(0).toUpperCase() + which.slice(1);
  return `
    <div class="hs-section">
      <div class="hs-section-title">${cap === 'Top' ? 'Top' : 'Bottom'} text <span class="hs-optional">(optional)</span></div>
      <input class="hexin" style="width:100%" placeholder="Enter text…" value="${escXml(textState.text)}"
        oninput="setHsTextProp('${which}','text',this.value)">
      <div class="hs-font-btns">
        ${HS_FONTS.map(f => `<button class="hs-font-btn${textState.font === f.id ? ' active' : ''}"
          data-font="${f.id}" style="font-family:${f.family}"
          onclick="setHsTextProp('${which}','font','${f.id}')">${f.name}</button>`).join('')}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="range" min="80" max="600" value="${textState.size}"
          oninput="setHsTextProp('${which}','size',this.value)"
          style="flex:1">
        <span id="hs${cap}SizeLabel" style="font-size:12px;color:var(--gray-600);min-width:50px">${textState.size}pt</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="color" class="hs-color-swatch" value="${textState.color}"
          oninput="setHsTextProp('${which}','color',this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${textState.color}"
          oninput="setHsTextColorHex('${which}',this.value)">
      </div>
    </div>`;
}

function renderStep1() {
  const panel = document.getElementById('panel-1');
  const bg = HS.background;

  let bgControls = '';
  if (bg.type === 'color') {
    bgControls = `
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <input type="color" class="hs-color-swatch" value="${bg.color}"
          oninput="setBgColor(this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${bg.color}"
          oninput="setBgColorHex(this.value)" placeholder="#000000">
      </div>`;
  } else {
    if (bg.imageUrl) {
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
  }

  const activeTmpl = HS_TEMPLATES.find(t => t.id === HS.templateStyle) || HS_TEMPLATES[0];

  panel.innerHTML = `
    <div>
      <div class="ptitle">Design</div>
      <div class="psub">Choose a template, set the background, and configure text.</div>
    </div>
    <div class="hs-design-layout">
      <div class="hs-design-preview-col">
        <div class="hs-sign-wrap">
          <div class="hs-sign-thumb" id="hsStep1Preview"></div>
        </div>
      </div>
      <div class="hs-design-controls">
        <div class="hs-section">
          <div class="hs-section-title">Template</div>
          <div class="hs-template-grid">
            ${HS_TEMPLATES.map(t => `
              <div class="hs-template-card${HS.templateStyle === t.id ? ' active' : ''}" onclick="setHsTemplate('${t.id}')">
                <div class="hs-template-thumb" id="hs-tmpl-${t.id}"></div>
                <div class="hs-template-name">${t.name}</div>
              </div>`).join('')}
          </div>
        </div>
        <div class="hs-section">
          <div class="hs-section-title">My templates</div>
          ${(loadCustomTemplates()).length ? `
            <div class="hs-template-grid" style="margin-bottom:8px">
              ${loadCustomTemplates().map(t => `
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
        </div>
        <div class="hs-section">
          <div class="hs-section-title">Background</div>
          <div class="hs-bg-toggle">
            <button class="hs-tog-btn${bg.type === 'color' ? ' active' : ''}" onclick="setBgType('color')">Color</button>
            <button class="hs-tog-btn${bg.type === 'image' ? ' active' : ''}" onclick="setBgType('image')">Image</button>
          </div>
          ${bgControls}
        </div>
        ${activeTmpl.supportsText ? renderTextControls('top', HS.topText) : ''}
        ${activeTmpl.supportsText ? renderTextControls('bottom', HS.bottomText) : ''}
        <div class="arow">
          <div></div>
          <button class="btn primary" onclick="goStep(2)">Next: Variations →</button>
        </div>
      </div>
    </div>`;

  window.goStep = goStep;

  updateStep1Preview();
  HS_TEMPLATES.forEach(t => {
    const el = document.getElementById('hs-tmpl-' + t.id);
    if (el) renderHoleSignInto(el, HS, { templateId: t.id });
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
  } else if (key === 'font') {
    obj.font = val;
    document.querySelectorAll(`.hs-font-btn`).forEach(btn => {
      if (btn.closest('.hs-section')) {
        btn.classList.toggle('active', btn.dataset.font === val && btn.getAttribute('onclick') && btn.getAttribute('onclick').includes("'" + which + "'"));
      }
    });
    // Re-render font buttons for the right section
    const sections = document.querySelectorAll('.hs-section');
    sections.forEach(sec => {
      const btns = sec.querySelectorAll('.hs-font-btn');
      btns.forEach(btn => {
        if (btn.getAttribute('onclick') && btn.getAttribute('onclick').includes("'" + which + "'")) {
          btn.classList.toggle('active', btn.dataset.font === val);
        }
      });
    });
  } else {
    obj[key] = val;
  }
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

window.setHsTemplate = function (templateId) {
  HS.templateStyle = templateId;
  document.querySelectorAll('.hs-template-card').forEach(c => {
    c.classList.toggle('active', c.getAttribute('onclick').includes(`'${templateId}'`));
  });
  // Re-render controls to show/hide text sections
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
  renderStep1();
};

function updateStep1Preview() {
  const el = document.getElementById('hsStep1Preview');
  if (!el) return;
  renderHoleSignInto(el, HS, { templateId: HS.templateStyle });
}

// ── Step 2: Variations ─────────────────────────────────────
function renderStep2() {
  const panel = document.getElementById('panel-2');
  panel.innerHTML = `
    <div>
      <div class="ptitle">Variations</div>
      <div class="psub">Upload sponsor logos and build one variation per sponsor.</div>
    </div>
    <div class="s4layout">
      <div class="var-canvas-panel">
        <div class="var-strip-wrap">
          <div class="var-strip-label">Logo library</div>
          <div class="var-strip" id="hsLibStrip">
            <button class="var-upload-btn" title="Upload logo" onclick="document.getElementById('hsLogoFile').click()">+</button>
            <input type="file" id="hsLogoFile" accept="image/*" multiple style="display:none">
          </div>
        </div>
        <div class="hs-sign-preview" id="hsSignPreview"></div>
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
    el.innerHTML = `<img src="${logo.src}" alt="${logo.name}">`;
    el.addEventListener('click', () => addVariationForLogo(logo));
    el.addEventListener('dragstart', () => { _hsDragLogoId = logo.id; el.classList.add('dragging'); });
    el.addEventListener('dragend',   () => { _hsDragLogoId = null;    el.classList.remove('dragging'); });
    strip.appendChild(el);
  });
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
  const v = HS.variations.find(v => v.id === HS.activeVarId);
  if (!v) { row.innerHTML = ''; return; }
  const activeId = v.templateId || HS.templateStyle;
  row.innerHTML = HS_TEMPLATES.map(t => `
    <button class="hs-var-tmpl-btn${activeId === t.id ? ' active' : ''}"
      onclick="setVarTemplate('${t.id}')">${t.name}</button>`).join('');
}

window.setVarTemplate = function (templateId) {
  const v = HS.variations.find(v => v.id === HS.activeVarId);
  if (!v) return;
  v.templateId = templateId;
  renderVarList();
  renderVariationPreview();
  renderVarTmplRow();
};

function renderVarList() {
  const list = document.getElementById('hsVarList');
  if (!list) return;
  if (!HS.variations.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--gray-400);text-align:center;padding:1rem 0">No variations yet. Upload a logo to add one.</div>';
    return;
  }
  list.innerHTML = HS.variations.map(v => `
    <div class="var-card${v.id === HS.activeVarId ? ' active' : ''}" onclick="selectHsVariation('${v.id}')">
      <div class="var-card-left">
        <div class="hs-vthumb" id="hsvt-${v.id}"></div>
        <input class="vname" value="${escXml(v.name)}" onclick="event.stopPropagation()"
          onchange="renameHsVar('${v.id}',this.value)">
      </div>
      <div class="var-btns">
        <button class="vbtn" title="Delete" onclick="event.stopPropagation();deleteHsVar('${v.id}')">✕</button>
      </div>
    </div>`).join('');

  HS.variations.forEach(v => {
    const el = document.getElementById('hsvt-' + v.id);
    if (el) renderHoleSignInto(el, HS, v);
  });
}

window.renameHsVar = function (id, name) {
  const v = HS.variations.find(v => v.id === id);
  if (v) v.name = name;
  const nameEl = document.getElementById('hsActiveVarName');
  if (nameEl && HS.activeVarId === id) nameEl.textContent = name;
};

window.deleteHsVar = function (id) {
  HS.variations = HS.variations.filter(v => v.id !== id);
  if (HS.activeVarId === id) {
    HS.activeVarId = HS.variations[0]?.id || null;
  }
  updateSidebar();
  renderVarList();
  renderVariationPreview();
};

function renderVariationPreview() {
  hideHsToolbar();
  const preview = document.getElementById('hsSignPreview');
  if (!preview) return;
  preview.innerHTML = '';

  // Background SVG
  const bgSvgDiv = document.createElement('div');
  bgSvgDiv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
  renderHoleSignInto(bgSvgDiv, HS, null);
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

  const variation = HS.variations.find(v => v.id === HS.activeVarId);
  if (!variation) return;

  // Compute logo zone using this variation's template
  const lz = getLogoZone(HS, variation.templateId);
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
}

function positionWrap(wrap, ld) {
  wrap.style.left   = ld.x + '%';
  wrap.style.top    = ld.y + '%';
  wrap.style.width  = ld.w + '%';
  wrap.style.height = 'auto';
}

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
  picker.innerHTML = HS.library.length
    ? HS.library.map(l => `
        <div class="dz-lp-item${variation.logoId === l.id ? ' active' : ''}" data-lid="${l.id}" title="${l.name}">
          <img src="${l.src}" alt="${l.name}">
        </div>`).join('') + `<div class="dz-lp-upload" id="hsLpUpload">+ Upload</div>`
    : `<div class="dz-lp-upload" id="hsLpUpload">+ Upload</div>`;

  picker.querySelectorAll('.dz-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      const logo = HS.library.find(l => l.id === el.dataset.lid);
      if (!logo || !_hsActiveZone) return;
      const pickedVar = _hsActiveZone.variation;
      pickedVar.logoId = logo.id;
      pickedVar.logoSrc = logo.src;
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
}

function showHsToolbar(dz, openPicker = false) {
  ensureHsToolbar();
  const hasLogo = !!_hsActiveZone?.variation?.logoSrc;
  document.getElementById('hsTbFill').style.display    = hasLogo ? '' : 'none';
  document.getElementById('hsTbFillSep').style.display = hasLogo ? '' : 'none';
  document.getElementById('hsTbRemove').style.display  = hasLogo ? '' : 'none';
  document.getElementById('hsTbSep').style.display     = hasLogo ? '' : 'none';
  document.getElementById('hsTbReplace').textContent   = hasLogo ? 'Replace ▾' : 'Choose logo ▾';

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
          <button class="btn sm" onclick="exportHsSVG()">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>SVG
          </button>
          <button class="btn sm" id="hsExpPng" onclick="exportHsPNG()">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PNG
          </button>
        </div>
        <button class="btn sm" style="width:100%;justify-content:center" onclick="exportHsAllPNG()">Export all PNG</button>
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
    if (el) renderHoleSignInto(el, HS, v);
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
  if (sel && v) renderHoleSignInto(sel, HS, v);
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

window.exportHsSVG = function () {
  const id = window._hsGallerySelectedId;
  const v = HS.variations.find(v => v.id === id) || HS.variations[0];
  if (!v) return;
  const { content } = makeHoleSignSvg(HS, v);
  dl(URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' })), hsSlug(v.name) + '.svg');
};

window.exportHsPNG = function () {
  const id = window._hsGallerySelectedId;
  const v = HS.variations.find(v => v.id === id) || HS.variations[0];
  if (!v) return;
  const btn = document.getElementById('hsExpPng');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  hsSvgToPng(v, url => {
    dl(url, hsSlug(v.name) + '.png');
    if (btn) {
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PNG';
      btn.disabled = false;
    }
  });
};

window.exportHsAllPNG = async function () {
  for (const v of HS.variations) {
    await new Promise(res => hsSvgToPng(v, url => { dl(url, hsSlug(v.name) + '.png'); res(); }));
    await new Promise(r => setTimeout(r, 300));
  }
};

function hsSvgToPng(variation, cb) {
  const { content } = makeHoleSignSvg(HS, variation);
  const blob = new Blob([content], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = 6375; c.height = 5475;
    c.getContext('2d').drawImage(img, 0, 0, 6375, 5475);
    URL.revokeObjectURL(url);
    c.toBlob(b => cb(URL.createObjectURL(b)), 'image/png');
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert('PNG export failed — ensure logos are accessible.'); };
  img.src = url;
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
  await saveHoleSignConfig(HS.projectId, {
    templateStyle: HS.templateStyle,
    colors: {
      background: HS.background,
      topText:    HS.topText,
      bottomText: HS.bottomText,
    },
    variations: HS.variations,
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
