import { HS_W, HS_H, HS_MARGIN, HS_GAP, HS_FONTS, normalizeTplLogoSize } from './hole-sign-data.js';

export function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Slot width for the configured ratio. `fit` follows the logo's natural aspect
// (using logoAspect = h/w); the rest are simple width:height factors.
function slotWidthForRatio(slot, slotH) {
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

  let stripH;
  if (tl.hAlign === 'spread' || tl.stack === 'horizontal') {
    stripH = slotH;
  } else {
    stripH = tl.count * slotH + (tl.count - 1) * gap;
  }

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
  } else if (tl.stack === 'horizontal') {
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
  } else { // vertical stack — column based on the widest slot
    const colW = Math.max(...widths);
    const baseX = tl.hAlign === 'right' ? innerW - colW
                : tl.hAlign === 'center' ? (innerW - colW) / 2
                : 0;
    for (let i = 0; i < tl.count; i++) {
      slotsRel.push({ dx: baseX + (colW - widths[i]) / 2, dy: i * (slotH + gap) });
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
  const maxW = HS_W - 2 * HS_MARGIN;
  const titleLines = hasTitle ? wrapText(title.text, maxW, title.size) : [];
  const subLines = hasSub ? wrapText(sub.text, maxW, sub.size) : [];
  const titleLineH = (title.size || 0) * 1.1;
  const subLineH = (sub.size || 0) * 1.1;
  const gap = (titleLines.length && subLines.length) ? Math.round((title.size || 0) * 0.2) + (banner.spacing || 0) : 0;
  const total = titleLines.length * titleLineH + subLines.length * subLineH + gap;
  return { title, sub, titleLines, subLines, titleLineH, subLineH, gap, total };
}

// Banner height actually used for layout + render: never shorter than the
// wrapped text needs (with vertical padding), so text never overflows the band
// and the band grows automatically as text wraps.
function bannerEffectiveHeight(banner) {
  if (!banner || !banner.enabled) return 0;
  const tb = bannerTextBlock(banner);
  if (tb.total <= 0) return Math.max(0, banner.height || 0);
  const pad = Math.round(Math.max(tb.title.size || 0, tb.sub.size || 0) * 0.45) * 2;
  return Math.max(banner.height || 0, tb.total + pad);
}

function computeLayout(state, templateId) {
  // Each banner band independently reserves height at its fixed edge before any
  // other content is placed, so the logo zone and text bands shrink to fit.
  const bTopEff = bannerEffectiveHeight(state.bannerTop);
  const bBotEff = bannerEffectiveHeight(state.bannerBottom);
  const bannerTopH = (state.bannerTop?.enabled && bTopEff > 0) ? bTopEff : 0;
  const bannerBotH = (state.bannerBottom?.enabled && bBotEff > 0) ? bBotEff : 0;

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

  const tl = state.templateLogos;
  const tll = computeTemplateLogoLayout(tl);
  const stripH = tll ? tll.stripH : 0;

  // Merge the strip band with the text band on the same side: the band's
  // height is the larger of the two, and the text shifts horizontally so it
  // doesn't sit on top of a side-anchored logo group.
  const stripOnTop = tll && tl.vAlign === 'top';
  const stripOnBot = tll && tl.vAlign === 'bottom';

  // Text height grows with the number of wrapped lines so multi-line text never
  // bleeds out of its band. The wrap width matches the render: the full inner
  // width, or the narrower text rect when the band is shared with a logo group.
  const topRect = (stripOnTop && stripH > 0) ? computeTextRect(tl) : null;
  const botRect = (stripOnBot && stripH > 0) ? computeTextRect(tl) : null;
  const topMaxW = topRect ? (topRect.r - topRect.l) : (HS_W - 2 * HS_MARGIN);
  const botMaxW = botRect ? (botRect.r - botRect.l) : (HS_W - 2 * HS_MARGIN);
  const topLines = (top.text && top.text.trim()) ? wrapText(top.text, topMaxW, top.size).length : 0;
  const botLines = (bot.text && bot.text.trim()) ? wrapText(bot.text, botMaxW, bot.size).length : 0;
  const topTextH = topLines ? Math.round(topLines * top.size * 1.1 + 80) : 0;
  const botTextH = botLines ? Math.round(botLines * bot.size * 1.1 + 80) : 0;

  const topBandH = stripOnTop ? Math.max(topTextH, stripH) : topTextH;
  const botBandH = stripOnBot ? Math.max(botTextH, stripH) : botTextH;
  const topGap = topBandH > 0 ? HS_GAP : 0;
  const botGap = botBandH > 0 ? HS_GAP : 0;

  // Sponsor logo zone uses everything between the bands (after the banner).
  const logoY = bannerTopH + HS_MARGIN + topBandH + topGap;
  const logoH = Math.max(0, HS_H - bannerTopH - bannerBotH - 2 * HS_MARGIN - topBandH - topGap - botBandH - botGap);

  // Strip Y: centered inside the merged band on the appropriate side.
  let stripY = 0;
  if (stripOnTop) stripY = bannerTopH + HS_MARGIN + (topBandH - stripH) / 2;
  else if (stripOnBot) stripY = HS_H - bannerBotH - HS_MARGIN - botBandH + (botBandH - stripH) / 2;

  // Carve out the text rect when sharing the band with the strip. Text aligns
  // to the side opposite the logos (left logos → right-aligned text, etc.)
  // and wraps inside its rect.
  const innerW = HS_W - 2 * HS_MARGIN;
  const anchorFor = (h) => h === 'left' ? 'end' : h === 'right' ? 'start' : 'middle';
  const xFor = (rect, anchor) => anchor === 'start' ? rect.l : anchor === 'end' ? rect.r : (rect.l + rect.r) / 2;

  let topTextX = HS_W / 2, topTextAnchor = 'middle', topTextMaxW = innerW;
  let botTextX = HS_W / 2, botTextAnchor = 'middle', botTextMaxW = innerW;
  if (stripOnTop && stripH > 0) {
    const r = computeTextRect(tl);
    if (r) {
      topTextAnchor = anchorFor(tl.hAlign);
      topTextX = xFor(r, topTextAnchor);
      topTextMaxW = r.r - r.l;
    }
  }
  if (stripOnBot && stripH > 0) {
    const r = computeTextRect(tl);
    if (r) {
      botTextAnchor = anchorFor(tl.hAlign);
      botTextX = xFor(r, botTextAnchor);
      botTextMaxW = r.r - r.l;
    }
  }

  return { topH: topBandH, botH: botBandH, logoY, logoH, stripY, stripH, bannerTopH, bannerBotH,
           topTextX, topTextAnchor, topTextMaxW, botTextX, botTextAnchor, botTextMaxW };
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
  const innerW = HS_W - 2 * HS_MARGIN;
  const regions = {};
  if (tid !== 'hole-sign-logo-only') {
    // While a band is being edited, keep a single-line region even if the text
    // is momentarily empty, so clearing the text doesn't dismiss the editor.
    const oneLine = size => Math.round((size || 200) * 1.1 + 80);
    if (L.topH > 0) regions.top = { x: HS_MARGIN, y: L.bannerTopH + HS_MARGIN, w: innerW, h: L.topH };
    else if (forceText.includes('top')) regions.top = { x: HS_MARGIN, y: L.bannerTopH + HS_MARGIN, w: innerW, h: oneLine(state.topText.size) };
    if (L.botH > 0) regions.bottom = { x: HS_MARGIN, y: HS_H - L.bannerBotH - HS_MARGIN - L.botH, w: innerW, h: L.botH };
    else if (forceText.includes('bottom')) { const h = oneLine(state.bottomText.size); regions.bottom = { x: HS_MARGIN, y: HS_H - L.bannerBotH - HS_MARGIN - h, w: innerW, h }; }
  }
  const brTop = getBannerRect(state, 'top');
  if (brTop) {
    const hasTitle = !!(state.bannerTop?.topText?.text || '').trim();
    const hasSub   = !!(state.bannerTop?.subText?.text  || '').trim();
    if (hasTitle && hasSub) {
      regions.bannerTopTitle = { x: HS_MARGIN, y: brTop.y, w: HS_W - 2 * HS_MARGIN, h: brTop.h / 2 };
      regions.bannerTopSub   = { x: HS_MARGIN, y: brTop.y + brTop.h / 2, w: HS_W - 2 * HS_MARGIN, h: brTop.h / 2 };
    } else {
      regions.bannerTopTitle = { x: HS_MARGIN, y: brTop.y, w: HS_W - 2 * HS_MARGIN, h: brTop.h };
    }
  }
  const brBot = getBannerRect(state, 'bottom');
  if (brBot) {
    const hasTitle = !!(state.bannerBottom?.topText?.text || '').trim();
    const hasSub   = !!(state.bannerBottom?.subText?.text  || '').trim();
    if (hasTitle && hasSub) {
      regions.bannerBotTitle = { x: HS_MARGIN, y: brBot.y, w: HS_W - 2 * HS_MARGIN, h: brBot.h / 2 };
      regions.bannerBotSub   = { x: HS_MARGIN, y: brBot.y + brBot.h / 2, w: HS_W - 2 * HS_MARGIN, h: brBot.h / 2 };
    } else {
      regions.bannerBotTitle = { x: HS_MARGIN, y: brBot.y, w: HS_W - 2 * HS_MARGIN, h: brBot.h };
    }
  }
  return regions;
}

export function getLogoZone(state, templateId) {
  const tid = templateId || state.templateStyle || 'hole-sign-1';
  const { logoY, logoH } = computeLayout(state, tid);
  return { x: HS_MARGIN, y: logoY, w: HS_W - 2 * HS_MARGIN, h: logoH };
}

// Available horizontal text rect when text shares the band with the logo strip.
// Returns null for configurations that don't leave room for text (center, or
// spread with count !== 2) — the UI prevents reaching those when text exists.
function computeTextRect(tl) {
  if (!tl || !tl.count) return null;
  const slotH = normalizeTplLogoSize(tl.size);
  const pad = HS_GAP * 2;
  const stack = tl.stack || 'horizontal';
  const gap = HS_GAP * 2;
  const widths = [];
  for (let i = 0; i < tl.count; i++) widths.push(slotWidthForRatio((tl.slots || [])[i], slotH));
  const sum = widths.reduce((s, w) => s + w, 0);
  const groupW = (stack === 'vertical') ? Math.max(...widths) : sum + (tl.count - 1) * gap;

  if (tl.hAlign === 'left') {
    return { l: HS_MARGIN + groupW + pad, r: HS_W - HS_MARGIN };
  }
  if (tl.hAlign === 'right') {
    return { l: HS_MARGIN, r: HS_W - HS_MARGIN - groupW - pad };
  }
  if (tl.hAlign === 'spread' && tl.count === 2) {
    return { l: HS_MARGIN + widths[0] + pad, r: HS_W - HS_MARGIN - widths[1] - pad };
  }
  return null;
}

// Word-wrap text into lines that fit within `maxW`. Width estimated from
// font size — close enough for layout intent, the SVG renderer handles the
// actual glyph metrics.
function wrapText(text, maxW, fontSize) {
  const charW = fontSize * 0.5;
  const maxChars = Math.max(1, Math.floor(maxW / charW));
  // Pre-split any single word longer than a line so it hard-wraps instead of
  // bleeding off the edge.
  const words = [];
  String(text || '').split(/\s+/).filter(Boolean).forEach(w => {
    while (w.length > maxChars) { words.push(w.slice(0, maxChars)); w = w.slice(maxChars); }
    words.push(w);
  });
  if (!words.length) return [];
  const lines = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = cur + ' ' + words[i];
    if (candidate.length <= maxChars) cur = candidate;
    else { lines.push(cur); cur = words[i]; }
  }
  lines.push(cur);
  return lines;
}

