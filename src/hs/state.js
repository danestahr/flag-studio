import { HS_FONTS, emptyBanner, emptyTemplateLogos } from '../hole-sign-data.js';
import { eyedropperBtn as sharedEyedropperBtn, pickEyedropperColor } from '../eyedropper.js';

// Tracks which caption slots the user has actually typed into (as opposed to
// still holding whichever placeholder text the current template shipped
// with), so switching templates only carries forward real user text — see
// captureUserCaptions()/restoreUserCaptions() in design.js.
export function defaultCaptionsEdited() {
  return { primary: false, primarySub: false, secondary: false, secondarySub: false };
}

// ── State ──────────────────────────────────────────────────
export const HS = {
  projectId: null,
  projectName: '',
  projectStatus: null,   // projects.status — see status-labels.js / project_is_editable()
  customerInfo: {},       // projects.customer_info, loaded once at init.js:init()
  hasFlagConfig: false,   // whether this project already has a flag_config row (export.js cross-sell check)
  templateStyle: 'hole-sign-1',
  background: { type: 'color', color: '#FFFFFF', imageUrl: null, storagePath: null },
  topText:    { text: 'Sponsored By', font: 'dm-serif', size: 300, color: '#111110' },
  bottomText: { text: '', font: 'dm-serif', size: 300, color: '#111110' },
  bannerTop:    emptyBanner(),
  bannerBottom: emptyBanner(),
  captionsEdited: defaultCaptionsEdited(),
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
  // { key, values: { field: value } } snapshot of a section's own draft
  // fields, taken the moment it's opened (openHsVarMenu) — lets that
  // section's Cancel/Back revert just its own fields without touching
  // anything else the draft is mid-editing elsewhere (var-editor.js).
  hsVarSectionSnapshot: null,
  // True only while the full pencil-editor side panel is open (between
  // startEditVar/applyEditVar|cancelEditVar). A quick-edit click (see
  // beginQuickEdit in var-editor.js) also sets HS.editingVarId/editingDraft
  // to write into a draft, but leaves this false — without it, a re-render
  // mid quick-edit (e.g. typing triggers one) would see
  // HS.editingVarId === HS.activeVarId and mistake the silent draft for a
  // full editor session, upgrading the locked canvas into the unlocked one.
  hsFullEditorOpen: false,
  canvasEdit: null,          // { kind, caret } — text band edited inline
  canvasSelectedKind: null,  // 'top' | 'bottom' — text band selected (highlighted) but not yet inline-editing
  canvasRerendering: false,  // true while a live re-render swaps the input
  tlSelectedIdxs: new Set(), // selected template-logo slot indices (shift-click multi-select)
  tlPickerEl: null,          // open template-logo picker element
  tlJustDragged: false,      // suppress click right after a slot drag
  hsZoom: 100,               // Step-2 preview zoom %
  hsStep1Zoom: 100,          // Step-1 preview zoom %
  hsActiveZone: null,        // active variation drop zone for the toolbar — { dzone, wrap, variation, layerId } (layerId set only for a selected logo layer, see activeLogoLayer() in logo-utils.js)
  activeDefaultId: null,     // selected default hole sign id (mutually exclusive with HS.activeVarId)
  fontCssCache: null,        // cached embedded-font @font-face CSS
  activeTextLayerId: null,   // id of the currently selected text layer overlay
  editingTextLayerId: null,  // id of the text layer currently being edited inline
  isStaffOrAdmin: false,     // gates the "Email PDF sheet link" action in export.js
  // Set by editCustomTemplate (design.js) when entering the editor via a
  // "My templates" card's "Edit template" corner badge, rather than picking
  // it via a plain click (which just applies it, same as any other
  // template). While set, every design edit auto-saves — forking a new "My
  // templates" entry on the first change, then updating that same fork in
  // place — without touching the original template. hsCustomTemplateForkId
  // is that fork's id once it exists (null until the first auto-save).
  hsEditingCustomTemplateId: null,
  hsCustomTemplateForkId: null,
  hsLocked: false,           // non-admin customer + project past draft/needs_changes - blocks goStep(1/2), set in app.js:init() once HS.projectStatus is known
  hsSubmitContact: null,     // draft contact/shipping fields for the Gallery & export submit form
  hsSubmitAcks: { deadline: false },
  hsSubmitErrors: {},
  hsSubmitting: false,
  hsCrossSellDismissed: false,
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
// Legacy `topText`/`subText` (removed from the banner shape — see emptyBanner)
// are stripped out here rather than merged, so stray keys from old saved data
// don't leak onto the result; callers that need to preserve that legacy text
// should run it through migrateBannerCaptions() before calling mergeBanner.
export function mergeBanner(b) {
  const base = emptyBanner();
  if (!b) return base;
  const { topText, subText, ...rest } = b;
  return { ...base, ...rest, bg: { ...base.bg, ...(b.bg || {}) } };
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

  // Quick-edit sparse content overrides (see beginQuickEdit/applyQuick* in
  // var-editor.js) — unlike v.template/v.textLayers above, which snapshot an
  // entire object (position, layout, everything) the moment ANY field
  // differs, these layer just the one piece of content the user actually
  // picked (an image, a line of text) onto whatever templateLogos/
  // background/textLayers just resolved to. That keeps position/layout
  // reactive to later template changes for a variation that only ever
  // quick-edited content, never position — the whole point of "position
  // stays locked" quick-edit is that it never becomes a position override.
  if (v.templateLogoOverrides) {
    const slots = (out.templateLogos?.slots || []).map((s, i) => {
      const ov = v.templateLogoOverrides[i];
      return ov ? { ...s, ...ov } : s;
    });
    out.templateLogos = { ...out.templateLogos, slots };
  }
  if (v.backgroundOverride) {
    out.background = { ...out.background, ...v.backgroundOverride };
  }
  if (v.textLayerOverrides) {
    out.textLayers = (out.textLayers || []).map(l => {
      const ov = v.textLayerOverrides[l.id];
      return ov ? { ...l, ...ov } : l;
    });
  }
  return out;
}

// Whether `v` carries any per-variation customization at all — the full
// snapshot overrides (v.template/v.textLayers/v.sponsorText) plus the
// sparse quick-edit content overrides (see getEffectiveState above).
export function isVarCustomized(v) {
  return !!(v.template || v.sponsorText || v.templateLogoOverrides || v.backgroundOverride || v.textLayerOverrides);
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

// A variation's logo/sponsor-text content stacks against the rest of the sign
// on a 3-tier axis: below the background, below the template frame (banners/
// text/template logos — the default), or above the frame. Stored as two
// booleans (`belowBackground`/`aboveFrame`, mutually exclusive) rather than
// one enum so old saved variations with only `aboveFrame` set keep working
// without a migration.
//
// getVariationLayer/setVariationLayer are generic over anything carrying
// those two booleans, not just variations — free text layers and template-
// image slots reuse them too (see HS_FRAME_LAYER_ORDER below), just capped to
// a 2-item order so that template-owned content can never sink below the
// background the way variation content can.
export const HS_LAYER_ORDER = ['below-bg', 'below-frame', 'above-frame'];
export const HS_LAYER_LABELS = { 'below-bg': 'Below Background', 'below-frame': 'Below Template', 'above-frame': 'Above Template' };
export const HS_FRAME_LAYER_ORDER = ['below-frame', 'above-frame'];

export function getVariationLayer(v) {
  if (v?.belowBackground) return 'below-bg';
  if (v?.aboveFrame) return 'above-frame';
  return 'below-frame';
}

export function setVariationLayer(v, layer) {
  v.belowBackground = layer === 'below-bg';
  v.aboveFrame = layer === 'above-frame';
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

