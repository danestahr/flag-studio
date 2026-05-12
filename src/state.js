export const S = {
  projectId: null,
  projectName: '',
  flagId: null,
  colors: {},
  library: [],
  baseAssignment: {},
  variations: [],
  activeVarId: null,
  gIndex: 0,
  sameLogoOnBothSides: true,
  shareToken: null,
  feedback: [],
};

export let _dragLogoId = null;
export const setDragLogoId = (id) => { _dragLogoId = id; };
