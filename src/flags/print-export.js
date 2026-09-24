// Print-quality export pipeline for flags — factored out of flags/gallery.js
// so project.js (the staff project-overview page) can build the same
// print-ready PDFs and send them to Prestige Flag directly, without the
// flags Gallery page's DOM/sidebar loaded. Everything here reads/writes the
// same shared `S` singleton (src/state.js) that render.js already depends
// on, same as gallery.js always has — populate it via
// hydrateFlagStateForProject() before calling buildFlagsPrintZip().
//
// Callers must call `loadAllFlags(FLAGS)` themselves before
// hydrateFlagStateForProject() (flag templates need their svgContent/
// logoZones populated first) — this module doesn't call it internally so a
// caller that already loaded FLAGS earlier in the same page (or is about to
// re-hydrate on a refresh) doesn't pay to re-fetch every template SVG again.
import JSZip from 'jszip';
import { pngBlobToPdfBlob as pngToPdfPt } from '../pdf-utils.js';
import { S, mergeLibraries } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, makeSvg, showGsTagVariant, resolveColors, preloadLogoAspects, withMasterText } from '../render.js';
import { loadProject, loadFlagConfig, loadLogosForProject, listUserLogos } from '../supabase.js';
import { buildOrderSummaryPdf } from '../orderSummaryPdf.js';
import { slug, mapWithConcurrency } from '../dom-utils.js';

// ── Per-variation override helpers (mirrors flags/variations.js's own
// per-variation flag/colors/gsTag override logic) ───────────────────────
export function getVarFlag(v) {
  if (!v) return getFlag();
  const id = v.flagId || S.flagId;
  return FLAGS.find(f => f.id === id) || getFlag();
}
export function getVarColors(v) { return (v && v.colors) ? v.colors : S.colors; }
export function getVarColorEntries(v) {
  const flag = getVarFlag(v);
  const colors = getVarColors(v);
  return Object.entries(colors || {}).map(([zoneId, hex]) => {
    const zoneDef = flag?.colorZones?.find(z => z.id === zoneId);
    const colorDef = COLORS.find(c => c.hex.toLowerCase() === hex?.toLowerCase());
    return { zone: zoneId, label: zoneDef?.label || zoneId, hex: hex || '#000000', name: colorDef?.name || 'Custom' };
  });
}
export function getVarGsTagOpts(v) {
  if (!v || (v.gsTag === undefined && v.gsTagMode === undefined)) return null;
  return { enabled: v.gsTag ?? S.gsTag, mode: v.gsTagMode ?? S.gsTagMode };
}
// "Same Front & Back Design" is a per-variation setting (see
// flags/variations.js's toggleSameSides/sameSidesOf).
export function sameSidesOf(v) {
  return v?.sameLogoOnBothSides ?? true;
}

// ── Rasterization ────────────────────────────────────────────

const FLAG_DPI = 300;

// Fetch Google Fonts + Adobe Fonts (Typekit) CSS and inline all font files as
// base64 data URIs so that text renders correctly when SVG is drawn to canvas
// via a blob URL (which runs in a sandboxed context without access to the
// page's loaded @font-face rules).
let _fontStyleCache = null;
async function buildFontStyle() {
  if (_fontStyleCache !== null) return _fontStyleCache;
  const links = document.querySelectorAll('link[rel="stylesheet"][href*="fonts.googleapis.com"], link[rel="stylesheet"][href*="use.typekit.net"]');
  if (!links.length) { _fontStyleCache = ''; return ''; }
  try {
    const cssParts = await Promise.all([...links].map(async link => {
      try {
        const res = await fetch(link.href);
        return res.ok ? await res.text() : '';
      } catch { return ''; }
    }));
    let css = cssParts.join('\n');
    // Google's CSS uses unquoted url()s; Typekit's uses quoted url()s with a
    // format() hint and no file extension — capture both, keyed by format.
    const urlPattern = /url\((['"]?)(https?:\/\/[^'")]+)\1\)(?:\s*format\((['"]?)([\w-]+)\3\))?/g;
    const matches = new Map();
    for (const m of css.matchAll(urlPattern)) {
      if (!matches.has(m[2])) matches.set(m[2], m[4]);
    }
    for (const [url, format] of matches) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const f = (format || '').toLowerCase();
        const mime = f.includes('woff2') ? 'font/woff2' : f === 'woff' ? 'font/woff'
          : f.includes('opentype') || f.includes('truetype') ? 'font/otf'
          : url.includes('.woff2') ? 'font/woff2' : url.includes('.woff') ? 'font/woff' : 'font/truetype';
        css = css.replaceAll(url, `data:${mime};base64,${btoa(binary)}`);
      } catch { /* skip this URL */ }
    }
    _fontStyleCache = css;
    return css;
  } catch { _fontStyleCache = ''; return ''; }
}

