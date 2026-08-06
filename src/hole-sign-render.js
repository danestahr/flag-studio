import { HS_W, HS_H, HS_MARGIN, HS_GAP, HS_FONTS, normalizeTplLogoSize } from './hole-sign-data.js';
import { isDisplayableImage, fileTypeLabel } from './media-utils.js';
import { wrapText } from './text-utils.js';

export function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Clamp a text box's stored width override (in sign coords) to the available
// margin span and center it — shared by the SVG text renderer and the
// on-canvas edit overlay so the two always agree on where the box actually is.
function fitTextBox(overrideW, minW) {
  const full = HS_W - 2 * HS_MARGIN;
  const w = Math.max(Math.min(minW || 200, full), Math.min(full, Math.round(overrideW || full)));
  return { w, x: HS_MARGIN + Math.round((full - w) / 2) };
}

function filePlaceholderSvg(x, y, w, h, label) {
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  const fs = Math.round(Math.min(w, h) * 0.18);
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#e8e8e8" rx="8"/>`,
    `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"`,
    ` font-family="sans-serif" font-size="${fs}" font-weight="bold" fill="#999">${escXml(label)}</text>`,
  ].join('');
}

// Slot width for the configured ratio. `fit` follows the logo's natural aspect
// (using logoAspect = h/w); the rest are simple width:height factors.
export function slotWidthForRatio(slot, slotH) {
  if (!slot) return slotH * 2;
  const ratio = slot.ratio || '2:1';
  if (ratio === 'fit') {
    const a = slot.logoAspect;
    if (a && a > 0) return Math.max(slotH * 0.5, Math.min(slotH * 6, slotH / a));
    return slotH * 2;
  }
  const [w, h] = ratio.split(':').map(Number);
  if (w > 0 && h > 0) return slotH * w / h;
  return slotH * 2;
}

// Returns the strip rect + per-slot rects for the template-logo group, or null
// when the feature is disabled (count = 0). All coordinates are in sign space.
export function computeTemplateLogoLayout(tl) {
  if (!tl || !tl.count || tl.count < 1) return null;
  const slotH = normalizeTplLogoSize(tl.size);
  const gap = HS_GAP * 2;
  const innerW = HS_W - 2 * HS_MARGIN;

  // Per-slot widths — each slot can override via its ratio setting.
  const widths = [];
  for (let i = 0; i < tl.count; i++) {
    widths.push(slotWidthForRatio((tl.slots || [])[i], slotH));
  }

  // Logos always lay out side by side in a single row — hAlign only changes
  // where that row sits (left/center/right-anchored, or spread across the
  // full width), it never stacks them into a column.
  const stripH = slotH;
  const slotsRel = [];
  if (tl.hAlign === 'spread') {
    if (tl.count === 1) {
      slotsRel.push({ dx: (innerW - widths[0]) / 2, dy: 0 });
    } else if (tl.count === 2) {
      slotsRel.push({ dx: 0, dy: 0 });
      slotsRel.push({ dx: innerW - widths[1], dy: 0 });
    } else {
      slotsRel.push({ dx: 0, dy: 0 });
      slotsRel.push({ dx: (innerW - widths[1]) / 2, dy: 0 });
      slotsRel.push({ dx: innerW - widths[2], dy: 0 });
    }
  } else {
    const sum = widths.reduce((s, w) => s + w, 0);
    const groupW = sum + (tl.count - 1) * gap;
    const baseX = tl.hAlign === 'right' ? innerW - groupW
                : tl.hAlign === 'center' ? (innerW - groupW) / 2
                : 0;
    let x = baseX;
    for (let i = 0; i < tl.count; i++) {
      slotsRel.push({ dx: x, dy: 0 });
      x += widths[i] + gap;
    }
  }

  return { stripH, widths, slotH, slotsRel, gap };
}

// Free text layers currently docked to a banner (`which` is 'top' | 'bottom'),
// sorted into stack order. Docking is per-layer (layer.dock/layer.dockOrder),
// not a fixed slot on the banner itself — see hole-sign-data.js's emptyBanner.
export function dockedLayers(state, which) {
  return (state.textLayers || [])
    .filter(l => l.dock === which)
    .sort((a, b) => (a.dockOrder ?? 0) - (b.dockOrder ?? 0));
}

