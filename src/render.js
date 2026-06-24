import { S } from './state.js';
import { FLAGS } from './data.js';

export const getFlag = () => FLAGS.find(f => f.id === S.flagId);

// Normalises both old string-format and new object-format assignments
export function getLogoData(assignment, zoneId) {
  const val = assignment[zoneId];
  if (!val) return null;
  if (typeof val === 'string') return { id: val, x: 50, y: 50, w: 80 };
  return val;
}

export function applyColors(svgEl, colors) {
  // First pass: paint each zone root and all its descendant shapes.
  Object.entries(colors).forEach(([zid, hex]) => {
    const el = svgEl.querySelector('#' + zid);
    if (!el) return;
    el.setAttribute('fill', hex);
    el.querySelectorAll('rect,path,polygon,circle,ellipse').forEach(c => c.setAttribute('fill', hex));
  });
  // Second pass: correct any cross-zone overwrites. Elements like zone-primary_2
  // nested inside a zone-secondary group get the wrong color in the sweep above.
  // Re-apply each zone's color to every element whose id starts with that prefix.
  Object.entries(colors).forEach(([zid, hex]) => {
    svgEl.querySelectorAll('[id^="' + zid + '"]').forEach(el => {
      el.setAttribute('fill', hex);
    });
  });
  // Hide any logo-placement guide groups regardless of whether the SVG uses
  // 'logo-placement' or '#logo-placement' as the id value.
  svgEl.querySelectorAll('[id*="logo-placement"]').forEach(g => g.setAttribute('display', 'none'));
}

export function makeSvg(assignment, w, h, face = 'front', mirrorX = false) {
  const flag = getFlag();
  if (!flag) return null;
  const vbW = +((flag.viewBox || '0 0 7519 4669').split(' ')[2]);
  const ns = 'http://www.w3.org/2000/svg';
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
  applyColors(svg, S.colors);
  flag.logoZones.forEach(zone => {
    const ld = getLogoData(assignment, zone.id);
    if (!ld) return;
    const logo = S.library.find(l => l.id === ld.id);
    if (!logo) return;

    const zoneX = face === 'back' ? vbW - zone.x - zone.w : zone.x;
    const logoW = zone.w * (ld.w / 100);
    const logoH = zone.h * (ld.w / 100);
    const xFrac = (face === 'back' && mirrorX) ? (1 - ld.x / 100) : (ld.x / 100);
    const cx = zoneX + xFrac * zone.w;
    const cy = zone.y  + (ld.y / 100) * zone.h;

    const img = document.createElementNS(ns, 'image');
    img.setAttribute('href', logo.src);
    img.setAttribute('x', cx - logoW / 2);
    img.setAttribute('y', cy - logoH / 2);
    img.setAttribute('width', logoW);
    img.setAttribute('height', logoH);
    img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.appendChild(img);
  });
  return svg;
}

export function renderInto(el, assignment, face = 'front', mirrorX = false) {
  el.innerHTML = '';
  const svg = makeSvg(assignment, '100%', '100%', face, mirrorX);
  if (svg) {
    svg.style.cssText = 'display:block;width:100%;height:100%';
    el.appendChild(svg);
  }
}