async function injectFonts(svg) {
  const css = await buildFontStyle();
  if (!css) return;
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = css;
  svg.insertBefore(style, svg.firstChild);
}

export async function rasterizeSvg(logos, face, mirrorX = false, textLayers = [], flagOverride = null, colorsOverride = null, gsTagOpts = null, imageLayers = []) {
  const flag = flagOverride || getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, flagOverride, colorsOverride, textLayers, gsTagOpts, imageLayers);

  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const mime = mimeMap[ext] ?? (res.headers.get('content-type') ?? 'image/png').split(';')[0];
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is */ }
  }));
  await injectFonts(svg);

  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = vbW; c.height = vbH;
      c.getContext('2d').drawImage(img, 0, 0, vbW, vbH);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => blob ? resolve({ blob, vbW, vbH }) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

async function rasterizeThumbnail(logos, face, mirrorX = false, textLayers = [], flagOverride = null, colorsOverride = null, gsTagOpts = null, imageLayers = []) {
  const flag = flagOverride || getFlag();
  const colors = colorsOverride || S.colors;
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, flagOverride, colorsOverride, textLayers, gsTagOpts, imageLayers);
  // Always show GS tag in order summary thumbnails regardless of S.gsTag
  const gst = gsTagOpts ?? { enabled: S.gsTag, mode: S.gsTagMode };
  if (!gst.enabled) {
    const keyZone = flag?.tagKeyZone || 'zone-primary';
    showGsTagVariant(svg, face, 'auto', resolveColors(colors, flag)[keyZone]);
  }
  await injectFonts(svg);
  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', svg:'image/svg+xml' };
      const mime = mimeMap[ext] ?? 'image/png';
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is */ }
  }));
  const thumbW = 800, thumbH = Math.round(800 * vbH / vbW);
  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = thumbW; c.height = thumbH;
      c.getContext('2d').drawImage(img, 0, 0, thumbW, thumbH);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => {
        if (!blob) { reject(new Error('toBlob failed')); return; }
        blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf))).catch(reject);
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

async function rasterizeForPrint(logos, face, mirrorX = false, textLayers = [], flagOverride = null, colorsOverride = null, gsTagOpts = null, imageLayers = []) {
  const flag = flagOverride || getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, flagOverride, colorsOverride, textLayers, gsTagOpts, imageLayers);
  // GolfStatus Tag lives inside Bleed only in the raw template — makeSvg's
  // extractFrameElements (render.js) already relocates it into frameHolder
  // (which carries the back-face mirror transform) before returning here.
  // Only rescue it from Bleed if it's still actually nested there, or this
  // hoists it out of frameHolder onto the un-transformed <svg> root instead,
  // stripping the ambient mirror while its own local counter-mirror (set by
  // showGsTagVariant) stays applied — flipping it on the back face.
  const gsTagEl = svg.querySelector('[id="GolfStatus Tag"]');
  const gsTagBleedAncestor = gsTagEl?.closest('[id="Bleed"], [id="bleed"]');
  if (gsTagBleedAncestor?.parentNode) {
    gsTagBleedAncestor.parentNode.appendChild(gsTagEl);
  }
  for (const gid of ['Bleed', 'bleed']) {
    const el = svg.querySelector(`[id="${gid}"]`);
    if (el) el.parentNode?.removeChild(el);
  }
  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const mime = mimeMap[ext] ?? (res.headers.get('content-type') ?? 'image/png').split(';')[0];
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is */ }
  }));
  await injectFonts(svg);
  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = vbW; c.height = vbH;
      c.getContext('2d').drawImage(img, 0, 0, vbW, vbH);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => blob ? resolve({ blob, vbW, vbH }) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

