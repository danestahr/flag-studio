// New projects default to White/Black rather than starting with no colors
// picked — matches the swatches in data.js's COLORS palette exactly so they
// render as named, selected chips instead of unmatched custom hexes.
export const DEFAULT_COLORS = { 'zone-primary': '#FFFFFF', 'zone-secondary': '#111110' };

export const S = {
  projectId: null,
  projectName: '',
  projectStatus: null,     // projects.status — see status-labels.js / project_is_editable()
  hasHoleSignConfig: false, // whether this project already has a hole_sign_config row (gallery.js cross-sell check)
  flagId: null,
  colors: { ...DEFAULT_COLORS },
  library: [],
  baseAssignment: {},
  variations: [],
  activeVarId: null,
  gIndex: 0,
  sameLogoOnBothSides: true,
  logoLayout: 'single',
  shareToken: null,
  feedback: [],
  gsTag: true,
  gsTagMode: 'auto',
  gsTagColor: '#ffffff',
};

export let _dragLogoId = null;
export const setDragLogoId = (id) => { _dragLogoId = id; };
