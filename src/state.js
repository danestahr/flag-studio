import { COLORS } from './data.js';

// New projects default to White/Black rather than starting with no colors
// picked — matches the swatches in data.js's COLORS palette exactly so they
// render as named, selected chips instead of unmatched custom hexes.
export const DEFAULT_COLORS = { 'zone-primary': '#FFFFFF', 'zone-secondary': '#111110' };

export const S = {
  projectId: null,
  projectName: '',
  projectStatus: null,     // flag_config.status (this design's own status, not the whole project) — see status-labels.js / design_is_editable()
  flagId: null,
  colors: { ...DEFAULT_COLORS },
  customColors: [], // hex codes picked by hand (hex input/native picker/eyedropper) — offered as swatches alongside COLORS, see addCustomColor()
  library: [], // project-owned logos plus this user's cross-project shared logos (user_logos), merged — see mergeLibraries(). A shared entry is tagged `shared: true`.
  baseAssignment: {},
  variations: [],
  activeVarId: null,
  gIndex: 0,
  // "Same Front & Back Design" is per-variation (variation.sameLogoOnBothSides
  // — see flags/variations.js's toggleSameSides/sameSidesOf), not a
  // project-wide flag here.
  logoLayout: 'single',
  shareToken: null,
  feedback: [],
  gsTag: true,
  gsTagMode: 'auto',
  gsTagColor: '#ffffff',
  // Template-level free text/image layers (Step 1's "Text"/"Images" rows) —
  // same status as colors/gsTag: configured once, baked into every
  // variation's render (see render.js's paintTextLayers/paintImageLayers).
  // Distinct from a variation's own `v.textLayers` (flags/text-layers.js),
  // which stays per-variation and interactively editable from Step 4.
  textLayers: [],
  imageLayers: [],
};

export let _dragLogoId = null;
export const setDragLogoId = (id) => { _dragLogoId = id; };

export function findLogo(id) {
  return S.library.find(l => l.id === id);
}

// Combines a project's own logos with this user's cross-project shared
// library (user_logos) into the single list the UI renders as one section —
// shared entries are tagged so delete/export code can still tell them apart
// from a project-owned logo without a second array.
export function mergeLibraries(projectLogos, sharedLogos) {
  return [...projectLogos, ...sharedLogos.map(l => ({ ...l, shared: true }))];
}

// The flags wizard's steps are separate HTML pages (see CLAUDE.md's page
// map), so moving between them is a real cross-document navigation, and
// style.css's `@view-transition { navigation: auto }` makes the browser
// animate every one of those automatically. Several "Next"/sidebar-step
// handlers `await saveDraft()` before setting location.href, leaving a
// network-round-trip window where a second click (double-click, or clicking
// two different nav triggers) fires a second navigation before the first one
// resolves — the browser aborts the in-flight transition, surfacing as an
// unhandled `AbortError: Transition was skipped`. This guard makes the first
// navigation call win and ignores the rest.
let _navigating = false;
export function navigateTo(url) {
  if (_navigating) return;
  _navigating = true;
  window.location.href = url;
}

// Records a hand-picked hex (hex input, native color picker, or eyedropper) as
// a reusable swatch, skipping anything already offered — either a COLORS
// preset or a hex already saved here — so the grid never grows duplicates.
export function addCustomColor(hex) {
  if (!hex) return;
  const h = hex.toUpperCase();
  if (COLORS.some(c => c.hex.toUpperCase() === h)) return;
  if (S.customColors.some(c => c.toUpperCase() === h)) return;
  S.customColors.push(hex);
}

// COLORS presets followed by saved custom swatches, in the shape the swatch
// grid renderers expect ({hex, name}) — a custom swatch's "name" is just its
// hex since it has no friendly name.
export function allSwatches() {
  return [...COLORS, ...S.customColors.map(hex => ({ hex, name: hex }))];
}
