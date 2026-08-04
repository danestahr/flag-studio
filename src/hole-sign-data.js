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
  { id: 'hole-sign-full-graphic', name: 'Full graphic', description: 'Pre-designed graphic fills the entire canvas — banners, text, and images layer on top', supportsText: false },
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

// Banner band — a full-width strip at the top or bottom of the sign, with its
// own bg (color or image). Banner heights are in sign coordinates so the
// slider semantics match the template-logo size slider. Text is not stored on
// the banner itself — any number of free text layers (HS.textLayers) can dock
// to a banner via their own `dock`/`dockOrder` fields (see text-layers.js).
export const HS_BANNER_MIN_H = 300;
export const HS_BANNER_MAX_H = HS_H; // up to the full sign height
export const HS_BANNER_DEFAULT_H = 700;

export function emptyBanner() {
  return {
    enabled: false,
    height: HS_BANNER_DEFAULT_H,
    spacing: 16, // gap between adjacent stacked docked text layers
    valign: 'center', // vertical position of the docked text stack within the banner — 'top' | 'center' | 'bottom'
    bg: { type: 'color', color: '#E5E5E5', imageUrl: null, storagePath: null, imageX: 50, imageY: 50, imageScale: 100 },
  };
}

// Converts a legacy banner's topText/subText (the old fixed two-slot caption
// fields, removed above) into 0-2 docked free-text-layer specs. Only emits an
// entry for a slot that actually has text. `which` is 'top' | 'bottom'; the
// caller assigns an `id` before pushing into a textLayers array.
export function migrateBannerCaptions(legacyBanner, which) {
  if (!legacyBanner) return [];
  const specs = [];
  const title = legacyBanner.topText;
  const sub = legacyBanner.subText;
  if (title?.text?.trim()) {
    specs.push({
      text: title.text, font: title.font || 'dm-serif', size: title.size ?? 260,
      color: title.color || '#111110', align: title.align || 'center', w: title.w,
      dock: which, dockOrder: 0, aboveFrame: true,
    });
  }
  if (sub?.text?.trim()) {
    specs.push({
      text: sub.text, font: sub.font || 'dm-sans', size: sub.size ?? 140,
      color: sub.color || '#111110', align: sub.align || 'center', w: sub.w,
      dock: which, dockOrder: 1, aboveFrame: true,
    });
  }
  return specs;
}

// Global starter templates for the hole-sign Design step — same shape as a
// saved "My templates" (localStorage) entry, but shipped with the app so
// every project gets them instead of just the browser that saved them.
// Promoted from staff-designed "My templates" entries; each one's assets
// (background images etc.) must live in public/ rather than a project's
// Supabase Storage folder, so the template stays valid for every project.
export const HS_DEFAULT_TEMPLATES = [
  {
    id: 'default-1',
    name: 'Template 1',
    templateStyle: 'hole-sign-1',
    background: { type: 'color', color: '#ffffff', imageUrl: null, storagePath: null },
    topText:    { text: 'Hole Sponsored by', font: 'dm-serif', size: 331, color: '#000000' },
    bottomText: { text: '[Tournament Name]', font: 'dm-serif', size: 184, color: '#6e6e6e' },
    bannerTop:    emptyBanner(),
    bannerBottom: emptyBanner(),
    templateLogos: { ...emptyTemplateLogos(), size: 560, vAlign: 'bottom', hAlign: 'spread' },
  },
  {
    id: 'default-2',
    name: 'Template 2',
    templateStyle: 'hole-sign-1',
    background: {
      type: 'image', color: '#ffffff',
      imageUrl: '/hole-signs/templates/template-2-bg.jpg', storagePath: null,
      imageOpacity: 41, overlayEnabled: false,
    },
    topText:    { text: 'Hole Sponsored by', font: 'dm-serif', size: 331, color: '#000000' },
    bottomText: { text: '', font: 'dm-serif', size: 184, color: '#6e6e6e' },
    bannerTop:    emptyBanner(),
    bannerBottom: emptyBanner(),
    templateLogos: { ...emptyTemplateLogos(), size: 560, vAlign: 'bottom', hAlign: 'spread' },
  },
  {
    id: 'default-4',
    name: 'Template 3',
    templateStyle: 'hole-sign-1',
    background: { type: 'color', color: '#ffffff', imageUrl: null, storagePath: null },
    topText:    { text: '', font: 'dm-serif', size: 331, color: '#000000' },
    bottomText: { text: '', font: 'dm-serif', size: 184, color: '#6e6e6e' },
    bannerTop:    { ...emptyBanner(), enabled: true, height: 1134 },
    bannerBottom: { ...emptyBanner(), height: 925 },
    // Seed docked text layers for this template's banners — same partial-spec
    // shape as migrateBannerCaptions() output. Merged into HS.textLayers by
    // applyDefaultTemplate/applyCustomTemplate (design.js) since banners no
    // longer carry caption text of their own.
    bannerTopTextLayers: [
      { text: 'Hole Sponsored By', font: 'dm-serif', size: 260, color: '#111110', align: 'center', dock: 'top', dockOrder: 0, aboveFrame: true },
    ],
    bannerBottomTextLayers: [],
    templateLogos: { ...emptyTemplateLogos(), count: 2, size: 560, vAlign: 'bottom', hAlign: 'center' },
  },
];
