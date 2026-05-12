export const COLORS = [
  {hex:'#1A3A6B',name:'Navy'},{hex:'#C8102E',name:'Scarlet'},{hex:'#006747',name:'Masters Green'},
  {hex:'#C8972A',name:'Gold'},{hex:'#111110',name:'Black'},{hex:'#FFFFFF',name:'White'},
  {hex:'#6B2D8B',name:'Purple'},{hex:'#0072CE',name:'Royal Blue'},{hex:'#E87722',name:'Orange'},
  {hex:'#8B0000',name:'Burgundy'},{hex:'#C0C0C0',name:'Silver'},{hex:'#E8D5A3',name:'Cream'},
];

// svgContent, viewBox, and logoZones are populated at startup by svgLoader.loadAllFlags()
export const FLAGS = [
  {
    id: 'edinburgh', name: 'Edinburgh',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Stripe border' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
  {
    id: 'ascot', name: 'Ascot',
    colorZones: [
      { id: 'zone-primary',   label: 'Field' },
      { id: 'zone-secondary', label: 'Stripe border' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
  {
    id: 'plain', name: 'Plain',
    colorZones: [
      { id: 'zone-primary', label: 'Field' },
    ],
    svgContent: '', viewBox: '0 0 7519 4670', logoZones: [],
  },
];
