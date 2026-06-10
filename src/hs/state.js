import { HS_FONTS, emptyBanner, emptyTemplateLogos } from '../hole-sign-data.js';
import { escXml } from '../hole-sign-render.js';

// ── State ──────────────────────────────────────────────────
export const HS = {
  projectId: null,
  projectName: '',
  templateStyle: 'hole-sign-1',
  background: { type: 'color', color: '#FFFFFF', imageUrl: null, storagePath: null },
  topText:    { text: 'Sponsored By', font: 'dm-serif', size: 300, color: '#111110' },
  bottomText: { text: '', font: 'dm-serif', size: 300, color: '#111110' },
  bannerTop:    emptyBanner(),
  bannerBottom: emptyBanner(),
  templateLogos: emptyTemplateLogos(),
  library: [],
  variations: [],
  defaults: [],      // selected default hole signs for this project
  activeVarId: null,
  editingVarId: null,
  editingDraft: null,
  feedback: [],
};

// Ephemeral UI state shared across the editor modules. Kept as object
// properties (not module-level `let`s) so any module can mutate them by
// reference — ES `export let` bindings can't be reassigned by importers.
export const UI = {
  hsDragLogoId: null,        // library logo being dragged onto a drop zone
  hsFeedbackChannel: null,   // Supabase realtime channel for feedback
  hsMenu: null,              // open Step-1 design section key (or null = list)
  hsMenuAnimate: false,      // animate the menu slide on navigation only
  hsVarMenu: null,           // open per-variation editor section key
  hsVarMenuAnimate: false,
  qaLogosOpen: null,         // quick-add logos popover position
  canvasEdit: null,          // { kind, caret } — text band edited inline
  canvasRerendering: false,  // true while a live re-render swaps the input
  tlSelectedIdx: null,       // selected template-logo slot index
  tlPickerEl: null,          // open template-logo picker element
  tlJustDragged: false,      // suppress click right after a slot drag
  hsZoom: 100,               // Step-2 preview zoom %
  hsStep1Zoom: 100,          // Step-1 preview zoom %
  hsActiveZone: null,        // active variation drop zone for the toolbar
  activeDefaultId: null,     // selected default hole sign id (mutually exclusive with HS.activeVarId)
  fontCssCache: null,        // cached embedded-font @font-face CSS
};


// Browser eyedropper (Chrome/Edge ≥ 95). Picks a screen color and dispatches an
// `input` event on the target <input type=color>, so the existing oninput
// handler fires the normal color-change path.
const SUPPORTS_EYEDROPPER = typeof window !== 'undefined' && 'EyeDropper' in window;
const EYEDROPPER_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 7l6 6"/><path d="M14 4l3 3a2.121 2.121 0 0 1 0 3l-1.5 1.5-6-6L11 4a2.121 2.121 0 0 1 3 0z"/><path d="M9.5 8.5L3 15v3h3l6.5-6.5"/></svg>`;
export function eyedropperBtn(inputId) {
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
export function mergeBanner(b) {
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
export function getEffectiveState(v) {
  if (!v) return HS;
  const out = { ...HS };
  if (v.template) {
    if (v.template.templateStyle) out.templateStyle = v.template.templateStyle;
    if (v.template.background)    out.background    = v.template.background;
    if (v.template.topText)       out.topText       = v.template.topText;
    if (v.template.bottomText)    out.bottomText    = v.template.bottomText;
    if (v.template.bannerTop)    out.bannerTop    = v.template.bannerTop;
    if (v.template.bannerBottom) out.bannerBottom = v.template.bannerBottom;
    if (v.template.templateLogos) out.templateLogos = v.template.templateLogos;
  }
  if (HS.editingVarId === v.id && HS.editingDraft) {
    const d = HS.editingDraft;
    if (d.templateStyle) out.templateStyle = d.templateStyle;
    if (d.background)    out.background    = d.background;
    if (d.topText)       out.topText       = d.topText;
    if (d.bottomText)    out.bottomText    = d.bottomText;
    if (d.bannerTop)    out.bannerTop    = d.bannerTop;
    if (d.bannerBottom) out.bannerBottom = d.bannerBottom;
    if (d.templateLogos) out.templateLogos = d.templateLogos;
  }
  return out;
}

// Returns a variation-shaped object with the editing draft's sponsorText
// merged in, so live previews of the variation being edited reflect
// unsaved sponsor text changes.
export function getEffectiveVariation(v) {
  if (!v) return v;
  if (HS.editingVarId === v.id && HS.editingDraft && 'sponsorText' in HS.editingDraft) {
    return { ...v, sponsorText: HS.editingDraft.sponsorText };
  }
  return v;
}

// Font picker as a dropdown (scales as more fonts are added). `onchange` is the
// inline handler body receiving `this.value`.
export function fontSelect(onchange, current) {
  return `<select class="tl-select hs-font-select" onchange="${onchange}">
    ${HS_FONTS.map(f => `<option value="${f.id}"${current === f.id ? ' selected' : ''}>${f.name}</option>`).join('')}
  </select>`;
}

// Align toggle buttons. `setter` is a partial call string up to (but not
// including) the value arg+closing paren, e.g. "setHsTextProp('top','align'".
// Each button appends ,'left'/'center'/'right') to complete the call.
export function alignBtns(align, setter) {
  const a = align || 'center';
  return `
    <div class="hs-bg-toggle">
      <button class="hs-tog-btn${a === 'left'   ? ' active' : ''}" onclick="${setter},'left')"   title="Left align">Left</button>
      <button class="hs-tog-btn${a === 'center' ? ' active' : ''}" onclick="${setter},'center')" title="Center">Center</button>
      <button class="hs-tog-btn${a === 'right'  ? ' active' : ''}" onclick="${setter},'right')"  title="Right align">Right</button>
    </div>`;
}

// ── Step 1: Design ─────────────────────────────────────────
export function renderTextControls(which, textState) {
  const cap = which.charAt(0).toUpperCase() + which.slice(1);
  return `
    <div class="hs-section">
      <div class="hs-section-title">${cap === 'Top' ? 'Text' : 'Bottom text'} <span class="hs-optional">(optional)</span></div>
      <input class="hexin" style="width:100%" placeholder="Write Here..." value="${escXml(textState.text)}"
        oninput="setHsTextProp('${which}','text',this.value)">
      ${fontSelect(`setHsTextProp('${which}','font',this.value)`, textState.font)}
      ${alignBtns(textState.align, `setHsTextProp('${which}','align'`)}
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
