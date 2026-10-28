// Converts live SVG <text> into filled <path> outlines so a print SVG renders
// identically for a vendor who doesn't have our fonts. Uses opentype.js with
// our own glyph layout (not Font.getPath/stringToGlyphs — its GSUB shaping
// throws on DM Sans); pair kerning still comes from getKerningValue.
//
// Font files: DM Sans / DM Serif Display (OFL) are self-hosted woff in
// public/fonts. Meatball is an Adobe Fonts (Typekit) font we may not
// redistribute, so its woff is fetched at export time from the Typekit CSS the
// page already links. Anything else (Georgia is a system font — no file to
// read) can't be outlined: that <text> is left live and reported in `skipped`.
import opentype from 'opentype.js';

const SELF_HOSTED = {
  'dm sans': { 300: '/fonts/dm-sans-300.woff', 400: '/fonts/dm-sans-400.woff', 500: '/fonts/dm-sans-500.woff', 700: '/fonts/dm-sans-700.woff' },
  'dm serif display': { 400: '/fonts/dm-serif-display-400.woff' },
};

const _fontCache = new Map(); // url -> Promise<opentype.Font|null>

function loadFont(url) {
  if (!_fontCache.has(url)) {
    _fontCache.set(url, (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return opentype.parse(await res.arrayBuffer());
      } catch { return null; }
    })());
  }
  return _fontCache.get(url);
}

// Typekit CSS -> { family(lowercase): woff url } for the non-woff2 source
// (opentype.js can't read woff2).
let _typekitUrls = null;
async function typekitFontUrls() {
  if (_typekitUrls) return _typekitUrls;
  _typekitUrls = {};
  const links = document.querySelectorAll('link[rel="stylesheet"][href*="use.typekit.net"]');
  for (const link of links) {
    try {
      const res = await fetch(link.href);
      if (!res.ok) continue;
      const css = await res.text();
      for (const block of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
        const fam = block[1].match(/font-family:\s*["']?([^"';]+)/)?.[1]?.trim().toLowerCase();
        const woff = block[1].match(/url\(["']?([^"')]+)["']?\)\s*format\(["']woff["']\)/)?.[1];
        const otf = block[1].match(/url\(["']?([^"')]+)["']?\)\s*format\(["']opentype["']\)/)?.[1];
        if (fam && (woff || otf)) _typekitUrls[fam] = woff || otf;
      }
    } catch { /* skip */ }
  }
  return _typekitUrls;
}

// Returns { font, fauxBold } or null when no file is available.
async function resolveFont(familyAttr, weightAttr) {
  const family = (familyAttr || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
  const wantBold = weightAttr === 'bold' || Number(weightAttr) >= 600;
  const hosted = SELF_HOSTED[family];
  if (hosted) {
    const want = wantBold ? 700 : 400;
    const has = hosted[want] ? want : 400;
    const font = await loadFont(hosted[has]);
    return font ? { font, fauxBold: wantBold && has !== 700 } : null;
  }
  const tk = (await typekitFontUrls())[family];
  if (tk) {
    const font = await loadFont(tk);
    return font ? { font, fauxBold: wantBold } : null;
  }
  return null;
}

// Own serializer: Path.toPathData() in opentype.js 2.0 emits NaN control
// points for some quadratic glyph curves.
const r2 = n => Math.round(n * 100) / 100;
function glyphPathData(glyph, x, y, fontSize) {
  let d = '';
  for (const c of glyph.getPath(x, y, fontSize).commands) {
    if (c.type === 'M' || c.type === 'L') d += `${c.type}${r2(c.x)} ${r2(c.y)}`;
    else if (c.type === 'Q') d += `Q${r2(c.x1)} ${r2(c.y1)} ${r2(c.x)} ${r2(c.y)}`;
    else if (c.type === 'C') d += `C${r2(c.x1)} ${r2(c.y1)} ${r2(c.x2)} ${r2(c.y2)} ${r2(c.x)} ${r2(c.y)}`;
    else if (c.type === 'Z') d += 'Z';
  }
  return d;
}

function layoutLine(font, str, fontSize) {
  const scale = fontSize / font.unitsPerEm;
  const glyphs = Array.from(str).map(ch => font.charToGlyph(ch));
  const adv = [];
  let w = 0;
  glyphs.forEach((g, i) => {
    let a = (g.advanceWidth || 0) * scale;
    if (i < glyphs.length - 1) a += (font.getKerningValue(g, glyphs[i + 1]) || 0) * scale;
    adv.push(a);
    w += a;
  });
  return { glyphs, adv, width: w };
}

// Replaces every <text> in `svg` (in place) with a <g> of <path>s. Returns the
// distinct font-family names that could not be outlined and stayed live.
export async function outlineSvgText(svg) {
  const ns = 'http://www.w3.org/2000/svg';
  const skipped = new Set();
  for (const text of Array.from(svg.querySelectorAll('text'))) {
    const familyAttr = text.getAttribute('font-family');
    const resolved = await resolveFont(familyAttr, text.getAttribute('font-weight'));
    if (!resolved) { skipped.add((familyAttr || 'default').split(',')[0].replace(/["']/g, '').trim()); continue; }
    const { font, fauxBold } = resolved;
    const fontSize = parseFloat(text.getAttribute('font-size'));
    const anchor = text.getAttribute('text-anchor') || 'start';
    const fill = text.getAttribute('fill') || '#000000';
    let y = parseFloat(text.getAttribute('y')) || 0;

    const g = document.createElementNS(ns, 'g');
    // Preserve anything else the <text> carried (transform, opacity, id).
    for (const attr of ['transform', 'opacity', 'id', 'clip-path']) {
      if (text.hasAttribute(attr)) g.setAttribute(attr, text.getAttribute(attr));
    }
    Array.from(text.querySelectorAll('tspan')).forEach((tspan, i) => {
      if (i > 0) y += parseFloat(tspan.getAttribute('dy')) || 0;
      const { glyphs, adv, width } = layoutLine(font, tspan.textContent, fontSize);
      let x = parseFloat(tspan.getAttribute('x')) || 0;
      if (anchor === 'middle') x -= width / 2; else if (anchor === 'end') x -= width;
      let d = '';
      glyphs.forEach((glyph, k) => {
        if (glyph.unicode !== 32 && glyph.path?.commands?.length) d += glyphPathData(glyph, x, y, fontSize);
        x += adv[k];
      });
      if (!d) return;
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', fill);
      if (fauxBold) {
        p.setAttribute('stroke', fill);
        p.setAttribute('stroke-width', (fontSize / 32).toFixed(2));
        p.setAttribute('stroke-linejoin', 'round');
      }
      g.appendChild(p);
    });
    text.replaceWith(g);
  }
  return [...skipped];
}