// Wrap every docked, non-empty layer to its own box width and return the line
// breakdown plus the total stacked text height (in sign coords). Generalizes
// the old fixed title+sub pair to N independently-styled layers.
function dockedTextBlock(state, which) {
  const banner = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  const entries = dockedLayers(state, which)
    .filter(l => l.text && l.text.trim())
    .map(l => {
      const box = fitTextBox(l.w, l.size);
      const lines = wrapText(l.text, box.w, l.size);
      const lineH = l.size * 1.1;
      return { layer: l, box, lines, lineH, h: lines.length * lineH };
    });
  const gap = banner?.spacing || 0;
  const total = entries.reduce((s, e) => s + e.h, 0) + Math.max(0, entries.length - 1) * gap;
  return { entries, gap, total };
}

// Vertical breathing room reserved above/below the docked text stack — shared
// by bannerEffectiveHeight (total padding) and dockedLayerPositions (per-side,
// for top/bottom valign) so they always agree on how much space is set aside.
function bannerTextVPad(block) {
  const maxSize = block.entries.reduce((m, e) => Math.max(m, e.layer.size || 0), 0);
  return Math.round(maxSize * 0.45);
}

// Resolved {x,y,w,h} rect (sign coords) for every currently-docked, non-empty
// layer in `which`, stacked top-to-bottom in dockOrder, honoring banner.valign.
// Keyed by layer id so callers can look up a specific layer's computed box.
export function dockedLayerPositions(state, which) {
  const rect = getBannerRect(state, which);
  if (!rect) return {};
  const banner = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  const block = dockedTextBlock(state, which);
  const valign = banner?.valign || 'center';
  const vpad = bannerTextVPad(block);
  let y = valign === 'top' ? rect.y + vpad
    : valign === 'bottom' ? rect.y + rect.h - vpad - block.total
    : rect.y + rect.h / 2 - block.total / 2;
  const out = {};
  block.entries.forEach(e => {
    out[e.layer.id] = { x: e.box.x, y, w: e.box.w, h: e.h };
    y += e.h + block.gap;
  });
  return out;
}

// Zone height actually used for layout + render: never shorter than the
// docked text needs (with vertical padding), so text never overflows and the
// zone grows automatically as text wraps. A banner's own `height` only sets a
// *minimum* while its colored background is switched on — with the banner
// off, the zone tight-fits whatever's docked (or is 0 when nothing is).
function bannerEffectiveHeight(state, which) {
  const banner = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  const block = dockedTextBlock(state, which);
  if (banner?.enabled) {
    if (block.total <= 0) return Math.max(0, banner.height || 0);
    return Math.max(banner.height || 0, block.total + bannerTextVPad(block) * 2);
  }
  return block.total > 0 ? Math.round(block.total + bannerTextVPad(block) * 2) : 0;
}

