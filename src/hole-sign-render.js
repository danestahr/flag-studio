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

// Wrap the banner's title + sub-text to the band width and return the line
// breakdown plus the total stacked text height (in sign coords).
function bannerTextBlock(banner) {
  const title = banner.topText || {};
  const sub = banner.subText || {};
  const hasTitle = !!(title.text && title.text.trim());
  const hasSub = !!(sub.text && sub.text.trim());
  const titleBox = fitTextBox(title.w, title.size);
  const subBox = fitTextBox(sub.w, sub.size);
  const titleLines = hasTitle ? wrapText(title.text, titleBox.w, title.size) : [];
  const subLines = hasSub ? wrapText(sub.text, subBox.w, sub.size) : [];
  const titleLineH = (title.size || 0) * 1.1;
  const subLineH = (sub.size || 0) * 1.1;
  const gap = (titleLines.length && subLines.length) ? Math.round((title.size || 0) * 0.2) + (banner.spacing || 0) : 0;
  const total = titleLines.length * titleLineH + subLines.length * subLineH + gap;
  return { title, sub, titleLines, subLines, titleLineH, subLineH, gap, total, titleBox, subBox };
}

// Vertical breathing room reserved above/below the title+sub text block —
// shared by bannerEffectiveHeight (total padding) and renderBanner (per-side,
// for top/bottom valign) so they always agree on how much space is set aside.
function bannerTextVPad(tb) {
  return Math.round(Math.max(tb.title.size || 0, tb.sub.size || 0) * 0.45);
}

// Top-of-title / top-of-sub y positions (sign coords) for a banner whose
// title is present, honoring banner.valign — same math as renderBanner uses
// to draw the actual SVG text, so click-to-edit zones/resize handles (and the
// "+ Add subtitle" affordance) land exactly where the text really is instead
// of a naive half-the-box split.
// `forceSub`: when the sub is empty but is about to be edited (the user just
// clicked "+ Add subtitle"), reserve a nominal one-line height/gap for it so
// the forced click-to-edit region has somewhere real to sit — mirrors the
// oneLine() placeholder sizing used for empty top/bottom text.
export function bannerTitleSubSplit(banner, rect, forceSub = false) {
  const tb = bannerTextBlock(banner);
  const valign = banner.valign || 'center';
  const vpad = bannerTextVPad(tb);
  const hasRealSub = tb.subLines.length > 0;
  const subH = hasRealSub ? tb.subLines.length * tb.subLineH
    : forceSub ? Math.round((banner.subText?.size || 140) * 1.1 + 40) : 0;
  const gap = hasRealSub ? tb.gap
    : (forceSub && subH) ? Math.round((tb.title.size || 0) * 0.2) : 0;
  const total = tb.titleLines.length * tb.titleLineH + subH + gap;
  const titleY = valign === 'top' ? rect.y + vpad
    : valign === 'bottom' ? rect.y + rect.h - vpad - total
    : rect.y + rect.h / 2 - total / 2;
  const titleH = tb.titleLines.length * tb.titleLineH;
  return { titleY, titleH, subY: titleY + titleH + gap, subH };
}

// Banner height actually used for layout + render: never shorter than the
// wrapped text needs (with vertical padding), so text never overflows the band
// and the band grows automatically as text wraps.
function bannerEffectiveHeight(banner) {
  if (!banner || !banner.enabled) return 0;
  const tb = bannerTextBlock(banner);
  if (tb.total <= 0) return Math.max(0, banner.height || 0);
  return Math.max(banner.height || 0, tb.total + bannerTextVPad(tb) * 2);
}

