import { S, DEFAULT_COLORS, findLogo } from './state.js';
import { FLAGS } from './data.js';
import { isLightColor } from './gsTag.js';
import { HS_FONTS } from './hole-sign-data.js';
import { wrapText } from './text-utils.js';

export const getFlag = () => FLAGS.find(f => f.id === S.flagId);

// A cropped logo's clipPath id must be unique across the whole document, not
// just within its own <svg> — the gallery (and other callers) render a
// front and a back <svg> side by side in the same DOM, and "same front &
// back" reuses the very same layer object/id for both, so keying the id on
// layer.id alone produces two clipPath elements sharing one id. `url(#id)`
// then resolves to whichever one the browser treats as canonical for that
// id, regardless of which <svg> it's actually nested in — so one face's
// <image> can end up clipped by the OTHER face's crop rect. A monotonic
// per-render counter keeps every clipPath id distinct regardless of how
// many times the same layer gets rendered into the same document.
let cropClipSeq = 0;

// Template-level text layers (S.textLayers) always render alongside whatever
// variation-specific text layers a variation itself carries — same relation
// as colors/gsTag to a variation's own content. Callers that already collect
// `v.textLayers` for a render pass should thread it through here instead of
// passing that array bare.
export const withMasterText = (v) => [...(S.textLayers || []), ...((v && v.textLayers) || [])];

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

// The template's decorative frame — border ring + GolfStatus watermark tag —
// which should default to sitting above added content instead of being
// covered by it. `Border` (no "zone-" prefix) covers templates like Pennant/
// Swallow Tail whose border isn't a recolorable zone.
const FRAME_SELECTOR = '[id="zone-border"], [id="Border"], [id="GolfStatus Tag"]';

