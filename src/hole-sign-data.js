export const HS_W = 6375;
export const HS_H = 5475;
export const HS_MARGIN = 150;
export const HS_GAP = 75;

export const HS_FONTS = [
  { id: 'dm-serif', name: 'DM Serif',  family: "'DM Serif Display', serif" },
  { id: 'dm-sans',  name: 'DM Sans',   family: "'DM Sans', sans-serif" },
  { id: 'georgia',  name: 'Georgia',   family: 'Georgia, serif' },
];

export const HS_TEMPLATES = [
  { id: 'hole-sign-1',            name: 'Standard',     description: 'Logo centered, optional top & bottom text', supportsText: true  },
  { id: 'hole-sign-logo-only',    name: 'Logo only',    description: 'Logo fills the entire sign',               supportsText: false },
  { id: 'hole-sign-full-graphic', name: 'Full graphic', description: 'Pre-designed graphic fills the entire canvas, no text or overlays', supportsText: false },
];

// Template-logo slot height range (in sign coordinates, HS_H = 5475).
// `size` on a templateLogos config is a numeric slot height. Slots are 2:1, so
// the slot width is 2 × `size`.
export const HS_TPL_LOGO_MIN = 220;
export const HS_TPL_LOGO_MAX = 1400;
export const HS_TPL_LOGO_DEFAULT = 700;

// Legacy preset map — used only to migrate older saved configs that stored
// 'sm'/'md'/'lg' string values into the new numeric scheme.
const LEGACY_SIZES = { sm: 420, md: 700, lg: 980 };

export function normalizeTplLogoSize(v) {
  if (typeof v === 'number' && isFinite(v)) {
    return Math.max(HS_TPL_LOGO_MIN, Math.min(HS_TPL_LOGO_MAX, Math.round(v)));
  }
  if (typeof v === 'string' && LEGACY_SIZES[v]) return LEGACY_SIZES[v];
  return HS_TPL_LOGO_DEFAULT;
}

export function emptyTemplateLogos() {
  return { count: 0, size: HS_TPL_LOGO_DEFAULT, vAlign: 'top', hAlign: 'spread', stack: 'horizontal', slots: [] };
}

// Banner band — a full-width strip at the top or bottom of the sign. Has its
// own text, subtext, and bg (color or image). Banner heights are in sign
// coordinates so the slider semantics match the template-logo size slider.
export const HS_BANNER_MIN_H = 300;
export const HS_BANNER_MAX_H = HS_H; // up to the full sign height
export const HS_BANNER_DEFAULT_H = 700;

export function emptyBanner() {
  return {
    enabled: false,
    height: HS_BANNER_DEFAULT_H,
    spacing: 0,
    bg: { type: 'color', color: '#E5E5E5', imageUrl: null, storagePath: null, imageX: 50, imageY: 50, imageScale: 100 },
    topText: { text: '', font: 'dm-serif', size: 260, color: '#111110' },
    subText: { text: '', font: 'dm-sans',  size: 140, color: '#111110' },
  };
}