function computeLayout(state, templateId) {
  // Each banner band independently reserves height at its fixed edge before any
  // other content is placed, so the logo zone and text bands shrink to fit.
  const bTopEff = bannerEffectiveHeight(state.bannerTop);
  const bBotEff = bannerEffectiveHeight(state.bannerBottom);
  const bannerTopH = (state.bannerTop?.enabled && bTopEff > 0) ? bTopEff : 0;
  const bannerBotH = (state.bannerBottom?.enabled && bBotEff > 0) ? bBotEff : 0;

  if (templateId === 'hole-sign-full-graphic') {
    return { topH: 0, botH: 0,
             logoY: 0, logoH: HS_H,
             stripY: 0, stripH: 0, bannerTopH: 0, bannerBotH: 0,
             topTextX: HS_W / 2, topTextAnchor: 'middle',
             botTextX: HS_W / 2, botTextAnchor: 'middle' };
  }
  if (templateId === 'hole-sign-logo-only') {
    return { topH: 0, botH: 0,
             logoY: bannerTopH + HS_MARGIN,
             logoH: Math.max(0, HS_H - bannerTopH - bannerBotH - 2 * HS_MARGIN),
             stripY: 0, stripH: 0, bannerTopH, bannerBotH,
             topTextX: HS_W / 2, topTextAnchor: 'middle',
             botTextX: HS_W / 2, botTextAnchor: 'middle' };
  }
  const top = state.topText;
  const bot = state.bottomText;
  const topBox = fitTextBox(top.w, top.size);
  const botBox = fitTextBox(bot.w, bot.size);

  // Template logos are free-positioned; text bands are independent of logo placement.
  const topWrappedLines = (top.text && top.text.trim()) ? wrapText(top.text, topBox.w, top.size) : [];
  const botWrappedLines = (bot.text && bot.text.trim()) ? wrapText(bot.text, botBox.w, bot.size) : [];
  const topLines = topWrappedLines.length;
  const botLines = botWrappedLines.length;
  const topTextH = topLines ? Math.round(topLines * top.size * 1.1 + 80) : 0;
  const botTextH = botLines ? Math.round(botLines * bot.size * 1.1 + 80) : 0;

  const topBandH = topTextH;
  const botBandH = botTextH;
  const topGap = topBandH > 0 ? HS_GAP : 0;
  const botGap = botBandH > 0 ? HS_GAP : 0;

  // Sponsor logo zone uses everything between the text bands (after the banner).
  const logoY = bannerTopH + HS_MARGIN + topBandH + topGap;
  const logoH = Math.max(0, HS_H - bannerTopH - bannerBotH - 2 * HS_MARGIN - topBandH - topGap - botBandH - botGap);

  // Default strip Y for template-logo initial placement (slots with no freeX set).
  // Placed at the start of the logo zone; bottom vAlign flips to the bottom edge.
  const tl = state.templateLogos;
  const tll = computeTemplateLogoLayout(tl);
  const stripH = tll ? tll.stripH : 0;
  let stripY = logoY;
  if (tl?.vAlign === 'bottom') {
    stripY = HS_H - bannerBotH - HS_MARGIN - botBandH - (botBandH > 0 ? HS_GAP : 0) - stripH;
  }

  return { topH: topBandH, botH: botBandH, logoY, logoH, stripY, stripH, bannerTopH, bannerBotH,
           topTextX: HS_W / 2, topTextAnchor: 'middle', topTextMaxW: topBox.w, topTextBoxX: topBox.x, topWrappedLines,
           botTextX: HS_W / 2, botTextAnchor: 'middle', botTextMaxW: botBox.w, botTextBoxX: botBox.x, botWrappedLines };
}

// Full-width banner band rect (sign coords), or null when that banner is off.
// `which` is 'top' | 'bottom'.
export function getBannerRect(state, which) {
  const b = which === 'bottom' ? state.bannerBottom : state.bannerTop;
  const h = bannerEffectiveHeight(b);
  if (!b || !b.enabled || !(h > 0)) return null;
  const y = which === 'bottom' ? HS_H - h : 0;
  return { x: 0, y, w: HS_W, h };
}