function computeLayout(state, templateId) {
  // Each top/bottom zone independently reserves height at its fixed edge
  // before any other content is placed, so the logo zone shrinks to fit —
  // whether or not the banner's colored background is switched on (see
  // bannerEffectiveHeight).
  const bannerTopH = bannerEffectiveHeight(state, 'top');
  const bannerBotH = bannerEffectiveHeight(state, 'bottom');

  // Both special templates still let their own graphic/logo fill the sign
  // edge-to-edge (bannerTopH/bannerBotH stay 0 in the returned layout for
  // full-graphic, so the background image is never inset) — banners and
  // template-logo images instead paint as an overlay on top of it (see the
  // frameParts ordering in makeHoleSignSvg). The strip position still shifts
  // clear of an active zone so the two don't visually collide.
  if (templateId === 'hole-sign-full-graphic') {
    const tll = computeTemplateLogoLayout(state.templateLogos);
    const stripH = tll ? tll.stripH : 0;
    let stripY = bannerTopH + HS_MARGIN;
    if (state.templateLogos?.vAlign === 'bottom') stripY = HS_H - bannerBotH - HS_MARGIN - stripH;
    return { topH: 0, botH: 0, logoY: 0, logoH: HS_H, stripY, stripH, bannerTopH: 0, bannerBotH: 0,
             topTextX: HS_W / 2, topTextAnchor: 'middle', botTextX: HS_W / 2, botTextAnchor: 'middle' };
  }
  if (templateId === 'hole-sign-logo-only') {
    const logoY = bannerTopH + HS_MARGIN;
    const logoH = Math.max(0, HS_H - bannerTopH - bannerBotH - 2 * HS_MARGIN);
    const tll = computeTemplateLogoLayout(state.templateLogos);
    const stripH = tll ? tll.stripH : 0;
    let stripY = logoY;
    if (state.templateLogos?.vAlign === 'bottom') stripY = HS_H - bannerBotH - HS_MARGIN - stripH;
    return { topH: 0, botH: 0, logoY, logoH, stripY, stripH, bannerTopH, bannerBotH,
             topTextX: HS_W / 2, topTextAnchor: 'middle', botTextX: HS_W / 2, botTextAnchor: 'middle' };
  }

  // Plain top/bottom sponsor captions (state.topText/bottomText) are
  // independent of any banner — they stack just inside it (or from the sign
  // edge, when that banner is off) and carve their own space out of the
  // sponsor logo zone, same as a banner does.
  const top = state.topText;
  const bot = state.bottomText;
  const topBox = fitTextBox(top.w, top.size);
  const botBox = fitTextBox(bot.w, bot.size);
  const topWrappedLines = (top.text && top.text.trim()) ? wrapText(top.text, topBox.w, top.size) : [];
  const botWrappedLines = (bot.text && bot.text.trim()) ? wrapText(bot.text, botBox.w, bot.size) : [];
  const topH = topWrappedLines.length ? Math.round(topWrappedLines.length * top.size * 1.1 + 80) : 0;
  const botH = botWrappedLines.length ? Math.round(botWrappedLines.length * bot.size * 1.1 + 80) : 0;
  const topGap = topH > 0 ? HS_GAP : 0;
  const botGap = botH > 0 ? HS_GAP : 0;

  // Sponsor logo zone uses everything between the top/bottom zones.
  const logoY = bannerTopH + HS_MARGIN + topH + topGap;
  const logoH = Math.max(0, HS_H - bannerTopH - bannerBotH - 2 * HS_MARGIN - topH - topGap - botH - botGap);

  // Default strip Y for template-logo initial placement (slots with no freeX set).
  // Placed at the start of the logo zone; bottom vAlign flips to the bottom edge.
  const tl = state.templateLogos;
  const tll = computeTemplateLogoLayout(tl);
  const stripH = tll ? tll.stripH : 0;
  let stripY = logoY;
  if (tl?.vAlign === 'bottom') {
    stripY = HS_H - bannerBotH - HS_MARGIN - botH - botGap - stripH;
  }

  return { topH, botH, logoY, logoH, stripY, stripH, bannerTopH, bannerBotH,
           topTextX: HS_W / 2, topTextAnchor: 'middle', topTextMaxW: topBox.w, topTextBoxX: topBox.x, topWrappedLines,
           botTextX: HS_W / 2, botTextAnchor: 'middle', botTextMaxW: botBox.w, botTextBoxX: botBox.x, botWrappedLines };
}

// Full-width top/bottom zone rect (sign coords), or null when nothing is
// docked there and the banner's colored background is off. `which` is
// 'top' | 'bottom'. Used both for the banner's own background paint and for
// docked-layer positioning/hit-testing.
export function getBannerRect(state, which) {
  const h = bannerEffectiveHeight(state, which);
  if (!(h > 0)) return null;
  const y = which === 'bottom' ? HS_H - h : 0;
  return { x: 0, y, w: HS_W, h };
}

