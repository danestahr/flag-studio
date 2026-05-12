import { HS_W, HS_H, HS_MARGIN, HS_GAP, HS_FONTS } from './hole-sign-data.js';

export function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function computeLayout(state, templateId) {
  if (templateId === 'hole-sign-logo-only') {
    return { topH: 0, botH: 0, topGap: 0, botGap: 0,
             logoY: HS_MARGIN, logoH: HS_H - 2 * HS_MARGIN };
  }
  // Standard: logo centered with optional top/bottom text
  const top = state.topText;
  const bot = state.bottomText;
  const topH = (top.text && top.text.trim()) ? Math.round(top.size * 1.4 + 80) : 0;
  const botH = (bot.text && bot.text.trim()) ? Math.round(bot.size * 1.4 + 80) : 0;
  const topGap = topH > 0 ? HS_GAP : 0;
  const botGap = botH > 0 ? HS_GAP : 0;
  const logoY = HS_MARGIN + topH + topGap;
  const logoH = HS_H - 2 * HS_MARGIN - topH - topGap - botH - botGap;
  return { topH, botH, topGap, botGap, logoY, logoH };
}

export function getLogoZone(state, templateId) {
  const tid = templateId || state.templateStyle || 'hole-sign-1';
  const { logoY, logoH } = computeLayout(state, tid);
  return { x: HS_MARGIN, y: logoY, w: HS_W - 2 * HS_MARGIN, h: logoH };
}

export function makeHoleSignSvg(state, variation) {
  const templateId = variation?.templateId || state.templateStyle || 'hole-sign-1';
  const { topH, botH, logoY, logoH } = computeLayout(state, templateId);
  const viewBox = `0 0 ${HS_W} ${HS_H}`;
  const bg = state.background;
  const topText = state.topText;
  const bottomText = state.bottomText;

  const getFamily = (fontId) => {
    const f = HS_FONTS.find(f => f.id === fontId);
    return f ? f.family : "'DM Sans', sans-serif";
  };

  let parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox}" width="${HS_W}" height="${HS_H}">`);

  // Background
  parts.push(`<rect x="0" y="0" width="${HS_W}" height="${HS_H}" fill="${escXml(bg.color || '#1A3A6B')}"/>`);
  if (bg.type === 'image' && bg.imageUrl) {
    parts.push(`<image href="${escXml(bg.imageUrl)}" x="0" y="0" width="${HS_W}" height="${HS_H}" preserveAspectRatio="xMidYMid slice"/>`);
  }

  // Top text (standard template only)
  if (templateId !== 'hole-sign-logo-only' && topH > 0 && topText.text && topText.text.trim()) {
    const textY = HS_MARGIN + topH / 2 + topText.size * 0.38;
    parts.push(`<text x="${HS_W / 2}" y="${Math.round(textY)}" text-anchor="middle" font-family="${escXml(getFamily(topText.font))}" font-size="${topText.size}" fill="${escXml(topText.color || '#FFFFFF')}">${escXml(topText.text)}</text>`);
  }

  // Logo
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
  }

  // Bottom text (standard template only)
  if (templateId !== 'hole-sign-logo-only' && botH > 0 && bottomText.text && bottomText.text.trim()) {
    const textY = HS_H - HS_MARGIN - botH + botH / 2 + bottomText.size * 0.38;
    parts.push(`<text x="${HS_W / 2}" y="${Math.round(textY)}" text-anchor="middle" font-family="${escXml(getFamily(bottomText.font))}" font-size="${bottomText.size}" fill="${escXml(bottomText.color || '#FFFFFF')}">${escXml(bottomText.text)}</text>`);
  }

  parts.push(`</svg>`);
  return { content: parts.join('\n'), viewBox };
}

export function renderHoleSignInto(el, state, variation) {
  const { content } = makeHoleSignSvg(state, variation);
  el.innerHTML = content;
}