export function pngBlobToPdfBlob(pngBlob, vbW, vbH) {
  return pngToPdfPt(pngBlob, (vbW / FLAG_DPI) * 72, (vbH / FLAG_DPI) * 72);
}

// How many variations to rasterize at once during print export. Purely a
// wall-clock lever — the zip is only assembled once at the end regardless
// (see mapWithConcurrency in dom-utils.js), so this doesn't change peak
// memory, just how many renders overlap while producing it.
const PRINT_EXPORT_CONCURRENCY = 4;

export async function buildFlagsPrintZip(setStatus = () => {}) {
  const zip = new JSZip();
  const flag = getFlag();
  const total = S.variations.length;
  let rendered = 0;
  await mapWithConcurrency(S.variations, PRINT_EXPORT_CONCURRENCY, async (v, i) => {
    const frontLogos = v.logos || v.assignment || [];
    const mirrored = sameSidesOf(v);
    const backLogos  = mirrored ? frontLogos : (v.backLogos || v.backAssignment || []);
    const backTextLayers = mirrored ? (v.textLayers || []) : (v.backTextLayers || []);
    const { blob: frontPng, vbW: fW, vbH: fH } = await rasterizeForPrint(frontLogos, 'front', false, withMasterText(v), getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), S.imageLayers || []);
    const { blob: backPng,  vbW: bW, vbH: bH } = await rasterizeForPrint(backLogos,  'back', mirrored, [...(S.textLayers || []), ...backTextLayers], getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), S.imageLayers || []);
    const safe = slug(v.name) || 'variation-' + (i + 1);
    const [frontPdf, backPdf] = await Promise.all([
      pngBlobToPdfBlob(frontPng, fW, fH),
      pngBlobToPdfBlob(backPng, bW, bH),
    ]);
    zip.file(`${safe}/${safe}-front.pdf`, frontPdf);
    zip.file(`${safe}/${safe}-back.pdf`,  backPdf);
    setStatus(`Rendering ${++rendered} of ${total}: ${v.name}…`);
  });
  setStatus('Adding logos…');
  // Independent fetches - parallelizing is a pure latency win over the old
  // one-at-a-time loop, since each logo download doesn't depend on the last.
  // S.library mixes project-owned logos with this user's cross-project
  // shared library (see mergeLibraries()) — only bundle logos actually
  // placed in one of this project's current variations, so a logo that was
  // used and later removed doesn't linger in the export.
  const usedLogoIds = new Set();
  S.variations.forEach(v => {
    (v.logos || []).forEach(l => usedLogoIds.add(l.logoId));
    (v.backLogos || []).forEach(l => usedLogoIds.add(l.logoId));
  });
  const exportLogos = (S.library || []).filter(l => usedLogoIds.has(l.id));
  await Promise.all(exportLogos.map(async logo => {
    try {
      const res = await fetch(logo.src);
      if (!res.ok) return;
      const ext = (logo.storagePath || logo.src).split('.').pop().split('?')[0] || 'png';
      zip.file(`Logos/${logo.name}.${ext}`, await res.arrayBuffer());
    } catch { /* skip on error */ }
  }));
  setStatus('Building order summary…');
  const colorEntries = getVarColorEntries(null);
  setStatus('Rendering variation thumbnails…');
  const variationImages = await mapWithConcurrency(S.variations, PRINT_EXPORT_CONCURRENCY, async v => {
    const frontLogos = v.logos || v.assignment || [];
    const mirrored = sameSidesOf(v);
    const backLogos  = mirrored ? frontLogos : (v.backLogos || v.backAssignment || []);
    const backTextLayers = mirrored ? (v.textLayers || []) : (v.backTextLayers || []);
    const [frontPng, backPng] = await Promise.all([
      rasterizeThumbnail(frontLogos, 'front', false, withMasterText(v), getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), S.imageLayers || []).catch(() => null),
      rasterizeThumbnail(backLogos, 'back', mirrored, [...(S.textLayers || []), ...backTextLayers], getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), S.imageLayers || []).catch(() => null),
    ]);
    return {
      name: v.name, frontPng, backPng,
      flagName: getVarFlag(v)?.name || v.flagId || S.flagId || '',
      colorEntries: getVarColorEntries(v),
      qty: v.qty ?? 1,
    };
  });
  const summaryPdf = await buildOrderSummaryPdf({
    projectId: S.projectId, productType: 'flags', colorEntries,
    templateName: flag?.name || S.flagId, variationCount: S.variations.length, variationImages,
  });
  zip.file('Order Summary.pdf', summaryPdf);
  setStatus('Zipping…');
  return { zipBlob: await zip.generateAsync({ type: 'blob' }), flag };
}