// Editable text band rects (sign coords) for the plain top/bottom sponsor
// captions — used to place inline click-to-edit overlays on the canvas.
// Banner captions are ordinary docked free text layers now (see
// dockedLayerPositions) and use the free-text-layer overlay instead, so this
// only ever returns `top`/`bottom` keys. Only includes a region when that
// band actually has space, unless forceText says it's being edited right now.
export function getTextRegions(state, templateId, forceText = []) {
  const tid = templateId || state.templateStyle || 'hole-sign-1';
  const regions = {};
  if (tid === 'hole-sign-logo-only') return regions;
  const L = computeLayout(state, tid);
  const oneLine = size => Math.round((size || 200) * 1.1 + 80);
  const topBox = fitTextBox(state.topText.w, state.topText.size);
  const botBox = fitTextBox(state.bottomText.w, state.bottomText.size);
  if (L.topH > 0) regions.top = { x: topBox.x, y: L.bannerTopH + HS_MARGIN, w: topBox.w, h: L.topH };
  else if (forceText.includes('top')) regions.top = { x: topBox.x, y: L.bannerTopH + HS_MARGIN, w: topBox.w, h: oneLine(state.topText.size) };
  if (L.botH > 0) regions.bottom = { x: botBox.x, y: HS_H - L.bannerBotH - HS_MARGIN - L.botH, w: botBox.w, h: L.botH };
  else if (forceText.includes('bottom')) { const h = oneLine(state.bottomText.size); regions.bottom = { x: botBox.x, y: HS_H - L.bannerBotH - HS_MARGIN - h, w: botBox.w, h }; }
  return regions;
}

export function getLogoZone(state, templateId) {
  const tid = templateId || state.templateStyle || 'hole-sign-1';
  // Full-graphic's own image always fills the sign edge-to-edge (see
  // makeHoleSignSvg) — banners/template logos paint over it as an overlay
  // rather than carving out space, so this zone is never inset for them.
  if (tid === 'hole-sign-full-graphic') return { x: 0, y: 0, w: HS_W, h: HS_H };
  const { logoY, logoH, stripY, stripH } = computeLayout(state, tid);
  const x = HS_MARGIN, w = HS_W - 2 * HS_MARGIN;

  // When the user has manually repositioned template logo slots, give them the
  // full zone — they've chosen the layout and know what they're doing.
  if (state.templateLogos?.customPositions) return { x, y: logoY, w, h: logoH };

  // For default strip placement, carve the strip out so sponsor logos and
  // template logos can never overlap.
  const tll = computeTemplateLogoLayout(state.templateLogos);
  if (!tll || stripH <= 0) return { x, y: logoY, w, h: logoH };

  const gap = HS_GAP;
  const vAlign = state.templateLogos?.vAlign || 'top';
  if (vAlign === 'bottom') {
    // Strip at bottom: variation zone ends just above it.
    return { x, y: logoY, w, h: Math.max(0, stripY - logoY - gap) };
  } else {
    // Strip at top: variation zone starts just below it.
    const newY = stripY + stripH + gap;
    return { x, y: newY, w, h: Math.max(0, logoY + logoH - newY) };
  }
}


// Resolved absolute rects for each template-logo slot. Returns [] when off.
// Slots with freeX/freeY/freeW/freeH use those instead of the computed position.
export function getTemplateLogoSlots(state, templateId) {
  const tid = templateId || state.templateStyle || 'hole-sign-1';
  const tl = state.templateLogos;
  const tll = computeTemplateLogoLayout(tl);
  if (!tll) return [];
  const { stripY } = computeLayout(state, tid);
  return tll.slotsRel.map(({ dx, dy }, i) => {
    const slot = (tl.slots || [])[i];
    if (slot?.freeX != null) {
      return { x: slot.freeX, y: slot.freeY, w: slot.freeW ?? tll.widths[i], h: slot.freeH ?? tll.slotH };
    }
    return {
      x: HS_MARGIN + dx,
      y: stripY + dy,
      w: tll.widths[i],
      h: tll.slotH,
    };
  });
}

// Safe-area inset on each side of a slot (≈16px in display at typical preview).
// At scale = 100, the logo sizes to (slot − 2 × inset). Scale > 100 lets the
// user push the logo past the safe area (and eventually past the slot edges).
export const HS_TPL_LOGO_SAFE_FRAC = 0.04;

// Slot corner radius in sign coords — matches the 8 px display radius at the
// typical Step-1 preview scale and keeps the editor and exports visually
// consistent.
const HS_TPL_LOGO_RADIUS = 50;

