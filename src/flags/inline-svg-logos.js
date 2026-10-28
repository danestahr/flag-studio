// Replaces <image> elements whose source is an SVG file (data:image/svg+xml) with the
// logo's own vector shapes, so the print SVG holds real vectors instead of an SVG nested
// inside an <image>, which Illustrator and most vector tools can't render.
//
// A logo SVG brings its own ids and CSS class names (Illustrator exports .cls-1 { ... }),
// and several logos land in one document, so every id/class is prefixed per logo and the
// url(#...)/href/CSS references rewritten, or two logos would restyle each other.
// Uploaded SVGs are customer-supplied and end up in a file sent on, so scripts, event
// handlers, foreignObject and external references are stripped.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Attributes of the logo's root <svg> that describe the viewport, not inherited styling.
const ROOT_ONLY_ATTRS = new Set(['xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'x', 'y', 'version', 'baseProfile', 'id', 'enable-background', 'zoomAndPan']);
// Attributes of the replaced <image> that belong to the image itself, not the wrapper.
const IMAGE_ONLY_ATTRS = new Set(['href', 'xlink:href', 'x', 'y', 'width', 'height', 'preserveAspectRatio', 'draggable']);

const refIsSafe = v => v.startsWith('#') || v.startsWith('data:image/');

function sanitize(root) {
  root.querySelectorAll('script, foreignObject, metadata, title, desc').forEach(el => el.remove());
  [root, ...root.querySelectorAll('*')].forEach(el => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      else if ((a.name === 'href' || a.name === 'xlink:href') && !refIsSafe(a.value.trim())) el.removeAttribute(a.name);
    }
  });
  // An <image>/<use> whose only reference was external is now an empty shell - drop it.
  root.querySelectorAll('image, use').forEach(el => {
    if (!el.hasAttribute('href') && !el.hasAttribute('xlink:href')) el.remove();
  });
  root.querySelectorAll('style').forEach(st => {
    st.textContent = st.textContent
      .replace(/@import[^;]*;?/gi, '')
      .replace(/url\(\s*(?!['"]?(?:#|data:image\/))[^)]*\)/gi, 'none');
  });
}

// Prefix ids and classes; rewrite every reference to them.
function scope(root, prefix) {
  const idMap = new Map();
  root.querySelectorAll('[id]').forEach(el => { idMap.set(el.id, `${prefix}-${el.id}`); });
  const mapUrls = v => v.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g, (m, q, id) => idMap.has(id) ? `url(#${idMap.get(id)})` : m);
  [root, ...root.querySelectorAll('*')].forEach(el => {
    for (const a of [...el.attributes]) {
      if (a.name === 'id') continue;
      if ((a.name === 'href' || a.name === 'xlink:href') && a.value.startsWith('#') && idMap.has(a.value.slice(1))) {
        el.setAttribute(a.name, '#' + idMap.get(a.value.slice(1)));
      } else if (a.name === 'class') {
        el.setAttribute('class', a.value.split(/\s+/).filter(Boolean).map(c => `${prefix}-${c}`).join(' '));
      } else if (/url\(/.test(a.value)) {
        el.setAttribute(a.name, mapUrls(a.value));
      }
    }
  });
  idMap.forEach((nv, ov) => root.querySelector(`[id="${CSS.escape(ov)}"]`)?.setAttribute('id', nv));
  root.querySelectorAll('style').forEach(st => {
    st.textContent = mapUrls(st.textContent)
      .replace(/\.([_a-zA-Z][\w-]*)/g, (m, c) => `.${prefix}-${c}`)
      .replace(/#([_a-zA-Z][\w-]*)/g, (m, id) => idMap.has(id) ? `#${idMap.get(id)}` : m);
  });
}

function viewBoxOf(svg) {
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return vb;
  const wa = svg.getAttribute('width') || '', ha = svg.getAttribute('height') || '';
  const w = parseFloat(wa), h = parseFloat(ha);
  return (w > 0 && h > 0 && !/%/.test(wa + ha)) ? [0, 0, w, h] : null;
}

function decodeSvgDataUri(href) {
  const m = /^data:image\/svg\+xml((?:;[^,]*)?),(.*)$/s.exec(href);
  if (!m) return null;
  try {
    return /;base64/i.test(m[1])
      ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)))
      : decodeURIComponent(m[2]);
  } catch { return null; }
}

function buildLogoGroup(doc, img, src, prefix) {
  const box = viewBoxOf(src);
  const x = parseFloat(img.getAttribute('x') || 0), y = parseFloat(img.getAttribute('y') || 0);
  const w = parseFloat(img.getAttribute('width')), h = parseFloat(img.getAttribute('height'));
  if (!box || !(w > 0) || !(h > 0)) return null;
  const [vx, vy, vw, vh] = box;

  sanitize(src);
  scope(src, prefix);

  // The image's own preserveAspectRatio decides how the logo's viewBox maps into its box
  // (this app only ever writes xMidYMid meet, or the default, which is the same).
  const par = (img.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim().split(/\s+/);
  let sx = w / vw, sy = h / vh;
  if (par[0] !== 'none') { const s = par[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy); sx = sy = s; }
  const tx = x + (par[0] === 'none' ? 0 : (w - vw * sx) / 2) - vx * sx;
  const ty = y + (par[0] === 'none' ? 0 : (h - vh * sy) / 2) - vy * sy;

  // Outer group keeps whatever the image carried (a crop clip-path, opacity, ...).
  const outer = doc.createElementNS(SVG_NS, 'g');
  for (const a of [...img.attributes]) if (!IMAGE_ONLY_ATTRS.has(a.name)) outer.setAttribute(a.name, a.value);

  // Our root sets fill="none"; a standalone logo SVG expects the SVG default (black), so
  // restore it, then let the logo's own root attributes override.
  const inner = doc.createElementNS(SVG_NS, 'g');
  inner.setAttribute('fill', '#000000');
  for (const a of [...src.attributes]) {
    if (ROOT_ONLY_ATTRS.has(a.name) || a.name.startsWith('xmlns')) continue;
    inner.setAttribute(a.name, a.value);
  }
  inner.setAttribute('transform', `translate(${+tx.toFixed(4)} ${+ty.toFixed(4)}) scale(${+sx.toFixed(6)} ${+sy.toFixed(6)})`);
  [...src.childNodes].forEach(n => inner.appendChild(doc.importNode(n, true)));
  outer.appendChild(inner);
  return outer;
}

export function inlineSvgLogos(root) {
  const doc = root.ownerDocument;
  let seq = 0;
  root.querySelectorAll('image').forEach(img => {
    const href = img.getAttribute('href') ?? img.getAttributeNS(XLINK_NS, 'href') ?? '';
    const text = decodeSvgDataUri(href);
    if (text == null) return;
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    const src = parsed.documentElement;
    if (src.nodeName !== 'svg' || parsed.querySelector('parsererror')) return; // leave it as an image
    const group = buildLogoGroup(doc, img, src, `lg${++seq}`);
    if (group) img.replaceWith(group);
  });
}
