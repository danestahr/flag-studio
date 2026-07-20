import { S, DEFAULT_COLORS } from './state.js';
import { FLAGS } from './data.js';
import { isLightColor } from './gsTag.js';
import { HS_FONTS } from './hole-sign-data.js';
import { wrapText } from './text-utils.js';

export const getFlag = () => FLAGS.find(f => f.id === S.flagId);

// Fills in any zone the user hasn't picked a color for so rendering — and the
// step "Next" buttons — never block on an unmade choice. Primary/secondary
// fall back to DEFAULT_COLORS; the border zone (which has no default of its
// own) "inherits" whichever color ends up in secondary, or primary for flags
// with no secondary zone (Plain, Pennant, Swallow Tail, Putting Green Flag).
export function resolveColors(colors, flag) {
  if (!colors) return colors;
  const withDefaults = { ...colors };
  flag?.colorZones?.forEach(z => {
    if (z.id !== 'zone-border' && !withDefaults[z.id]) {
      withDefaults[z.id] = DEFAULT_COLORS[z.id] || DEFAULT_COLORS['zone-primary'];
    }
  });
  if (withDefaults['zone-border']) return withDefaults;
  const hasSecondary = flag?.colorZones?.some(z => z.id === 'zone-secondary');
  withDefaults['zone-border'] = hasSecondary ? withDefaults['zone-secondary'] : withDefaults['zone-primary'];
  return withDefaults;
}

function gsTagCenterX(tagGroup) {
  try {
    const bb = tagGroup.getBBox();
    if (bb.width > 0) return bb.x + bb.width / 2;
  } catch (_) {}
  // Fallback: extract x-coords from absolute M commands
  let min = Infinity, max = -Infinity;
  tagGroup.querySelectorAll('path').forEach(p => {
    for (const m of (p.getAttribute('d') || '').matchAll(/M\s*([\d.]+)/g)) {
      const x = +m[1]; if (x < min) min = x; if (x > max) max = x;
    }
  });
  return min < max ? (min + max) / 2 : 0;
}

// face: 'front' | 'back' — which side's tag group to show (the other is hidden)
// mode: 'auto' | 'dark' | 'light' — 'auto' picks black/white from keyHex's lightness
// keyHex: background color behind the tag, used to resolve 'auto'
export function showGsTagVariant(svg, face = 'front', mode = 'auto', keyHex = null) {
  const tagGroup = svg.querySelector('[id="GolfStatus Tag"]');
  if (!tagGroup) return;
  if (face === 'back') {
    const cx = gsTagCenterX(tagGroup);
    tagGroup.setAttribute('transform', `translate(${(2 * cx).toFixed(1)},0) scale(-1,1)`);
  } else {
    tagGroup.removeAttribute('transform');
  }
  tagGroup.removeAttribute('display');

  // Legacy templates only ever baked a single ("Dark") variant under the old
  // naming — fall back to it so those flags don't need re-exporting.
  const frontEl = tagGroup.querySelector('[id="Front Tag"]') || tagGroup.querySelector('[id="Front - Dark Tag"]');
  const backEl = tagGroup.querySelector('[id="Back Tag"]') || tagGroup.querySelector('[id="Back - Dark Tag"]');
  if (frontEl) frontEl.setAttribute('display', face === 'front' ? '' : 'none');
  if (backEl) backEl.setAttribute('display', face === 'back' ? '' : 'none');

  const activeEl = face === 'back' ? backEl : frontEl;
  if (!activeEl) return;
  const color = mode === 'dark' ? '#000000'
    : mode === 'light' ? '#ffffff'
    : isLightColor(keyHex) ? '#000000' : '#ffffff';
  activeEl.querySelectorAll('path,rect,circle,polygon,ellipse').forEach(p => p.setAttribute('fill', color));
}