// Build SVG markup for a template-logo slot: optional background fill + image.
// Honors fit (width|height), per-slot scale, tx/ty (% center inside the slot).
// Background and image are both clipped to the rounded slot bounds.
function renderTemplateLogoSlot(slot, rect, clipId) {
  if (!slot || !slot.logoSrc) return '';
  const src = slot.logoSrcTight || slot.logoSrc;
  const aspect = slot.logoAspect != null ? slot.logoAspect : 0.5;
  const fit = slot.fit || 'width';
  // In `fit` mode the slot already tracks the logo's natural aspect, so the
  // safe-area inset would just shrink the displayed logo for no reason.
  const safeFrac = (slot.ratio === 'fit') ? 0 : HS_TPL_LOGO_SAFE_FRAC;
  const safe = 1 - 2 * safeFrac;
  const scale = (slot.scale ?? 100) / 100 * safe;
  const tx = slot.tx ?? 50;
  const ty = slot.ty ?? 50;

  let imgW, imgH;
  if (fit === 'height') {
    imgH = rect.h * scale;
    imgW = imgH / aspect;
  } else {
    imgW = rect.w * scale;
    imgH = imgW * aspect;
  }
  const cx = rect.x + (tx / 100) * rect.w;
  const cy = rect.y + (ty / 100) * rect.h;

  const bg = (slot.bg && slot.bg !== 'transparent') ? slot.bg : null;
  const bgRect = bg
    ? `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="${HS_TPL_LOGO_RADIUS}" ry="${HS_TPL_LOGO_RADIUS}" fill="${escXml(bg)}"/>`
    : '';
  // Border stroke is drawn inset by half its width so it stays inside the slot
  // bounds and visually matches the DOM overlay (which uses `border:` directly).
  // `fit` mode suppresses the border so the slot vanishes around the logo.
  const borderColor = (slot.ratio === 'fit') ? null : slot.border?.color;
  const borderW = borderColor ? 16 : 0; // ~2 display px at typical preview scale
  const borderRect = borderColor
    ? `<rect x="${rect.x + borderW / 2}" y="${rect.y + borderW / 2}" width="${rect.w - borderW}" height="${rect.h - borderW}" rx="${Math.max(0, HS_TPL_LOGO_RADIUS - borderW / 2)}" ry="${Math.max(0, HS_TPL_LOGO_RADIUS - borderW / 2)}" fill="none" stroke="${escXml(borderColor)}" stroke-width="${borderW}"/>`
    : '';
  return `<clipPath id="${clipId}"><rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="${HS_TPL_LOGO_RADIUS}" ry="${HS_TPL_LOGO_RADIUS}"/></clipPath>`
    + bgRect
    + `<image href="${escXml(src)}" x="${Math.round(cx - imgW / 2)}" y="${Math.round(cy - imgH / 2)}" width="${Math.round(imgW)}" height="${Math.round(imgH)}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${clipId})"/>`
    + borderRect;
}

// Build SVG markup for a banner band's background only (color/image fill).
// Banner-hosted text is no longer drawn here — it's ordinary free text layers
// (see dockedLayerPositions) rendered through the normal free-layer loop below.
// `which` is 'top' | 'bottom'. Returns an array of SVG string parts, or []
// when the banner is disabled.
function renderBanner(state, which) {
  const banner = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  const h = bannerEffectiveHeight(state, which);
  if (!banner || !banner.enabled || !(h > 0)) return [];
  const y = which === 'bottom' ? HS_H - h : 0;
  const bg = banner.bg || {};
  const parts = [];
  const clipId = which === 'bottom' ? 'bannerBotClip' : 'bannerTopClip';
  parts.push(`<clipPath id="${clipId}"><rect x="0" y="${y}" width="${HS_W}" height="${h}"/></clipPath>`);
  parts.push(`<rect x="0" y="${y}" width="${HS_W}" height="${h}" fill="${escXml(bg.color || '#E5E5E5')}"/>`);
  if (bg.type === 'image' && bg.imageUrl) {
    const scale = (bg.imageScale ?? 100) / 100;
    const imgW = HS_W * scale;
    const imgH = h * scale;
    const cx = (bg.imageX ?? 50) / 100 * HS_W;
    const cy = y + (bg.imageY ?? 50) / 100 * h;
    parts.push(`<image href="${escXml(bg.imageUrl)}" x="${Math.round(cx - imgW / 2)}" y="${Math.round(cy - imgH / 2)}" width="${Math.round(imgW)}" height="${Math.round(imgH)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`);
  }
  return parts;
}

