export const S = {
  orderId: null,
  flagId: null,
  colors: {},
  library: [],        // [{id, name, src}]
  baseAssignment: {}, // {zoneId: logoId}
  variations: [],     // [{id, name, assignment: {zoneId: logoId}}]
  activeVarId: null,
  gIndex: 0,
};

export let _dragLogoId = null;
export const setDragLogoId = (id) => { _dragLogoId = id; };