export function applyColors(svgEl, colors, skipColors = false, flag = null) {
  svgEl.setAttribute('fill', 'none'); // original SVGs have fill="none" on root; preserve when injecting innerHTML
  svgEl.querySelectorAll('[id*="logo-placement"]').forEach(g => g.setAttribute('display', 'none'));
  svgEl.querySelectorAll('[id="GolfStatus Tag"]').forEach(g => g.setAttribute('display', 'none'));
  if (skipColors) return;
  colors = resolveColors(colors, flag);
  Object.entries(colors).forEach(([zid, hex]) => {
    if (!hex) return;
    const el = svgEl.querySelector('#' + zid);
    if (!el) return;
    el.setAttribute('fill', hex);
    // Some templates group a stroke-only decorative accent (e.g. a dashed
    // stitch line) under a zone id — it has no fill of its own, relying on
    // inheriting the root's fill="none". Now that the zone's <g> carries an
    // explicit fill, that inheritance would paint the accent solid instead
    // of leaving it as a line — force it back to none rather than the zone hex.
    el.querySelectorAll('rect,path,polygon,circle,ellipse').forEach(c => {
      if (c.closest('[id^="Bleed"]')) return;
      c.setAttribute('fill', c.hasAttribute('fill') ? hex : 'none');
    });
  });
  Object.entries(colors).forEach(([zid, hex]) => {
    if (!hex) return;
    svgEl.querySelectorAll('[id^="' + zid + '"]').forEach(el => {
      if (el.hasAttribute('fill') && el.getAttribute('fill') !== 'none') el.setAttribute('fill', hex);
    });
  });
}

// Normalise old { zoneId: { id, x, y, w } } assignment maps to the new
// logos array format so that review/gallery pages work without migration.
export function normaliseLogos(logosOrAssignment) {
  if (Array.isArray(logosOrAssignment)) return logosOrAssignment;
  if (!logosOrAssignment || typeof logosOrAssignment !== 'object') return [];
  return Object.values(logosOrAssignment).flatMap(data => {
    const ld = typeof data === 'string' ? { id: data, x: 50, y: 50, w: 80 } : data;
    if (!ld?.id) return [];
    return [{ id: 'migrated', logoId: ld.id, x: ld.x ?? 50, y: ld.y ?? 50, w: ld.w ?? 80 }];
  });
}

// Cache of each logo's natural width/height ratio, populated lazily as its
// image loads. makeSvg's logo box used to be sized purely off the zone's own
// aspect ratio (zone.w/zone.h) regardless of the logo's actual shape, then
// letterboxed to fit via preserveAspectRatio — which rarely matches the
// interactive drop-zone box (a plain <img> sized by width only, height auto,
// i.e. the logo's real aspect ratio), making baked/exported logos visibly
// shrink or stretch versus the editor. Falls back to a square box (today's
// old behavior) until the real ratio is known.
const _logoAspectCache = new Map();
const _logoAspectLoading = new Map();

function loadLogoAspect(logo) {
  if (!logo?.src) return Promise.resolve(1);
  if (_logoAspectCache.has(logo.src)) return Promise.resolve(_logoAspectCache.get(logo.src));
  if (_logoAspectLoading.has(logo.src)) return _logoAspectLoading.get(logo.src);
  const promise = new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const ratio = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : 1;
      _logoAspectCache.set(logo.src, ratio);
      resolve(ratio);
    };
    img.onerror = () => { _logoAspectCache.set(logo.src, 1); resolve(1); };
    img.src = logo.src;
  });
  _logoAspectLoading.set(logo.src, promise);
  return promise;
}

// Synchronous read used inside makeSvg — returns the cached ratio, or kicks
// off a load (for next time) and falls back to a square box until it lands.
function getLogoAspect(logo) {
  if (!logo?.src) return 1;
  if (_logoAspectCache.has(logo.src)) return _logoAspectCache.get(logo.src);
  loadLogoAspect(logo);
  return 1;
}

// Warms getLogoAspect's cache for a batch of logos (e.g. right after a
// project's library loads) — await this so the first canvas render already
// has accurate aspect ratios instead of the square fallback, rather than
// racing the image loads.
export function preloadLogoAspects(logos) {
  return Promise.all((logos || []).map(loadLogoAspect));
}

