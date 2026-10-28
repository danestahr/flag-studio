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
import { jpgBlobToPdfBlob as jpgToPdfPt } from '../pdf-utils.js';
import { S, loadTemplateBack } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, makeSvg, showGsTagVariant, resolveColors, preloadLogoAspects, withMasterText, tplImages, customTplImages, printOpts, backSpecOf } from '../render.js';
import { loadProject, loadFlagConfig, loadLogosForProject } from '../supabase.js';
import { buildOrderSummaryPdf, buildFlagSheetsPdf } from '../orderSummaryPdf.js';
import { slug, mapWithConcurrency } from '../dom-utils.js';
import { expandHoleNumbers } from './hole-numbers.js';
import { outlineSvgText } from './outline-text.js';
import { inlineSvgLogos } from './inline-svg-logos.js';
import { PRINT_FRAMES, UNITS_PER_INCH, ART, POLE_W, newProjectPrintSpec, usesV2Print } from './print-spec.js';

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
  // Only zones this flag actually has (a Plain flag has no secondary, but new
  // projects still carry the default secondary colour) and that have a colour set.
  const declared = flag?.colorZones?.length ? new Set(flag.colorZones.map(z => z.id)) : null;
  return Object.entries(colors || {}).filter(([zoneId, hex]) => hex && (!declared || declared.has(zoneId))).map(([zoneId, hex]) => {
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

async function rasterizeThumbnail(logos, face, mirrorX = false, textLayers = [], flagOverride = null, colorsOverride = null, gsTagOpts = null, imageLayers = [], width = 800) {
  const flag = flagOverride || getFlag();
  const colors = colorsOverride || S.colors;
  // v2 (vendor print) thumbnails show the cropped art box, like the customer preview.
  const pOpts = printOpts(flag);
  // Customer-facing previews (order summary / flag sheets PDFs) show the pole;
  // the Prestige print sheets go through renderPrintSheetV2's fullFrame path and don't.
  const poleW = pOpts && flag?.poleText ? POLE_W : 0;
  const [, , vbW, vbH] = pOpts ? [0, 0, ART.w + poleW, ART.h] : (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, flagOverride, colorsOverride, textLayers, gsTagOpts, imageLayers, pOpts && { ...pOpts, pole: true });
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
  const thumbW = width, thumbH = Math.round(width * vbH / vbW);
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
      const ctx = c.getContext('2d');
      // JPEG has no alpha: flatten onto white after the face is fully composed, so
      // transparent logos still show the flag colour beneath them.
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, vbW, vbH);
      ctx.drawImage(img, 0, 0, vbW, vbH);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => blob ? resolve({ blob, vbW, vbH }) : reject(new Error('canvas.toBlob failed')), 'image/jpeg', 0.95);
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

export function jpgBlobToPdfBlob(jpgBlob, vbW, vbH) {
  return jpgToPdfPt(jpgBlob, (vbW / FLAG_DPI) * 72, (vbH / FLAG_DPI) * 72);
}

// How many variations to rasterize at once during print export. Purely a
// wall-clock lever — the zip is only assembled once at the end regardless
// (see mapWithConcurrency in dom-utils.js), so this doesn't change peak
// memory, just how many renders overlap while producing it.
const PRINT_EXPORT_CONCURRENCY = 4;

// Front/back thumbnails + style/colour/qty for one variation - the shared
// input to both the Order Summary PDF and the customer-facing Flag Sheets PDF.
export async function buildVariationSheetData(v, width = 800) {
  const frontLogos = v.logos || v.assignment || [];
  const back = backSpecOf(v);
  const [frontPng, backPng] = await Promise.all([
    rasterizeThumbnail(frontLogos, 'front', false, withMasterText(v), getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), tplImages(v), width).catch(() => null),
    rasterizeThumbnail(back.logos, 'back', back.mirrored, back.textLayers, getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), back.imageLayers, width).catch(() => null),
  ]);
  return {
    name: v.name, frontPng, backPng,
    flagName: getVarFlag(v)?.name || v.flagId || S.flagId || '',
    colorEntries: getVarColorEntries(v),
    qty: v.qty ?? 1,
    aspect: printOpts(getVarFlag(v)) ? (ART.w + (getVarFlag(v)?.poleText ? POLE_W : 0)) / ART.h : undefined,
  };
}

