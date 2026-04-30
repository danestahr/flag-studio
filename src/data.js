export const COLORS = [
  {hex:'#1A3A6B',name:'Navy'},{hex:'#C8102E',name:'Scarlet'},{hex:'#006747',name:'Masters Green'},
  {hex:'#C8972A',name:'Gold'},{hex:'#111110',name:'Black'},{hex:'#FFFFFF',name:'White'},
  {hex:'#6B2D8B',name:'Purple'},{hex:'#0072CE',name:'Royal Blue'},{hex:'#E87722',name:'Orange'},
  {hex:'#8B0000',name:'Burgundy'},{hex:'#C0C0C0',name:'Silver'},{hex:'#E8D5A3',name:'Cream'},
];

const EDINBURGH_SVG = `<g id="Edinburgh">
<rect id="zone-primary" y="1.00012" width="7519" height="4669" fill="#D9D9D9"/>
<g id="zone-secondary">
  <rect y="4210" width="7507" height="460" fill="#FC0101"/>
  <rect x="5280" y="4662" width="4662" height="2227" transform="rotate(-90 5280 4662)" fill="#FC0101"/>
  <rect y="1.00012" width="7507" height="460" fill="#FC0101"/>
</g>
<g id="Bleed">
  <rect x="0.5" y="1.5" width="7518" height="309" fill="#9A9A9A" stroke="#9A9A9A"/>
  <rect x="0.5" y="4669.5" width="4668" height="1205" transform="rotate(-90 0.5 4669.5)" fill="#9A9A9A" stroke="#9A9A9A"/>
  <rect x="7209.5" y="4669.5" width="4668" height="309" transform="rotate(-90 7209.5 4669.5)" fill="#9A9A9A" stroke="#9A9A9A"/>
  <rect x="0.5" y="4360.5" width="7518" height="309" fill="#9A9A9A" stroke="#9A9A9A"/>
</g>
</g>`;

const ASCOT_SVG = `<g id="Ascot">
<rect id="zone-primary" y="1.00037" width="7519" height="4669" fill="#D9D9D9"/>
<g id="zone-secondary">
  <rect y="4210" width="7507" height="460" fill="#FC0101"/>
  <rect x="7060" y="4662" width="4662" height="459" transform="rotate(-90 7060 4662)" fill="#FC0101"/>
  <rect y="4662" width="4662" height="4207" transform="rotate(-90 0 4662)" fill="#FC0101"/>
  <rect y="1.00037" width="7507" height="460" fill="#FC0101"/>
</g>
<g id="Bleed">
  <rect x="0.5" y="1.5" width="7518" height="309" fill="#9A9A9A" stroke="#9A9A9A"/>
  <rect x="0.5" y="4669.5" width="4668" height="1205" transform="rotate(-90 0.5 4669.5)" fill="#9A9A9A" stroke="#9A9A9A"/>
  <rect x="7209.5" y="4669.5" width="4668" height="309" transform="rotate(-90 7209.5 4669.5)" fill="#9A9A9A" stroke="#9A9A9A"/>
  <rect x="0.5" y="4360.5" width="7518" height="309" fill="#9A9A9A" stroke="#9A9A9A"/>
</g>
</g>`;

const PLAIN_SVG = `<g id="Plain">
<rect id="zone-primary" x="0.000244141" width="7519" height="4669" fill="#D9D9D9"/>
<g id="Bleed">
  <rect x="0.5" y="0.5" width="7518" height="309" fill="#9A9A9A" stroke="#9A9A9A"/>
  <rect x="0.5" y="4668.5" width="4668" height="1205" transform="rotate(-90 0.500244 4668.5)" fill="#9A9A9A" stroke="#9A9A9A"/>
  <rect x="7209.5" y="4668.5" width="4668" height="309" transform="rotate(-90 7209.5 4668.5)" fill="#9A9A9A" stroke="#9A9A9A"/>
  <rect x="0.5" y="4359.5" width="7518" height="309" fill="#9A9A9A" stroke="#9A9A9A"/>
</g>
</g>`;

export const FLAGS = [
  {
    id: 'edinburgh', name: 'Edinburgh',
    viewBox: '0 0 7519 4670',
    colorZones: [
      {id:'zone-primary',   label:'Field'},
      {id:'zone-secondary', label:'Stripe border'},
    ],
    logoZones: [
      { id:'lz-main', label:'Logo', x:1406, y:661, w:3654, h:3349 },
    ],
    svgContent: EDINBURGH_SVG,
  },
  {
    id: 'ascot', name: 'Ascot',
    viewBox: '0 0 7519 4670',
    colorZones: [
      {id:'zone-primary',   label:'Field'},
      {id:'zone-secondary', label:'Stripe border'},
    ],
    logoZones: [
      { id:'lz-main', label:'Logo', x:4407, y:661, w:2400, h:3349 },
    ],
    svgContent: ASCOT_SVG,
  },
  {
    id: 'plain', name: 'Plain',
    viewBox: '0 0 7519 4669',
    colorZones: [
      {id:'zone-primary', label:'Field'},
    ],
    logoZones: [
      { id:'lz-main', label:'Logo', x:1406, y:660, w:5454, h:3349 },
    ],
    svgContent: PLAIN_SVG,
  },
];