export function makeSvg(logos, w, h, face = 'front', mirrorX = false, flagOverride = null, colorsOverride = null, textLayers = [], gsTagOpts = null) {
  const flag = flagOverride || getFlag();
  if (!flag) return null;
  const colors = colorsOverride || S.colors;
  const zone = flag.logoZones[0];
  const ns = 'http://www.w3.org/2000/svg';
  const vbW = +((flag.viewBox || '0 0 7519 4669').split(' ')[2]);

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('xmlns', ns);

  if (face === 'back') {
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', `translate(${vbW},0) scale(-1,1)`);
    g.innerHTML = flag.svgContent;
    svg.appendChild(g);
  } else {
    svg.innerHTML = flag.svgContent;
  }
  applyColors(svg, colors, flag.noColors, flag);

  const list = normaliseLogos(logos);
  if (zone && list.length) {
    const zoneX = face === 'back' ? vbW - zone.x - zone.w : zone.x;
    // The zone rect is just a placement suggestion, not a hard boundary — the
    // editor lets a logo be dragged/scaled past it, clipped only by the flag
    // canvas itself (`.flag-wrap { overflow:hidden }`), which the SVG root's
    // own viewBox clipping already reproduces here. Don't also clip to the
    // zone rect, or an oversized/repositioned logo gets cropped that the
    // editor shows in full.
    list.forEach(layer => {
      const logo = S.library.find(l => l.id === layer.logoId);
      if (!logo) return;
      const logoW = zone.w * (layer.w / 100);
      const logoH = logoW / getLogoAspect(logo);
      const xFrac = (face === 'back' && mirrorX) ? (1 - layer.x / 100) : (layer.x / 100);
      const cx = zoneX + xFrac * zone.w;
      const cy = zone.y + (layer.y / 100) * zone.h;
      const img = document.createElementNS(ns, 'image');
      img.setAttribute('href', logo.src);
      img.setAttribute('x', cx - logoW / 2);
      img.setAttribute('y', cy - logoH / 2);
      img.setAttribute('width', logoW);
      img.setAttribute('height', logoH);
      img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.appendChild(img);
    });
  }
  const gst = gsTagOpts ?? { enabled: S.gsTag, mode: S.gsTagMode };
  if (gst.enabled) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    // Resolve so the tag's auto light/dark pick matches the background it's
    // actually rendered on, even when that zone fell back to a default color.
    showGsTagVariant(svg, face, gst.mode, resolveColors(colors, flag)[keyZone]);
  }

  if (textLayers?.length) {
    const [vbW, vbH] = (flag.viewBox || '0 0 7519 4669').split(' ').slice(2).map(Number);
    const isBack = face === 'back' && mirrorX;
    textLayers.forEach(layer => {
      if (!layer.text) return;
      const fontFamily = HS_FONTS.find(f => f.id === layer.font)?.family || "'DM Serif Display', serif";
      const fsSvg = (layer.fontSize / 100) * vbH;
      const cy = (layer.y / 100) * vbH + fsSvg * 0.82;

      // anchor at the alignment edge of the text box; mirror x on back face
      let cx, textAnchor;
      if (isBack) {
        // x coordinates are flipped; alignment direction reverses too
        if (layer.align === 'left') {
          cx = (1 - layer.x / 100) * vbW;
          textAnchor = 'end';
        } else if (layer.align === 'right') {
          cx = (1 - (layer.x + layer.w) / 100) * vbW;
          textAnchor = 'start';
        } else {
          cx = (1 - (layer.x + layer.w / 2) / 100) * vbW;
          textAnchor = 'middle';
        }
      } else {
        if (layer.align === 'left') {
          cx = (layer.x / 100) * vbW;
          textAnchor = 'start';
        } else if (layer.align === 'right') {
          cx = ((layer.x + layer.w) / 100) * vbW;
          textAnchor = 'end';
        } else {
          cx = ((layer.x + layer.w / 2) / 100) * vbW;
          textAnchor = 'middle';
        }
      }

      // Wrap to the box width (same as the live editor's `width:100%` overlay
      // with word-break wrapping) so multi-line text doesn't overflow its box.
      const boxWsvg = (layer.w / 100) * vbW;
      const lines = wrapText(layer.text, boxWsvg, fsSvg);
      const lineH = fsSvg * 1.1;

      const t = document.createElementNS(ns, 'text');
      t.setAttribute('y', cy);
      t.setAttribute('font-family', fontFamily);
      t.setAttribute('font-size', fsSvg);
      t.setAttribute('fill', layer.color || '#000000');
      t.setAttribute('text-anchor', textAnchor);
      lines.forEach((line, i) => {
        const tspan = document.createElementNS(ns, 'tspan');
        tspan.setAttribute('x', cx);
        if (i > 0) tspan.setAttribute('dy', lineH);
        tspan.textContent = line;
        t.appendChild(tspan);
      });
      svg.appendChild(t);
    });
  }

  return svg;
}

export function renderInto(el, logos, face = 'front', mirrorX = false, flagOverride = null, colorsOverride = null, textLayers = [], gsTagOpts = null) {
  el.innerHTML = '';
  const svg = makeSvg(logos, '100%', '100%', face, mirrorX, flagOverride, colorsOverride, textLayers, gsTagOpts);
  if (svg) {
    svg.style.cssText = 'display:block;width:100%;height:100%';
    el.appendChild(svg);
  }
}