// Customer-facing PDF: one 8.5x11 sheet per variation (front on top, back
// below). Pass a subset of S.variations for a single-variation download.
export async function buildFlagSheetsPdfBlob(variations = S.variations) {
  const variationImages = await mapWithConcurrency(variations, PRINT_EXPORT_CONCURRENCY, v => buildVariationSheetData(v, 1600));
  const bytes = await buildFlagSheetsPdf({ projectName: S.projectName, variationImages });
  return new Blob([bytes], { type: 'application/pdf' });
}

export async function buildFlagsPrintZip(setStatus = () => {}) {
  const zip = new JSZip();
  const flag = getFlag();
  const total = S.variations.reduce((n, v) => n + expandHoleNumbers(v).length, 0);
  let rendered = 0;
  // v2 puts every variation's files into two folders by file type ("Print Files (SVG)" and
  // "Print Files (JPG)"), so each variation's name is what keeps its files apart. Names are made
  // filesystem-safe and de-duplicated up front (variations render concurrently, so this can't
  // be decided inside the loop).
  const used = new Set();
  const variationNames = S.variations.map((v0, i) => {
    const base = (v0.name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || `Variation ${i + 1}`;
    let name = base, n = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${n++})`;
    used.add(name.toLowerCase());
    return name;
  });
  await mapWithConcurrency(S.variations, PRINT_EXPORT_CONCURRENCY, async (v0, i) => {
    const safe = slug(v0.name) || 'variation-' + (i + 1);
    // Numbered variations render one flag per hole; the rest yield a single entry.
    for (const { v, num } of expandHoleNumbers(v0)) {
      const frontLogos = v.logos || v.assignment || [];
      const back = backSpecOf(v);
      if (usesV2Print({ print_spec: S.printSpec }, getVarFlag(v))) {
        // Vendor print frames: physical-size SVG + 300 DPI JPG per face.
        const vBase = slug(variationNames[i]) || safe;
        const vFile = num == null ? vBase : `${vBase}-hole-${String(num).padStart(2, '0')}`;
        const vFlag = getVarFlag(v);
        const front = await renderPrintSheetV2(frontLogos, 'front', false, withMasterText(v), vFlag, getVarColors(v), getVarGsTagOpts(v), tplImages(v));
        const backOut = await renderPrintSheetV2(back.logos, 'back', back.mirrored, back.textLayers, vFlag, getVarColors(v), getVarGsTagOpts(v), back.imageLayers);
        const live = [...new Set([...front.liveTextFonts, ...backOut.liveTextFonts])];
        if (live.length) console.warn(`[print] ${v0.name}: text in ${live.join(', ')} could not be outlined (no font file) and stays live in the SVG`);
        zip.file(`Print Files (SVG)/${vFile}-front.svg`, front.svg);
        zip.file(`Print Files (SVG)/${vFile}-back.svg`,  backOut.svg);
        zip.file(`Print Files (JPG)/${vFile}-front.jpg`, front.jpg);
        zip.file(`Print Files (JPG)/${vFile}-back.jpg`,  backOut.jpg);
        setStatus(`Rendering ${++rendered} of ${total}: ${v0.name}${num == null ? '' : ' #' + num}…`);
        continue;
      }
      const { blob: frontPng, vbW: fW, vbH: fH } = await rasterizeForPrint(frontLogos, 'front', false, withMasterText(v), getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), tplImages(v));
      const { blob: backPng,  vbW: bW, vbH: bH } = await rasterizeForPrint(back.logos,  'back', back.mirrored, back.textLayers, getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), back.imageLayers);
      const file = num == null ? safe : `${safe}-hole-${String(num).padStart(2, '0')}`;
      const [frontPdf, backPdf] = await Promise.all([
        jpgBlobToPdfBlob(frontPng, fW, fH),
        jpgBlobToPdfBlob(backPng, bW, bH),
      ]);
      zip.file(`${safe}/${file}-front.pdf`, frontPdf);
      zip.file(`${safe}/${file}-back.pdf`,  backPdf);
      setStatus(`Rendering ${++rendered} of ${total}: ${v0.name}${num == null ? '' : ' #' + num}…`);
    }
  });

  setStatus('Adding logos…');
  // Independent fetches - parallelizing is a pure latency win over the old
  // one-at-a-time loop, since each logo download doesn't depend on the last.
  // Only bundle logos actually placed in one of this project's current
  // variations, so a logo that was used and later removed doesn't linger in
  // the export.
  const usedLogoIds = new Set();
  S.variations.forEach(v => {
    (v.logos || []).forEach(l => usedLogoIds.add(l.logoId));
    (v.backLogos || []).forEach(l => usedLogoIds.add(l.logoId));
    (v.tpl?.backLogos || []).forEach(l => usedLogoIds.add(l.logoId));
  });
  (S.backLogos || []).forEach(l => usedLogoIds.add(l.logoId));
  const exportLogos = (S.library || []).filter(l => usedLogoIds.has(l.id));
  await Promise.all(exportLogos.map(async logo => {
    try {
      const res = await fetch(logo.src);
      if (!res.ok) return;
      const ext = (logo.storagePath || logo.src).split('.').pop().split('?')[0] || 'png';
      zip.file(`!_Logos/${logo.name}.${ext}`, await res.arrayBuffer());
    } catch { /* skip on error */ }
  }));
  setStatus('Building order summary…');
  const colorEntries = getVarColorEntries(null);
  setStatus('Rendering variation thumbnails…');
  const variationImages = await mapWithConcurrency(S.variations, PRINT_EXPORT_CONCURRENCY, v => buildVariationSheetData(v));
  const summaryPdf = await buildOrderSummaryPdf({
    projectId: S.projectId, productType: 'flags', colorEntries,
    templateName: flag?.name || S.flagId, variationCount: S.variations.length, variationImages,
  });
  zip.file('!_Order Summary.pdf', summaryPdf); // "!_" sorts it (and !_Logos) to the top
  setStatus('Zipping…');
  return { zipBlob: await zip.generateAsync({ type: 'blob' }), summaryPdf, flag };
}

// ── v2 vendor print sheets (see flags/print-spec.js) ─────────────────────
// Additive: only reached for projects pinned to print_spec 'v2' whose flag
// ships print frames. Legacy projects never take this path.

async function inlineImageHrefs(svg) {
  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const mime = mimeMap[ext] ?? (res.headers.get('content-type') ?? 'image/png').split(';')[0];
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is */ }
  }));
}

// One face's vendor print sheet: the full print frame with guides stripped,
// as a physical-size SVG string (width/height in inches) plus a 300 DPI JPG.
// Text is outlined to paths (outline-text.js) so vendors need no fonts; a font
// with no readable file (Georgia) stays live <text> with fonts embedded, and
// its name is returned in `liveTextFonts` so callers can warn.
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Logos are stored as WebP after upload, and Illustrator mishandles WebP inside an SVG
// <image> (it drew the logo at double its x/y offset, off the artboard). PNG and JPEG are
// read reliably by every vector tool, so re-encode anything else as PNG (lossless, keeps
// transparency). SVG logos are handled separately by inlineSvgLogos().
async function rasterToPngDataUris(svg) {
  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') ?? '';
    if (!/^data:image\/(webp|gif|avif|bmp);/i.test(src)) return;
    try {
      const el = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
      const c = document.createElement('canvas');
      c.width = el.naturalWidth; c.height = el.naturalHeight;
      c.getContext('2d').drawImage(el, 0, 0);
      img.setAttribute('href', c.toDataURL('image/png'));
    } catch { /* leave the original if it can't be decoded */ }
  }));
}

// Illustrator (and older SVG readers) only understand xlink:href on <image>; the plain
// SVG2 `href` makes it report even an embedded image as a missing file. Rewrite every
// image, and declare the namespace once on the root.
function useXlinkHref(svg) {
  svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', XLINK_NS);
  svg.querySelectorAll('image').forEach(img => {
    const v = img.getAttribute('href') ?? img.getAttributeNS(XLINK_NS, 'href');
    if (v == null) return;
    img.removeAttribute('href');
    img.setAttributeNS(XLINK_NS, 'xlink:href', v);
  });
}

// canvas.toBlob's JPEG carries a JFIF header with no resolution (units 0, 1:1), which
// design tools read as 72 ppi - a 7800 px sheet would open as 108" wide. Stamp the real
// density (pixels per inch) into that header so it opens at its true 26" x 15.5".
async function setJpegDpi(blob, dpi) {
  const b = new Uint8Array(await blob.arrayBuffer());
  const isJfif = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF && b[3] === 0xE0
    && b[6] === 0x4A && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46 && b[10] === 0;
  if (!isJfif) return blob;
  b[13] = 1;                                        // units: pixels per inch
  b[14] = dpi >> 8; b[15] = dpi & 0xFF;             // X density
  b[16] = dpi >> 8; b[17] = dpi & 0xFF;             // Y density
  return new Blob([b], { type: 'image/jpeg' });
}

export async function renderPrintSheetV2(logos, face, mirrorX, textLayers, flag, colors, gsTagOpts, imageLayers) {
  const f = PRINT_FRAMES[face];
  const svg = makeSvg(logos, f.w, f.h, face, mirrorX, flag, colors, textLayers, gsTagOpts, imageLayers, { print: true, fullFrame: true });
  // Client-only layers go (Stitches / its Bleed path, the logo area); the printer's
  // "Cut Guides" stay - they're required for print.
  svg.querySelectorAll('[id="Stitches"], [id="Bleed"], [id="bleed"], [id="logo-placement"], [id="#logo-placement"]').forEach(el => el.remove());
  // Layouts whose back SVG draws the border for the customer preview only: the
  // vendor folds the front over to make the back's border, so it must not print
  // on the back (see print-manifest.js backBorderPreviewOnly).
  if (face === 'back' && flag?.backBorderPreviewOnly) {
    svg.querySelectorAll('[id="Border"], [id^="zone-border"], [id^="#zone-border"]').forEach(el => el.remove());
  }
  // makeSvg lifts the full-bleed Border (and tag) above everything else, which buries the
  // corner cut marks that sit in that same outer strip. They must stay visible for the
  // printer, so put them on top of everything.
  const cutGuides = svg.querySelector('[id="Cut Guides"]');
  if (cutGuides) svg.appendChild(cutGuides);
  // Logos are embedded (not linked to the Logos folder) so the file displays correctly in
  // any vector software, wherever the vendor saves it. Uploaded SVG logos go in as real vector
  // shapes (an SVG inside an <image> won't render in Illustrator); this runs before text
  // outlining so any text inside a logo is outlined along with ours.
  await inlineImageHrefs(svg);
  await rasterToPngDataUris(svg);
  inlineSvgLogos(svg);
  const liveTextFonts = await outlineSvgText(svg);
  if (svg.querySelector('text')) await injectFonts(svg);
  svg.setAttribute('width', `${f.w / UNITS_PER_INCH}in`);
  svg.setAttribute('height', `${f.h / UNITS_PER_INCH}in`);
  useXlinkHref(svg);
  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  const jpg = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = f.w; c.height = f.h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, f.w, f.h); // JPG has no alpha
      ctx.drawImage(img, 0, 0, f.w, f.h);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob failed')), 'image/jpeg', 0.95);
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('print sheet SVG render failed')); };
    img.src = blobUrl;
  });
  return { svg: str, jpg: await setJpegDpi(jpg, UNITS_PER_INCH), liveTextFonts };
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
  const [logos, flagCfg] = await Promise.all([
    loadLogosForProject(projectId),
    loadFlagConfig(projectId).catch(() => null),
  ]);
  S.projectId = project.id;
  S.projectName = project.name || '';
  S.shareToken = project.share_token || null;
  S.projectStatus = flagCfg?.status || 'draft';
  S.library = logos;
  S.printSpec = flagCfg ? (flagCfg.variations?.printSpec ?? 'legacy') : newProjectPrintSpec(); // pinned per project; no row yet = brand-new project

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
    loadTemplateBack(varData);
    await preloadLogoAspects([...S.imageLayers, ...S.backImageLayers, ...customTplImages(varItems)]);
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