// Some templates nest a child rect literally named "Border" inside the
// "zone-border" group — without keeping only outermost matches, the frame
// would get split into two separately-moved pieces.
export function extractFrameElements(root) {
  const matches = Array.from(root.querySelectorAll(FRAME_SELECTOR));
  return matches.filter(el => !matches.some(other => other !== el && other.contains(el)));
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

// Draws template-level free text layers (S.textLayers — see state.js) as
// plain SVG <text>, independent of makeSvg's own frame/aboveEls bookkeeping
// so drop-zones.js's editable canvases (which build their <svg> by hand, not
// through makeSvg) can paint the same master content non-interactively —
// `append(el, aboveFrame)` lets each caller decide where an element lands.
export function paintTextLayers(textLayers, vbW, vbH, isBack, append) {
  if (!textLayers?.length) return;
  const ns = 'http://www.w3.org/2000/svg';
  textLayers.forEach(layer => {
    if (!layer.text) return;
    const fontFamily = HS_FONTS.find(f => f.id === layer.font)?.family || "'DM Serif Display', serif";
    const fsSvg = (layer.fontSize / 100) * vbH;
    const cy = (layer.y / 100) * vbH + fsSvg * 0.82;

    let cx, textAnchor;
    if (isBack) {
      if (layer.align === 'left') { cx = (1 - layer.x / 100) * vbW; textAnchor = 'end'; }
      else if (layer.align === 'right') { cx = (1 - (layer.x + layer.w) / 100) * vbW; textAnchor = 'start'; }
      else { cx = (1 - (layer.x + layer.w / 2) / 100) * vbW; textAnchor = 'middle'; }
    } else {
      if (layer.align === 'left') { cx = (layer.x / 100) * vbW; textAnchor = 'start'; }
      else if (layer.align === 'right') { cx = ((layer.x + layer.w) / 100) * vbW; textAnchor = 'end'; }
      else { cx = ((layer.x + layer.w / 2) / 100) * vbW; textAnchor = 'middle'; }
    }

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
    append(t, layer.aboveFrame);
  });
}

// Draws template-level free image layers (S.imageLayers) as plain SVG
// <image> — x/y are the box's CENTER (percent of canvas), w is percent of
// the viewBox's width, matching image-box.js's createImageBox data
// convention (the interactive editor at Step 1 mutates these same fields
// directly). Height is never stored on the layer — derived from the image's
// own natural aspect ratio via the same cache makeSvg's logo loop uses,
// exactly like an uncropped placed logo.
export function paintImageLayers(imageLayers, vbW, vbH, isBack, append) {
  if (!imageLayers?.length) return;
  const ns = 'http://www.w3.org/2000/svg';
  imageLayers.forEach(layer => {
    if (!layer.src) return;
    const w = (layer.w / 100) * vbW;
    const h = w / getLogoAspect(layer);
    const xFrac = isBack ? (1 - layer.x / 100) : (layer.x / 100);
    const cx = xFrac * vbW;
    const cy = (layer.y / 100) * vbH;
    const img = document.createElementNS(ns, 'image');
    img.setAttribute('href', layer.src);
    img.setAttribute('x', cx - w / 2);
    img.setAttribute('y', cy - h / 2);
    img.setAttribute('width', w);
    img.setAttribute('height', h);
    img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    img.setAttribute('draggable', 'false');
    append(img, layer.aboveFrame);
  });
}

export function makeSvg(logos, w, h, face = 'front', mirrorX = false, flagOverride = null, colorsOverride = null, textLayers = [], gsTagOpts = null, imageLayers = []) {
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

  const gst = gsTagOpts ?? { enabled: S.gsTag, mode: S.gsTagMode };
  if (gst.enabled) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    // Resolve so the tag's auto light/dark pick matches the background it's
    // actually rendered on, even when that zone fell back to a default color.
    // Must run before extractFrameElements below — it only sets attributes,
    // but those need to land on the tag before it's relocated.
    showGsTagVariant(svg, face, gst.mode, resolveColors(colors, flag)[keyZone]);
  }

  // The frame (border + GS tag) defaults to painting above added content —
  // collected now, moved to the top once all default-layer content below it
  // has been appended. Content layers can opt into sitting above the frame
  // instead via `layer.aboveFrame`, collected into aboveEls and appended last.
  const frameEls = extractFrameElements(svg);
  const aboveEls = [];

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
      const logo = findLogo(layer.logoId);
      if (!logo) return;
      const logoW = zone.w * (layer.w / 100);
      const xFrac = (face === 'back' && mirrorX) ? (1 - layer.x / 100) : (layer.x / 100);
      const cx = zoneX + xFrac * zone.w;
      const cy = zone.y + (layer.y / 100) * zone.h;
      const img = document.createElementNS(ns, 'image');
      img.setAttribute('href', logo.src);
      // Chrome offers a native "drag this image out" gesture on any <image>
      // by default — with real mouse/trackpad jitter (unlike a scripted
      // click), the tiniest movement between mousedown/mouseup on a logo is
      // enough for the browser to start that native drag instead of firing a
      // click, silently swallowing clicks on variation-card thumbnails (this
      // same renderer paints those too — see paintVarThumb in
      // flags/variations.js) and any other read-only preview. The editor's
      // own logo-reposition drag is built on pointer events (image-box.js),
      // never on this native mechanism, so disabling it here doesn't touch it.
      img.setAttribute('draggable', 'false');

      if (layer.cropped && layer.h != null && layer.imageBaseW != null) {
        // Cropped layer — box is w/h independent of the artwork's own aspect
        // (see createImageBox's `cropped` mode / image-box.js's module doc).
        // The image has its OWN fixed geometry (imageAbsX/Y/imageBaseW/H/
        // imageScale, percent-of-zone — same convention layer.x/y/w already
        // use), completely independent of the box's own w/h/x/y, so it never
        // rescales/shifts here just because the box was resized. On the back
        // face, only the box's own center (cx, above) is mirrored; the
        // image is carried along by its offset FROM the box, unmirrored —
        // same "reposition the anchor, don't re-derive internal geometry"
        // rule paintTextLayers/paintImageLayers follow above — so the same
        // panned/zoomed crop window is visible on both faces instead of a
        // different slice of the artwork.
        const logoH = zone.h * (layer.h / 100);
        const imgOffsetX = (layer.imageAbsX - layer.x) / 100 * zone.w;
        const imgOffsetY = (layer.imageAbsY - layer.y) / 100 * zone.h;
        const imgCx = cx + imgOffsetX;
        const imgCy = cy + imgOffsetY;
        const imgScale = (layer.imageScale ?? 100) / 100;
        const imgW = (layer.imageBaseW / 100) * zone.w * imgScale;
        const imgH = (layer.imageBaseH / 100) * zone.h * imgScale;
        const left = cx - logoW / 2, top = cy - logoH / 2;
        const clipId = 'logo-crop-clip-' + layer.id + '-' + (cropClipSeq++);
        const clipPath = document.createElementNS(ns, 'clipPath');
        clipPath.id = clipId;
        const clipRect = document.createElementNS(ns, 'rect');
        clipRect.setAttribute('x', left);
        clipRect.setAttribute('y', top);
        clipRect.setAttribute('width', logoW);
        clipRect.setAttribute('height', logoH);
        clipPath.appendChild(clipRect);
        svg.appendChild(clipPath);
        img.setAttribute('x', imgCx - imgW / 2);
        img.setAttribute('y', imgCy - imgH / 2);
        img.setAttribute('width', imgW);
        img.setAttribute('height', imgH);
        img.setAttribute('clip-path', `url(#${clipId})`);
      } else {
        const logoH = logoW / getLogoAspect(logo);
        img.setAttribute('x', cx - logoW / 2);
        img.setAttribute('y', cy - logoH / 2);
        img.setAttribute('width', logoW);
        img.setAttribute('height', logoH);
        img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      }
      if (layer.aboveFrame) aboveEls.push(img);
      else svg.appendChild(img);
    });
  }

  if (textLayers?.length || imageLayers?.length) {
    const [vbW2, vbH2] = (flag.viewBox || '0 0 7519 4669').split(' ').slice(2).map(Number);
    const isBack = face === 'back' && mirrorX;
    const append = (el, aboveFrame) => { if (aboveFrame) aboveEls.push(el); else svg.appendChild(el); };
    paintTextLayers(textLayers, vbW2, vbH2, isBack, append);
    paintImageLayers(imageLayers, vbW2, vbH2, isBack, append);
  }

  // The grey bleed guide is left in its original (pre-frame) template
  // position, so the border zone — which deliberately paints past the trim
  // line, with no gap once printed and cut — ends up covering it. Promote it
  // above the frame (inside the same holder, so it shares the frame's mirror
  // transform on the back face instead of losing it) so every renderInto()
  // consumer (variation thumbnails, gallery cards) sees it, not just call
  // sites that patched this locally.
  const bleedEl = svg.querySelector('[id="Bleed"], [id="bleed"]');
  if (frameEls.length || bleedEl) {
    const frameHolder = document.createElementNS(ns, 'g');
    // Elements are moving out of the mirrored `g` wrapper built above (for
    // face === 'back') — re-apply that same transform here or the frame
    // loses its mirroring/position.
    if (face === 'back') frameHolder.setAttribute('transform', `translate(${vbW},0) scale(-1,1)`);
    frameEls.forEach(el => frameHolder.appendChild(el));
    if (bleedEl) frameHolder.appendChild(bleedEl);
    svg.appendChild(frameHolder);
  }
  aboveEls.forEach(el => svg.appendChild(el));

  return svg;
}

export function renderInto(el, logos, face = 'front', mirrorX = false, flagOverride = null, colorsOverride = null, textLayers = [], gsTagOpts = null, imageLayers = []) {
  el.innerHTML = '';
  const svg = makeSvg(logos, '100%', '100%', face, mirrorX, flagOverride, colorsOverride, textLayers, gsTagOpts, imageLayers);
  if (svg) {
    svg.style.cssText = 'display:block;width:100%;height:100%';
    el.appendChild(svg);
    // makeSvg's own showGsTagVariant call ran on this <svg> before it was
    // attached above, so the tag's mirror-center lookup (getBBox()) couldn't
    // measure real geometry and fell back to an approximation — visibly
    // leaving the tag looking like it never moved off the front position.
    // Re-run it now that the SVG is in the document.
    if (face === 'back') {
      const flag = flagOverride || getFlag();
      const gst = gsTagOpts ?? { enabled: S.gsTag, mode: S.gsTagMode };
      if (gst.enabled && flag) {
        const keyZone = flag.tagKeyZone || 'zone-primary';
        showGsTagVariant(svg, 'back', gst.mode, resolveColors(colorsOverride || S.colors, flag)[keyZone]);
      }
    }
  }
}
