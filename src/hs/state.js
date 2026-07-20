import { HS_FONTS, emptyBanner, emptyTemplateLogos } from '../hole-sign-data.js';
import { eyedropperBtn as sharedEyedropperBtn, pickEyedropperColor } from '../eyedropper.js';

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
  textLayers: [],
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
  activeTextLayerId: null,   // id of the currently selected text layer overlay
  editingTextLayerId: null,  // id of the text layer currently being edited inline
};


// Picks a screen color and dispatches an `input` event on the target
// <input type=color>, so the existing oninput handler fires the normal
// color-change path.
export function eyedropperBtn(inputId) {
  return sharedEyedropperBtn(`runEyedropper('${inputId}')`);
}
window.runEyedropper = async function (inputId) {
  const hex = await pickEyedropperColor();
  if (!hex) return;
  const inp = document.getElementById(inputId);
  if (!inp) return;
  inp.value = hex;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
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
  if (v.textLayers !== undefined) out.textLayers = v.textLayers;
  if (HS.editingVarId === v.id && HS.editingDraft) {
    const d = HS.editingDraft;
    if (d.templateStyle) out.templateStyle = d.templateStyle;
    if (d.background)    out.background    = d.background;
    if (d.topText)       out.topText       = d.topText;
    if (d.bottomText)    out.bottomText    = d.bottomText;
    if (d.bannerTop)    out.bannerTop    = d.bannerTop;
    if (d.bannerBottom) out.bannerBottom = d.bannerBottom;
    if (d.templateLogos) out.templateLogos = d.templateLogos;
    if (d.textLayers !== undefined) out.textLayers = d.textLayers;
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

const ALIGN_LEFT_ICON   = `<i class="fa-solid fa-align-left" aria-hidden="true"></i>`;
const ALIGN_CENTER_ICON = `<i class="fa-solid fa-align-center" aria-hidden="true"></i>`;
const ALIGN_RIGHT_ICON  = `<i class="fa-solid fa-align-right" aria-hidden="true"></i>`;

// After clicking an alignment button, directly toggle the active class on all
// visible alignment toggle buttons. Alignment buttons are identified by having
// ,'align', in their onclick attribute — this distinguishes them from other
// toggle groups (Color/Image, On/Off) that share the same .hs-tog-btn class.
export function syncAlignBtns(val) {
  document.querySelectorAll('.hs-bg-toggle .hs-tog-btn').forEach(btn => {
    const oc = btn.getAttribute('onclick') || '';
    if (!oc.includes(",'align',")) return;
    btn.classList.toggle('active', oc.endsWith(`,'${val}')`));
  });
}

// Align toggle buttons using icons. `setter` is a partial call string up to
// (but not including) the value arg+closing paren.
export function alignBtns(align, setter) {
  const a = align || 'center';
  return `
    <div class="hs-bg-toggle">
      <button class="hs-tog-btn hs-tog-icon-btn${a === 'left'   ? ' active' : ''}" onclick="${setter},'left')"   title="Left align">${ALIGN_LEFT_ICON}</button>
      <button class="hs-tog-btn hs-tog-icon-btn${a === 'center' ? ' active' : ''}" onclick="${setter},'center')" title="Center">${ALIGN_CENTER_ICON}</button>
      <button class="hs-tog-btn hs-tog-icon-btn${a === 'right'  ? ' active' : ''}" onclick="${setter},'right')"  title="Right align">${ALIGN_RIGHT_ICON}</button>
    </div>`;
}

