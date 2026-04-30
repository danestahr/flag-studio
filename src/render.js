import { S } from './state.js';
import { FLAGS } from './data.js';

export const getFlag = () => FLAGS.find(f => f.id === S.flagId);

export function applyColors(svgEl, colors) {
  Object.entries(colors).forEach(([zid, hex]) => {
    const el = svgEl.querySelector('#' + zid);
    if (!el) return;
    el.setAttribute('fill', hex);
    el.querySelectorAll('rect,path,polygon,circle,ellipse').forEach(c => c.setAttribute('fill', hex));
  });
}

export function makeSvg(assignment, w, h, flagOverride) {
  const flag = flagOverride || getFlag();
  if (!flag) return null;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4670');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('xmlns', ns);
  svg.innerHTML = flag.svgContent;
  applyColors(svg, S.colors);
  flag.logoZones.forEach(zone => {
    const lid = assignment[zone.id];
    const logo = S.library.find(l => l.id === lid);
    if (!logo) return;
    const img = document.createElementNS(ns, 'image');
    img.setAttribute('href', logo.src);
    img.setAttribute('x', zone.x);
    img.setAttribute('y', zone.y);
    img.setAttribute('width', zone.w);
    img.setAttribute('height', zone.h);
    img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.appendChild(img);
  });
  return svg;
}

export function renderInto(el, assignment) {
  el.innerHTML = '';
  const svg = makeSvg(assignment, '100%', '100%');
  if (svg) {
    svg.style.cssText = 'display:block;width:100%;height:100%';
    el.appendChild(svg);
  }
}