// ── Hydration ────────────────────────────────────────────────

// Loads a project's flag_config + logo library into the shared `S` singleton
// so buildFlagsPrintZip() (or any render.js call) has what it needs — the
// same hydration flags/gallery.js's loadAndRenderGallery() does for its own
// page, minus the DOM/sidebar rendering, so project.js can build a print
// export without ever loading the flags Gallery page. Caller must have
// already called `loadAllFlags(FLAGS)` (see module comment above).
export async function hydrateFlagStateForProject(projectId) {
  const project = await loadProject(projectId);
  const [logos, sharedLogos, flagCfg] = await Promise.all([
    loadLogosForProject(projectId),
    listUserLogos(project.created_by),
    loadFlagConfig(projectId).catch(() => null),
  ]);
  S.projectId = project.id;
  S.projectName = project.name || '';
  S.shareToken = project.share_token || null;
  S.projectStatus = flagCfg?.status || 'draft';
  S.library = mergeLibraries(logos, sharedLogos);

  await preloadLogoAspects(S.library);
  if (flagCfg) {
    S.flagId = flagCfg.flag_id;
    S.colors = flagCfg.colors || {};
    const varData = flagCfg.variations || [];
    const varItems = Array.isArray(varData) ? varData : (varData.items || []);
    S.variations = varItems.map(v => ({ ...v, backAssignment: v.backAssignment || {} }));
    S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
    S.gsTag = Array.isArray(varData) ? true : (varData.gsTag ?? true);
    S.gsTagMode = Array.isArray(varData) ? 'auto' : (varData.gsTagMode ?? 'auto');
    S.gsTagColor = Array.isArray(varData) ? '#ffffff' : (varData.gsTagColor ?? '#ffffff');
    S.textLayers = Array.isArray(varData) ? [] : (varData.textLayers || []);
    S.imageLayers = Array.isArray(varData) ? [] : (varData.imageLayers || []);
    await preloadLogoAspects(S.imageLayers);
    S.variations.forEach(v => {
      if (v.sameLogoOnBothSides === undefined) v.sameLogoOnBothSides = flagCfg.same_logo_on_both_sides ?? true;
    });
    S.activeVarId = S.variations[0]?.id || null;
    // Apply logoLayout to the live flag object so render.js's renderInto/makeSvg uses the right zones
    const flag = getFlag();
    if (flag?.logoZoneSets) {
      flag.logoZones = flag.logoZoneSets[S.logoLayout] || flag.logoZones;
    }
  }
  return { project, flagCfg };
}
