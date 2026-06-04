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
  Object.entries(colors).forEach(([zid, hex]) => {
    const el = svgEl.querySelector('#' + zid);
    if (!el) return;
    el.setAttribute('fill', hex);
    el.querySelectorAll('rect,path,polygon,circle,ellipse').forEach(c => c.setAttribute('fill', hex));
  });
  const logoPlacement = svgEl.querySelector('#logo-placement');
  if (logoPlacement) logoPlacement.setAttribute('display', 'none');
}

export function makeSvg(assignment, w, h, face = 'front') {
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
    const cx = zoneX + (ld.x / 100) * zone.w;
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

export function renderInto(el, assignment, face = 'front') {
  el.innerHTML = '';
  const svg = makeSvg(assignment, '100%', '100%', face);
  if (svg) {
    svg.style.cssText = 'display:block;width:100%;height:100%';
    el.appendChild(svg);
  }
}
