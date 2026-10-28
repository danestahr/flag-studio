// Vendor print layouts, keyed by the flag id they belong to. A style can ship
// several layouts (e.g. Plain: no border / colored border / colored sleeve &
// border), each its own front+back SVG pair in public/flags/print/ named
// `<printStyle>__<layout>__<front|back>.svg`.
//
// `tagKeyZone` (style level, optional): overrides the flag's tagKeyZone for v2
// views only - see render.js tagKeyZoneOf.
// `pole` names the preview pole artwork (public/flags/print/pole__<name>.svg,
// 400 x 4050) for the layout; poles are shared by every style. NB the pole
// files' names are the reverse of what they draw: pole__border is the fully
// border-colored sleeve (used by 'sleeve-border'), pole__sleeve-border the
// neutral pole with border-colored ends (used by 'border').
// `backBorderPreviewOnly`: the layout's back SVG draws the border so customers
// see it on screen, but the vendor builds the back's border by folding the
// front over it - so the back's border is stripped from the print sheet
// (print-export.js renderPrintSheetV2). The front's border always prints.
// `zones` lists the recolourable zones the layout's front draws (a layout
// without a border has no zone-border, so no Border picker). The flag's own id
// always maps to `defaultLayout`; other layouts get `<flagId>--<layout>` ids
// (see data.js) so every render path keeps resolving a plain flag id.
export const FLAG_LAYOUTS = {
  // One layout (the vendor ships Bristol with a colored sleeve & border only).
  bristol: {
    printStyle: 'bristol',
    defaultLayout: 'sleeve-border',
    layouts: [
      { id: 'sleeve-border', label: 'Colored Sleeve & Border', pole: 'border', backBorderPreviewOnly: true, zones: ['zone-primary', 'zone-secondary', 'zone-border'] },
    ],
  },
  // Ships one layout whose art includes the border and a border-colored sleeve
  // (the front's border has a Pole zone), so there is no layout picker for it.
  'south-hampton': {
    printStyle: 'south-hampton',
    defaultLayout: 'standard',
    layouts: [
      { id: 'standard', label: 'Standard', pole: 'border', backBorderPreviewOnly: true, zones: ['zone-primary', 'zone-secondary', 'zone-border'] },
    ],
  },
  york: {
    printStyle: 'york',
    defaultLayout: 'border',
    layouts: [
      { id: 'standard', label: 'Standard',       pole: 'plain',         zones: ['zone-primary', 'zone-secondary'] },
      { id: 'border',   label: 'Colored Border', pole: 'sleeve-border', backBorderPreviewOnly: true, zones: ['zone-primary', 'zone-secondary', 'zone-border'] },
    ],
  },
  ascot: {
    printStyle: 'ascot',
    tagKeyZone: 'zone-secondary', // vendor's v2 art puts the tag on the secondary stripe (legacy Ascot keeps zone-primary)
    defaultLayout: 'sleeve-border',
    layouts: [
      { id: 'standard',      label: 'Standard',                 pole: 'plain',         zones: ['zone-primary', 'zone-secondary'] },
      { id: 'border',        label: 'Colored Border',           pole: 'sleeve-border', backBorderPreviewOnly: true, zones: ['zone-primary', 'zone-secondary', 'zone-border'] },
      { id: 'sleeve-border', label: 'Colored Sleeve & Border',  pole: 'border',        backBorderPreviewOnly: true, zones: ['zone-primary', 'zone-secondary', 'zone-border'] },
    ],
  },
  edinburgh: {
    printStyle: 'edinburgh',
    defaultLayout: 'sleeve-border',
    layouts: [
      { id: 'standard',      label: 'Standard',                 pole: 'plain',         zones: ['zone-primary', 'zone-secondary'] },
      { id: 'border',        label: 'Colored Border',           pole: 'sleeve-border', backBorderPreviewOnly: true, zones: ['zone-primary', 'zone-secondary', 'zone-border'] },
      { id: 'sleeve-border', label: 'Colored Sleeve & Border',  pole: 'border',        backBorderPreviewOnly: true, zones: ['zone-primary', 'zone-secondary', 'zone-border'] },
    ],
  },
  plain: {
    printStyle: 'plain',
    defaultLayout: 'sleeve-border',
    layouts: [
      { id: 'standard',      label: 'Standard',                 pole: 'plain',         zones: ['zone-primary'] },
      { id: 'border',        label: 'Colored Border',           pole: 'sleeve-border', backBorderPreviewOnly: true, zones: ['zone-primary', 'zone-border'] },
      { id: 'sleeve-border', label: 'Colored Sleeve & Border',  pole: 'border', backBorderPreviewOnly: true, zones: ['zone-primary', 'zone-border'] },
    ],
  },
};