// Editable text band rects (sign coords) keyed by target: top, bottom,
// bannerTitle, bannerSub. Used to place inline click-to-edit overlays on the
// canvas. Only includes a region when that text band actually has space.
export function getTextRegions(state, templateId, forceText = []) {
  const tid = templateId || state.templateStyle || 'hole-sign-1';
  const L = computeLayout(state, tid);
  const regions = {};
  if (tid !== 'hole-sign-logo-only') {
    // While a band is being edited, keep a single-line region even if the text
    // is momentarily empty, so clearing the text doesn't dismiss the editor.
    const oneLine = size => Math.round((size || 200) * 1.1 + 80);
    const topBox = fitTextBox(state.topText.w, state.topText.size);
    const botBox = fitTextBox(state.bottomText.w, state.bottomText.size);
    if (L.topH > 0) regions.top = { x: topBox.x, y: L.bannerTopH + HS_MARGIN, w: topBox.w, h: L.topH };
    else if (forceText.includes('top')) regions.top = { x: topBox.x, y: L.bannerTopH + HS_MARGIN, w: topBox.w, h: oneLine(state.topText.size) };
    if (L.botH > 0) regions.bottom = { x: botBox.x, y: HS_H - L.bannerBotH - HS_MARGIN - L.botH, w: botBox.w, h: L.botH };
    else if (forceText.includes('bottom')) { const h = oneLine(state.bottomText.size); regions.bottom = { x: botBox.x, y: HS_H - L.bannerBotH - HS_MARGIN - h, w: botBox.w, h }; }
  }
  const brTop = getBannerRect(state, 'top');
  if (brTop) {
    const banner = state.bannerTop || {};
    const hasSub   = !!(banner.subText?.text  || '').trim();
    const titleBox = fitTextBox(banner.topText?.w, banner.topText?.size);
    const subBox   = fitTextBox(banner.subText?.w, banner.subText?.size);
    const forceSub = forceText.includes('bannerTopSub');
    // The subtitle's own region/handle must not depend on the title still
    // having text — otherwise momentarily clearing the title (e.g. to retype
    // it) makes the subtitle's edit zone and spacing handle vanish even
    // though the subtitle itself keeps rendering (bannerTextBlock doesn't
    // require a title either).
    if (hasSub || forceSub) {
      const { titleY, titleH, subY, subH } = bannerTitleSubSplit(banner, brTop, forceSub);
      regions.bannerTopTitle = { x: titleBox.x, y: titleY, w: titleBox.w, h: titleH };
      regions.bannerTopSub   = { x: subBox.x,   y: subY,   w: subBox.w,   h: subH };
    } else {
      regions.bannerTopTitle = { x: titleBox.x, y: brTop.y, w: titleBox.w, h: brTop.h };
    }
  }
  const brBot = getBannerRect(state, 'bottom');
  if (brBot) {
    const banner = state.bannerBottom || {};
    const hasSub   = !!(banner.subText?.text  || '').trim();
    const titleBox = fitTextBox(banner.topText?.w, banner.topText?.size);
    const subBox   = fitTextBox(banner.subText?.w, banner.subText?.size);
    const forceSub = forceText.includes('bannerBotSub');
    if (hasSub || forceSub) {
      const { titleY, titleH, subY, subH } = bannerTitleSubSplit(banner, brBot, forceSub);
      regions.bannerBotTitle = { x: titleBox.x, y: titleY, w: titleBox.w, h: titleH };
      regions.bannerBotSub   = { x: subBox.x,   y: subY,   w: subBox.w,   h: subH };
    } else {
      regions.bannerBotTitle = { x: titleBox.x, y: brBot.y, w: titleBox.w, h: brBot.h };
    }
  }
  return regions;
}