export function makeHoleSignSvg(state, variation) {
  // state.templateStyle comes from getEffectiveState() which correctly resolves
  // per-variation overrides. Prefer it over variation.templateId which can be a
  // stale value set when the variation was first created.
  const templateId = state.templateStyle || variation?.templateId || 'hole-sign-1';
  let { topH, botH, bannerTopH, bannerBotH, topTextX, topTextAnchor, topTextMaxW, topTextBoxX,
        botTextX, botTextAnchor, botTextMaxW, botTextBoxX, topWrappedLines, botWrappedLines } = computeLayout(state, templateId);
  const viewBox = `0 0 ${HS_W} ${HS_H}`;
  const bg = state.background;
  const topText = state.topText;
  const bottomText = state.bottomText;
  // Apply explicit text alignment only when the user has deliberately set it
  // (non-center forces the x position to the text box's own edge — which may
  // be narrower than the full margin span if the box has been resized).
  if (topText.align === 'left' || topText.align === 'right') {
    topTextAnchor = topText.align === 'left' ? 'start' : 'end';
    topTextX      = topText.align === 'left' ? topTextBoxX : topTextBoxX + topTextMaxW;
  } else if (topText.align === 'center') {
    topTextAnchor = 'middle';
    topTextX      = HS_W / 2;
  }
  if (bottomText.align === 'left' || bottomText.align === 'right') {
    botTextAnchor = bottomText.align === 'left' ? 'start' : 'end';
    botTextX      = bottomText.align === 'left' ? botTextBoxX : botTextBoxX + botTextMaxW;
  } else if (bottomText.align === 'center') {
    botTextAnchor = 'middle';
    botTextX      = HS_W / 2;
  }
  // Text keys to lay out but not draw (e.g. while being edited inline, so the
  // SVG copy doesn't show around the live editor — avoids the "halo").
  const hide = state.hideText || [];

  const getFamily = (fontId) => {
    const f = HS_FONTS.find(f => f.id === fontId);
    return f ? f.family : "'DM Sans', sans-serif";
  };

  let parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}" width="${HS_W}" height="${HS_H}">`);

  // Collect SVG defs (filters, etc.) emitted before any element that uses them.
  const svgDefs = [];
  if (bg.type === 'image' && bg.imageUrl && bg.imageGreyscale) {
    svgDefs.push(`<filter id="hsBgGrey"><feColorMatrix type="saturate" values="0"/></filter>`);
  }
  if (svgDefs.length) parts.push(`<defs>${svgDefs.join('')}</defs>`);

  // Background: only apply the stored color when type is 'color'; image mode
  // uses a white base so the color isn't inadvertently visible through a
  // partially transparent image.
  const bgFill = bg.type === 'image' ? '#FFFFFF' : (bg.color || '#FFFFFF');
  parts.push(`<rect x="0" y="0" width="${HS_W}" height="${HS_H}" fill="${escXml(bgFill)}"/>`);
  if (bg.type === 'image' && bg.imageUrl) {
    const imgOp = (bg.imageOpacity ?? 100) / 100;
    const filterAttr = bg.imageGreyscale ? ` filter="url(#hsBgGrey)"` : '';
    const opacityAttr = imgOp < 1 ? ` opacity="${imgOp.toFixed(3)}"` : '';
    parts.push(`<image href="${escXml(bg.imageUrl)}" x="0" y="0" width="${HS_W}" height="${HS_H}" preserveAspectRatio="xMidYMid slice"${filterAttr}${opacityAttr}/>`);
    const overlayAlpha = (bg.overlayEnabled !== false) ? (bg.overlayOpacity ?? 50) / 100 : 0;
    if (overlayAlpha > 0) {
      const blend = bg.overlayBlend || 'normal';
      const blendStyle = blend !== 'normal' ? ` style="mix-blend-mode:${escXml(blend)}"` : '';
      parts.push(`<rect x="0" y="0" width="${HS_W}" height="${HS_H}" fill="${escXml(bg.overlayColor || '#000000')}" fill-opacity="${overlayAlpha.toFixed(3)}"${blendStyle}/>`);
    }
  }

  // Frame elements (banner bands, static top/bottom text, template logo
  // slots) default to painting above added content (variation logo/sponsor
  // text, free text layers) — collected here and pushed after that content
  // below, unless a given piece of content opts above the frame via its own
  // `aboveFrame`.
  const frameParts = [];
  const aboveParts = [];

  // Banners paint as an overlay on top of full-graphic's full-bleed image
  // (frameParts push after variationParts below) rather than reserving space.
  frameParts.push(...renderBanner(state, 'top'));
  frameParts.push(...renderBanner(state, 'bottom'));

  // Plain top/bottom sponsor captions — independent of any banner, always
  // drawn in their own reserved band (see computeLayout). Hidden while being
  // edited inline (state.hideText) so the live DOM editor is the only visual.
  if (templateId !== 'hole-sign-logo-only' && topH > 0 && topText.text && topText.text.trim() && !hide.includes('top')) {
    const lines = topWrappedLines?.length ? topWrappedLines : wrapText(topText.text, topTextMaxW, topText.size);
    const lineH = topText.size * 1.1;
    const bandCY = bannerTopH + HS_MARGIN + topH / 2;
    const firstBaseY = bandCY - (lines.length - 1) * lineH / 2 + topText.size * 0.38;
    const tspans = lines.map((line, i) =>
      `<tspan x="${topTextX}"${i === 0 ? '' : ` dy="${lineH}"`}>${escXml(line)}</tspan>`
    ).join('');
    frameParts.push(`<text x="${topTextX}" y="${Math.round(firstBaseY)}" text-anchor="${topTextAnchor}" font-family="${escXml(getFamily(topText.font))}" font-size="${topText.size}" fill="${escXml(topText.color || '#111110')}">${tspans}</text>`);
  }
  if (templateId !== 'hole-sign-logo-only' && botH > 0 && bottomText.text && bottomText.text.trim() && !hide.includes('bottom')) {
    const lines = botWrappedLines?.length ? botWrappedLines : wrapText(bottomText.text, botTextMaxW, bottomText.size);
    const lineH = bottomText.size * 1.1;
    const bandCY = HS_H - bannerBotH - HS_MARGIN - botH / 2;
    const firstBaseY = bandCY - (lines.length - 1) * lineH / 2 + bottomText.size * 0.38;
    const tspans = lines.map((line, i) =>
      `<tspan x="${botTextX}"${i === 0 ? '' : ` dy="${lineH}"`}>${escXml(line)}</tspan>`
    ).join('');
    frameParts.push(`<text x="${botTextX}" y="${Math.round(firstBaseY)}" text-anchor="${botTextAnchor}" font-family="${escXml(getFamily(bottomText.font))}" font-size="${bottomText.size}" fill="${escXml(bottomText.color || '#111110')}">${tspans}</text>`);
  }

  // Template logos (drawn into the strip carved out by computeLayout) — part
  // of the template itself (set up once, shared by every variation), so they
  // belong in the frame group: they default to painting above the per-
  // variation content added below, same as the banner/text blocks.
  const tplSlots = getTemplateLogoSlots(state, templateId);
  if (tplSlots.length && state.templateLogos?.slots) {
    state.templateLogos.slots.forEach((slot, i) => {
      const rect = tplSlots[i];
      if (!rect) return;
      frameParts.push(renderTemplateLogoSlot(slot, rect, `tlc${i}`));
    });
  }

  // Logo (raster/SVG image) OR sponsor text fallback when no logo — defaults
  // to painting below the frame (banner/text above); variation.aboveFrame
  // moves it above instead.
  const variationParts = [];
  if (variation && variation.logoSrc && templateId === 'hole-sign-full-graphic') {
    const src = variation.logoSrcTight || variation.logoSrc;
    if (isDisplayableImage(src)) {
      variationParts.push(`<image href="${escXml(src)}" x="0" y="0" width="${HS_W}" height="${HS_H}" preserveAspectRatio="xMidYMid meet"/>`);
    } else {
      variationParts.push(filePlaceholderSvg(0, 0, HS_W, HS_H, fileTypeLabel(src)));
    }
  } else if (variation && variation.logoSrc) {
    const src = variation.logoSrcTight || variation.logoSrc;
    // Use getLogoZone so positioning matches the DOM dzone exactly, including
    // the carve-out for any template logo strip. The zone rect is only a
    // placement suggestion though (not a hard boundary — the editor lets a
    // logo be dragged/scaled past it, clipped only by the sign canvas itself),
    // so don't clip the image to it here either or an oversized/repositioned
    // logo gets cropped that the editor shows in full.
    const lz = getLogoZone(state, templateId);
    if (isDisplayableImage(src)) {
      const ld = variation.logoData || { x: 50, y: 50, w: 90 };
      const logoW = lz.w * (ld.w / 100);
      const aspect = variation.logoAspect != null ? variation.logoAspect : 1;
      const logoImgH = logoW * aspect;
      const cx = lz.x + (ld.x / 100) * lz.w;
      const cy = lz.y + (ld.y / 100) * lz.h;
      variationParts.push(`<image href="${escXml(src)}" x="${Math.round(cx - logoW / 2)}" y="${Math.round(cy - logoImgH / 2)}" width="${Math.round(logoW)}" height="${Math.round(logoImgH)}" preserveAspectRatio="xMidYMid meet"/>`);
    } else {
      variationParts.push(filePlaceholderSvg(lz.x, lz.y, lz.w, lz.h, fileTypeLabel(src)));
    }
  } else if (variation && variation.sponsorText && variation.sponsorText.text && variation.sponsorText.text.trim()) {
    const st = variation.sponsorText;
    const lz = getLogoZone(state, templateId);
    const cx = lz.x + lz.w / 2;
    const cy = lz.y + lz.h / 2 + st.size * 0.38;
    variationParts.push(`<text x="${cx}" y="${Math.round(cy)}" text-anchor="middle" font-family="${escXml(getFamily(st.font))}" font-size="${st.size}" fill="${escXml(st.color || '#111110')}">${escXml(st.text)}</text>`);
  }
  if (variation?.aboveFrame) aboveParts.push(...variationParts);
  else parts.push(...variationParts);

  // Free text layers — each defaults to painting below the frame, unless its
  // own aboveFrame flag says otherwise (see frameParts/aboveParts above).
  // A layer docked to a banner uses that banner's computed stack position
  // instead of its own stored x/y/w (see dockedLayerPositions).
  const textLayers = state.textLayers || [];
  const hideTL = state.hideTextLayers || [];
  const dockPosByWhich = { top: dockedLayerPositions(state, 'top'), bottom: dockedLayerPositions(state, 'bottom') };
  textLayers.forEach(layer => {
    if (!layer.text || !layer.text.trim()) return;
    if (hideTL.includes(layer.id)) return;
    const dockPos = layer.dock ? dockPosByWhich[layer.dock]?.[layer.id] : null;
    const effX = dockPos ? dockPos.x : layer.x;
    const effY = dockPos ? dockPos.y : layer.y;
    const effW = dockPos ? dockPos.w : layer.w;
    const lines = wrapText(layer.text, effW, layer.size);
    const lineH = layer.size * 1.1;
    const anchor = layer.align === 'left' ? 'start' : layer.align === 'right' ? 'end' : 'middle';
    const tx = layer.align === 'left' ? effX : layer.align === 'right' ? effX + effW : effX + effW / 2;
    const firstBaseY = effY + layer.size * 0.82;
    const tspans = lines.map((line, i) =>
      `<tspan x="${tx}"${i === 0 ? '' : ` dy="${lineH}"`}>${escXml(line)}</tspan>`
    ).join('');
    const markup = `<text data-tl-id="${layer.id}" x="${tx}" y="${Math.round(firstBaseY)}" text-anchor="${anchor}" font-family="${escXml(getFamily(layer.font))}" font-size="${layer.size}" fill="${escXml(layer.color || '#111110')}">${tspans}</text>`;
    // A docked layer must paint above the frame group (which contains the
    // banner's own background rect) or it renders invisibly behind it — see
    // frameParts/aboveParts flush order below.
    if (layer.aboveFrame || layer.dock) aboveParts.push(markup);
    else parts.push(markup);
  });

  // Wrapped in an identifiable group so a caller that needs to render the
  // logo/sponsor-text as a separate interactive DOM overlay (var-canvas.js's
  // dzone, which can't participate in this SVG's own z-order) can pull the
  // frame back out into its own overlay layer and still stack correctly.
  if (frameParts.length) parts.push(`<g class="hs-frame">${frameParts.join('')}</g>`);
  parts.push(...aboveParts);
  parts.push(`</svg>`);
  return { content: parts.join('\n'), viewBox };
}

export function renderHoleSignInto(el, state, variation) {
  const { content } = makeHoleSignSvg(state, variation);
  el.innerHTML = content;
}
