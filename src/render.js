import { S } from './state.js';
import { FLAGS } from './data.js';
import { isLightColor } from './gsTag.js';
import { HS_FONTS } from './hole-sign-data.js';

export const getFlag = () => FLAGS.find(f => f.id === S.flagId);

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

export function showGsTagVariant(svg, style, face = 'front') {
  const tagGroup = svg.querySelector('[id="GolfStatus Tag"]');
  if (!tagGroup) return;
  if (face === 'back') {
    const cx = gsTagCenterX(tagGroup);
    tagGroup.setAttribute('transform', `translate(${(2 * cx).toFixed(1)},0) scale(-1,1)`);
  } else {
    tagGroup.removeAttribute('transform');
  }
  tagGroup.removeAttribute('display');
  const baseStyle = style === 'Custom' ? 'Dark' : style;
  const activeId = `${face === 'back' ? 'Back' : 'Front'} - ${baseStyle} Tag`;
  ['Front - Dark Tag', 'Front - Light Tag', 'Back - Dark Tag', 'Back - Light Tag'].forEach(id => {
    const el = tagGroup.querySelector(`[id="${id}"]`);
    if (el) el.setAttribute('display', id === activeId ? '' : 'none');
  });
  if (style === 'Custom' && S.gsTagColor) {
    const activeEl = tagGroup.querySelector(`[id="${activeId}"]`);
    if (activeEl) activeEl.querySelectorAll('path').forEach(p => p.setAttribute('fill', S.gsTagColor));
  }
}

export function applyColors(svgEl, colors, skipColors = false) {
  svgEl.setAttribute('fill', 'none'); // original SVGs have fill="none" on root; preserve when injecting innerHTML
  svgEl.querySelectorAll('[id*="logo-placement"]').forEach(g => g.setAttribute('display', 'none'));
  svgEl.querySelectorAll('[id="GolfStatus Tag"]').forEach(g => g.setAttribute('display', 'none'));
  if (skipColors) return;
  Object.entries(colors).forEach(([zid, hex]) => {
    if (!hex) return;
    const el = svgEl.querySelector('#' + zid);
    if (!el) return;
    el.setAttribute('fill', hex);
    el.querySelectorAll('rect,path,polygon,circle,ellipse').forEach(c => {
      if (!c.closest('[id^="Bleed"]')) c.setAttribute('fill', hex);
    });
  });
  Object.entries(colors).forEach(([zid, hex]) => {
    if (!hex) return;
    svgEl.querySelectorAll('[id^="' + zid + '"]').forEach(el => el.setAttribute('fill', hex));
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

export function makeSvg(logos, w, h, face = 'front', mirrorX = false, flagOverride = null, colorsOverride = null, textLayers = []) {
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
  applyColors(svg, colors, flag.noColors);

  const list = normaliseLogos(logos);
  if (zone && list.length) {
    const zoneX = face === 'back' ? vbW - zone.x - zone.w : zone.x;
    list.forEach(layer => {
      const logo = S.library.find(l => l.id === layer.logoId);
      if (!logo) return;
      const logoW = zone.w * (layer.w / 100);
      const logoH = zone.h * (layer.w / 100);
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
  if (S.gsTag) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    const keyHex = colors[keyZone];
    const style = S.gsTagMode === 'light' ? 'Dark'
      : S.gsTagMode === 'dark' ? 'Light'
      : keyHex ? (isLightColor(keyHex) ? 'Light' : 'Dark')
      : (flag.tagKeyZone ? 'Light' : 'Dark');
    showGsTagVariant(svg, style, face);
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

      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', cx);
      t.setAttribute('y', cy);
      t.setAttribute('font-family', fontFamily);
      t.setAttribute('font-size', fsSvg);
      t.setAttribute('fill', layer.color || '#000000');
      t.setAttribute('text-anchor', textAnchor);
      t.textContent = layer.text;
      svg.appendChild(t);
    });
  }

  return svg;
}

export function renderInto(el, logos, face = 'front', mirrorX = false, flagOverride = null, colorsOverride = null, textLayers = []) {
  el.innerHTML = '';
  const svg = makeSvg(logos, '100%', '100%', face, mirrorX, flagOverride, colorsOverride, textLayers);
  if (svg) {
    svg.style.cssText = 'display:block;width:100%;height:100%';
    el.appendChild(svg);
  }
}