export function getLogoZone(state, templateId) {
  const tid = templateId || state.templateStyle || 'hole-sign-1';
  if (tid === 'hole-sign-full-graphic') return { x: 0, y: 0, w: HS_W, h: HS_H };
  const { logoY, logoH, stripY, stripH } = computeLayout(state, tid);
  const x = HS_MARGIN, w = HS_W - 2 * HS_MARGIN;
  if (tid === 'hole-sign-logo-only') return { x, y: logoY, w, h: logoH };

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
  if (tid === 'hole-sign-logo-only' || tid === 'hole-sign-full-graphic') return [];
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

// Build SVG markup for a banner band (background + title/sub-text).
// `position` is 'top' | 'bottom'; hide keys are bannerTopTitle/bannerTopSub/bannerBotTitle/bannerBotSub.
// Returns an array of SVG string parts, or [] when the banner is disabled.
function renderBanner(banner, getFamily, hide = [], position = 'top') {
  const h = bannerEffectiveHeight(banner);
  if (!banner || !banner.enabled || !(h > 0)) return [];
  const y = position === 'bottom' ? HS_H - h : 0;
  const bg = banner.bg || {};
  const parts = [];
  const clipId = position === 'bottom' ? 'bannerBotClip' : 'bannerTopClip';
  const titleKey = position === 'bottom' ? 'bannerBotTitle' : 'bannerTopTitle';
  const subKey   = position === 'bottom' ? 'bannerBotSub'   : 'bannerTopSub';
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
  const alignAttrs = (t, box) => {
    const a = t.align || 'center';
    const anchor = a === 'left' ? 'start' : a === 'right' ? 'end' : 'middle';
    const x = a === 'left' ? box.x : a === 'right' ? box.x + box.w : HS_W / 2;
    return { x, anchor };
  };
  const tb = bannerTextBlock(banner);
  if (tb.total > 0) {
    const { title, sub, titleLines, subLines, titleLineH, subLineH, gap, titleBox, subBox } = tb;
    const valign = banner.valign || 'center';
    const vpad = bannerTextVPad(tb);
    let topY = valign === 'top' ? y + vpad
      : valign === 'bottom' ? y + h - vpad - tb.total
      : y + h / 2 - tb.total / 2;
    if (titleLines.length) {
      if (!hide.includes(titleKey)) {
        const { x: tx, anchor: ta } = alignAttrs(title, titleBox);
        const tspans = titleLines.map((line, i) => `<tspan x="${tx}"${i === 0 ? '' : ` dy="${titleLineH}"`}>${escXml(line)}</tspan>`).join('');
        parts.push(`<text x="${tx}" y="${Math.round(topY + title.size * 0.82)}" text-anchor="${ta}" font-family="${escXml(getFamily(title.font))}" font-size="${title.size}" fill="${escXml(title.color || '#111110')}">${tspans}</text>`);
      }
      topY += titleLines.length * titleLineH + gap;
    }
    if (subLines.length && !hide.includes(subKey)) {
      const { x: sx, anchor: sa } = alignAttrs(sub, subBox);
      const tspans = subLines.map((line, i) => `<tspan x="${sx}"${i === 0 ? '' : ` dy="${subLineH}"`}>${escXml(line)}</tspan>`).join('');
      parts.push(`<text x="${sx}" y="${Math.round(topY + sub.size * 0.82)}" text-anchor="${sa}" font-family="${escXml(getFamily(sub.font))}" font-size="${sub.size}" fill="${escXml(sub.color || '#111110')}">${tspans}</text>`);
    }
  }
  return parts;
}

export function makeHoleSignSvg(state, variation) {
  // state.templateStyle comes from getEffectiveState() which correctly resolves
  // per-variation overrides. Prefer it over variation.templateId which can be a
  // stale value set when the variation was first created.
  const templateId = state.templateStyle || variation?.templateId || 'hole-sign-1';
  let { topH, botH, logoY, logoH, bannerTopH, bannerBotH, topTextX, topTextAnchor, topTextMaxW, topTextBoxX, botTextX, botTextAnchor, botTextMaxW, botTextBoxX, topWrappedLines, botWrappedLines } = computeLayout(state, templateId);
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

  // Banner bands skipped for full-graphic (image owns the entire canvas)
  if (templateId !== 'hole-sign-full-graphic') {
    parts.push(...renderBanner(state.bannerTop,    getFamily, hide, 'top'));
    parts.push(...renderBanner(state.bannerBottom, getFamily, hide, 'bottom'));
  }

  // Top text (standard template only)
  if (templateId !== 'hole-sign-logo-only' && topH > 0 && topText.text && topText.text.trim() && !hide.includes('top')) {
    const lines = topWrappedLines?.length ? topWrappedLines : wrapText(topText.text, topTextMaxW, topText.size);
    const lineH = topText.size * 1.1;
    const bandCY = bannerTopH + HS_MARGIN + topH / 2;
    const firstBaseY = bandCY - (lines.length - 1) * lineH / 2 + topText.size * 0.38;
    const tspans = lines.map((line, i) =>
      `<tspan x="${topTextX}"${i === 0 ? '' : ` dy="${lineH}"`}>${escXml(line)}</tspan>`
    ).join('');
    parts.push(`<text x="${topTextX}" y="${Math.round(firstBaseY)}" text-anchor="${topTextAnchor}" font-family="${escXml(getFamily(topText.font))}" font-size="${topText.size}" fill="${escXml(topText.color || '#111110')}">${tspans}</text>`);
  }

  // Template logos (drawn into the strip carved out by computeLayout)
  const tplSlots = getTemplateLogoSlots(state, templateId);
  if (tplSlots.length && state.templateLogos?.slots) {
    state.templateLogos.slots.forEach((slot, i) => {
      const rect = tplSlots[i];
      if (!rect) return;
      parts.push(renderTemplateLogoSlot(slot, rect, `tlc${i}`));
    });
  }

  // Logo (raster/SVG image) OR sponsor text fallback when no logo
  if (variation && variation.logoSrc && templateId === 'hole-sign-full-graphic') {
    const src = variation.logoSrcTight || variation.logoSrc;
    if (isDisplayableImage(src)) {
      parts.push(`<image href="${escXml(src)}" x="0" y="0" width="${HS_W}" height="${HS_H}" preserveAspectRatio="xMidYMid meet"/>`);
    } else {
      parts.push(filePlaceholderSvg(0, 0, HS_W, HS_H, fileTypeLabel(src)));
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
      parts.push(`<image href="${escXml(src)}" x="${Math.round(cx - logoW / 2)}" y="${Math.round(cy - logoImgH / 2)}" width="${Math.round(logoW)}" height="${Math.round(logoImgH)}" preserveAspectRatio="xMidYMid meet"/>`);
    } else {
      parts.push(filePlaceholderSvg(lz.x, lz.y, lz.w, lz.h, fileTypeLabel(src)));
    }
  } else if (variation && variation.sponsorText && variation.sponsorText.text && variation.sponsorText.text.trim()) {
    const st = variation.sponsorText;
    const lz = getLogoZone(state, templateId);
    const cx = lz.x + lz.w / 2;
    const cy = lz.y + lz.h / 2 + st.size * 0.38;
    parts.push(`<text x="${cx}" y="${Math.round(cy)}" text-anchor="middle" font-family="${escXml(getFamily(st.font))}" font-size="${st.size}" fill="${escXml(st.color || '#111110')}">${escXml(st.text)}</text>`);
  }

  // Bottom text (standard template only)
  if (templateId !== 'hole-sign-logo-only' && botH > 0 && bottomText.text && bottomText.text.trim() && !hide.includes('bottom')) {
    const lines = botWrappedLines?.length ? botWrappedLines : wrapText(bottomText.text, botTextMaxW, bottomText.size);
    const lineH = bottomText.size * 1.1;
    const bandCY = HS_H - bannerBotH - HS_MARGIN - botH / 2;
    const firstBaseY = bandCY - (lines.length - 1) * lineH / 2 + bottomText.size * 0.38;
    const tspans = lines.map((line, i) =>
      `<tspan x="${botTextX}"${i === 0 ? '' : ` dy="${lineH}"`}>${escXml(line)}</tspan>`
    ).join('');
    parts.push(`<text x="${botTextX}" y="${Math.round(firstBaseY)}" text-anchor="${botTextAnchor}" font-family="${escXml(getFamily(bottomText.font))}" font-size="${bottomText.size}" fill="${escXml(bottomText.color || '#111110')}">${tspans}</text>`);
  }

  // Free text layers
  const textLayers = state.textLayers || [];
  const hideTL = state.hideTextLayers || [];
  textLayers.forEach(layer => {
    if (!layer.text || !layer.text.trim()) return;
    if (hideTL.includes(layer.id)) return;
    const lines = wrapText(layer.text, layer.w, layer.size);
    const lineH = layer.size * 1.1;
    const anchor = layer.align === 'left' ? 'start' : layer.align === 'right' ? 'end' : 'middle';
    const tx = layer.align === 'left' ? layer.x : layer.align === 'right' ? layer.x + layer.w : layer.x + layer.w / 2;
    const firstBaseY = layer.y + layer.size * 0.82;
    const tspans = lines.map((line, i) =>
      `<tspan x="${tx}"${i === 0 ? '' : ` dy="${lineH}"`}>${escXml(line)}</tspan>`
    ).join('');
    parts.push(`<text data-tl-id="${layer.id}" x="${tx}" y="${Math.round(firstBaseY)}" text-anchor="${anchor}" font-family="${escXml(getFamily(layer.font))}" font-size="${layer.size}" fill="${escXml(layer.color || '#111110')}">${tspans}</text>`);
  });

  parts.push(`</svg>`);
  return { content: parts.join('\n'), viewBox };
}

export function renderHoleSignInto(el, state, variation) {
  const { content } = makeHoleSignSvg(state, variation);
  el.innerHTML = content;
}
