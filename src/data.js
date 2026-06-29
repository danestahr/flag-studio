export const COLORS = [
  {hex:'#1A3A6B',name:'Navy'},{hex:'#C8102E',name:'Scarlet'},{hex:'#006747',name:'Masters Green'},
  {hex:'#C8972A',name:'Gold'},{hex:'#111110',name:'Black'},{hex:'#FFFFFF',name:'White'},
  {hex:'#6B2D8B',name:'Purple'},{hex:'#0072CE',name:'Royal Blue'},{hex:'#E87722',name:'Orange'},
  {hex:'#8B0000',name:'Burgundy'},{hex:'#C0C0C0',name:'Silver'},{hex:'#E8D5A3',name:'Cream'},
];

// svgContent, viewBox, and logoZones are populated at startup by svgLoader.loadAllFlags()
export const FLAGS = [
  {
    id: 'plain', name: 'Plain',
    tagKeyZone: 'zone-primary',
    colorZones: [
      { id: 'zone-primary', label: 'Field' },
    ],
    svgContent: '', viewBox: '0 0 7519 4669', logoZones: [],
  },
  {
    id: 'edinburgh', name: 'Edinburgh',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Stripe border' },
    ],
    svgContent: '', viewBox: '0 0 7519 4669', logoZones: [],
  },
  {
    id: 'ascot', name: 'Ascot',
    tagKeyZone: 'zone-secondary',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Stripe border' },
    ],
    svgContent: '', viewBox: '0 0 7519 4669', logoZones: [],
  },
  {
    id: 'bristol', name: 'Bristol',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Accent' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
  {
    id: 'checkered', name: 'Checkered',
    tagKeyZone: 'zone-secondary',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Checker' },
    ],
    svgContent: '', viewBox: '0 0 7519 4671', logoZones: [],
  },
  {
    id: 'checkered-logo', name: 'Checkered Logo',
    tagKeyZone: 'zone-secondary',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Checker' },
    ],
    svgContent: '', viewBox: '0 0 7519 4671', logoZones: [],
  },
  {
    id: 'diagonal', name: 'Diagonal',
    tagKeyZone: 'zone-secondary',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Diagonal' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
  {
    id: 'new-castle', name: 'New Castle',
    tagKeyZone: 'zone-secondary',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Accent' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
  {
    id: 'shefield', name: 'Shefield',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Accent' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
  {
    id: 'south-hampton', name: 'South Hampton',
    tagKeyZone: 'zone-secondary',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Accent' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
  {
    id: 'windsor', name: 'Windsor',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Accent' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
  {
    id: 'york', name: 'York',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Accent' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
  {
    id: '5-chex-on-left', name: '5-Chex on Left',
    tagKeyZone: 'zone-secondary',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Accent' },
    ],
    svgContent: '', viewBox: '0 0 7519 4671', logoZones: [],
  },
  {
    id: 'triple-triangle', name: 'Triple Triangle',
    tagKeyZone: 'zone-secondary',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Accent' },
    ],
    svgContent: '', viewBox: '0 0 7519 4672', logoZones: [],
  },
  {
    id: 'pennant', name: 'Pennant',
    tagKeyZone: 'zone-primary',
    colorZones: [
      { id: 'zone-primary', label: 'Field' },
    ],
    svgContent: '', viewBox: '0 0 7519 4669', logoZones: [],
  },
  {
    id: 'swallow-tail', name: 'Swallow Tail',
    tagKeyZone: 'zone-primary',
    colorZones: [
      { id: 'zone-primary', label: 'Field' },
    ],
    svgContent: '', viewBox: '0 0 7520 4669', logoZones: [],
  },
  {
    id: 'american-flag', name: 'American Flag',
    colorZones: [],
    noColors: true,
    svgContent: '', viewBox: '0 0 7519 4671', logoZones: [],
  },
];