// Resolved absolute rects for each template-logo slot. Returns [] when off.
// Slots with freeX/freeY/freeW/freeH use those instead of the computed position.
export function getTemplateLogoSlots(state, templateId) {
  const tid = templateId || state.templateStyle || 'hole-sign-1';
  if (tid === 'hole-sign-logo-only') return [];
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
  const alignAttrs = (t) => {
    const a = t.align || 'center';
    const anchor = a === 'left' ? 'start' : a === 'right' ? 'end' : 'middle';
    const x = a === 'left' ? HS_MARGIN : a === 'right' ? HS_W - HS_MARGIN : HS_W / 2;
    return { x, anchor };
  };
  const tb = bannerTextBlock(banner);
  if (tb.total > 0) {
    const { title, sub, titleLines, subLines, titleLineH, subLineH, gap } = tb;
    let topY = y + h / 2 - tb.total / 2;
    if (titleLines.length) {
      if (!hide.includes(titleKey)) {
        const { x: tx, anchor: ta } = alignAttrs(title);
        const tspans = titleLines.map((line, i) => `<tspan x="${tx}"${i === 0 ? '' : ` dy="${titleLineH}"`}>${escXml(line)}</tspan>`).join('');
        parts.push(`<text x="${tx}" y="${Math.round(topY + title.size * 0.82)}" text-anchor="${ta}" font-family="${escXml(getFamily(title.font))}" font-size="${title.size}" fill="${escXml(title.color || '#111110')}">${tspans}</text>`);
      }
      topY += titleLines.length * titleLineH + gap;
    }
    if (subLines.length && !hide.includes(subKey)) {
      const { x: sx, anchor: sa } = alignAttrs(sub);
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
  let { topH, botH, logoY, logoH, bannerTopH, bannerBotH, topTextX, topTextAnchor, topTextMaxW, botTextX, botTextAnchor, botTextMaxW } = computeLayout(state, templateId);
  const viewBox = `0 0 ${HS_W} ${HS_H}`;
  const bg = state.background;
  const topText = state.topText;
  const bottomText = state.bottomText;
  // Apply explicit text alignment only when the user has deliberately set it
  // (non-center forces the x position; 'center' overrides anchor but keeps the
  // logo-constrained max-width so text doesn't bleed into a logo strip).
  const innerW = HS_W - 2 * HS_MARGIN;
  if (topText.align === 'left' || topText.align === 'right') {
    topTextAnchor = topText.align === 'left' ? 'start' : 'end';
    topTextX      = topText.align === 'left' ? HS_MARGIN : HS_W - HS_MARGIN;
    topTextMaxW   = innerW;
  } else if (topText.align === 'center') {
    topTextAnchor = 'middle';
    topTextX      = HS_W / 2;
  }
  if (bottomText.align === 'left' || bottomText.align === 'right') {
    botTextAnchor = bottomText.align === 'left' ? 'start' : 'end';
    botTextX      = bottomText.align === 'left' ? HS_MARGIN : HS_W - HS_MARGIN;
    botTextMaxW   = innerW;
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

  // Background
  parts.push(`<rect x="0" y="0" width="${HS_W}" height="${HS_H}" fill="${escXml(bg.color || '#FFFFFF')}"/>`);
  if (bg.type === 'image' && bg.imageUrl) {
    parts.push(`<image href="${escXml(bg.imageUrl)}" x="0" y="0" width="${HS_W}" height="${HS_H}" preserveAspectRatio="xMidYMid slice"/>`);
  }

  // Banner bands (full-width strips; reserved by computeLayout)
  parts.push(...renderBanner(state.bannerTop,    getFamily, hide, 'top'));
  parts.push(...renderBanner(state.bannerBottom, getFamily, hide, 'bottom'));

  // Top text (standard template only)
  if (templateId !== 'hole-sign-logo-only' && topH > 0 && topText.text && topText.text.trim() && !hide.includes('top')) {
    const lines = wrapText(topText.text, topTextMaxW, topText.size);
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
  if (variation && variation.logoSrc) {
    const src = variation.logoSrcTight || variation.logoSrc;
    const ld = variation.logoData || { x: 50, y: 50, w: 90 };
    const lz = { x: HS_MARGIN, y: logoY, w: HS_W - 2 * HS_MARGIN, h: logoH };
    const logoW = lz.w * (ld.w / 100);
    const aspect = variation.logoAspect != null ? variation.logoAspect : 1;
    const logoImgH = logoW * aspect;
    const cx = lz.x + (ld.x / 100) * lz.w;
    const cy = lz.y + (ld.y / 100) * lz.h;
    parts.push(`<clipPath id="lzc"><rect x="${lz.x}" y="${lz.y}" width="${lz.w}" height="${lz.h}"/></clipPath>`);
    parts.push(`<image href="${escXml(src)}" x="${Math.round(cx - logoW / 2)}" y="${Math.round(cy - logoImgH / 2)}" width="${Math.round(logoW)}" height="${Math.round(logoImgH)}" preserveAspectRatio="xMidYMid meet" clip-path="url(#lzc)"/>`);
  } else if (variation && variation.sponsorText && variation.sponsorText.text && variation.sponsorText.text.trim()) {
    const st = variation.sponsorText;
    const cx = HS_W / 2;
    const cy = logoY + logoH / 2 + st.size * 0.38;
    parts.push(`<text x="${cx}" y="${Math.round(cy)}" text-anchor="middle" font-family="${escXml(getFamily(st.font))}" font-size="${st.size}" fill="${escXml(st.color || '#111110')}">${escXml(st.text)}</text>`);
  }

  // Bottom text (standard template only)
  if (templateId !== 'hole-sign-logo-only' && botH > 0 && bottomText.text && bottomText.text.trim() && !hide.includes('bottom')) {
    const lines = wrapText(bottomText.text, botTextMaxW, bottomText.size);
    const lineH = bottomText.size * 1.1;
    const bandCY = HS_H - bannerBotH - HS_MARGIN - botH / 2;
    const firstBaseY = bandCY - (lines.length - 1) * lineH / 2 + bottomText.size * 0.38;
    const tspans = lines.map((line, i) =>
      `<tspan x="${botTextX}"${i === 0 ? '' : ` dy="${lineH}"`}>${escXml(line)}</tspan>`
    ).join('');
    parts.push(`<text x="${botTextX}" y="${Math.round(firstBaseY)}" text-anchor="${botTextAnchor}" font-family="${escXml(getFamily(bottomText.font))}" font-size="${bottomText.size}" fill="${escXml(bottomText.color || '#111110')}">${tspans}</text>`);
  }

  parts.push(`</svg>`);
  return { content: parts.join('\n'), viewBox };
}

export function renderHoleSignInto(el, state, variation) {
  const { content } = makeHoleSignSvg(state, variation);
  el.innerHTML = content;
}
