// Preview pole artwork (public/flags/print/pole__<name>.svg, 400 x 4050). One
// file per layout; zones inside are recolourable like a print frame's:
// `#zone-primary*` takes the primary color and `#zone-secondary*` the border
// color. Preview-only - never part of a print export.

const cache = new Map();

export function fetchPoleText(name) {
  if (!cache.has(name)) {
    cache.set(name, fetch('/flags/print/' + encodeURIComponent('pole__' + name) + '.svg').then(async res => {
      if (!res.ok) throw new Error(`${res.status} for pole ${name}`);
      const text = await res.text();
      // A dev server may answer a missing file with index.html (200).
      if (!/^\s*<svg[\s>]/.test(text)) throw new Error(`not an SVG: pole ${name}`);
      return text;
    }));
  }
  return cache.get(name);
}

let seq = 0;

// The pole's inner markup, recolored. Ids are suffixed per call: the same pole
// is inlined many times in one document (every gallery tile), and a gradient
// or mask referenced by a duplicated id breaks as soon as the first copy sits
// in a hidden subtree.
export function poleInner(text, { primary, border }) {
  const n = ++seq;
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  root.querySelectorAll('[id]').forEach(el => {
    const id = el.getAttribute('id');
    if (/^#?zone-primary/.test(id)) el.setAttribute('fill', primary);
    else if (/^#?zone-secondary/.test(id)) el.setAttribute('fill', border);
  });
  // The artwork's own viewBox (stitches/strokes sit on its edge, so it can be a
  // pixel wider than 400); callers stretch it to the pole's 400-unit slot.
  const viewBox = root.getAttribute('viewBox') || '0 0 400 4050';
  const inner = root.innerHTML
    .replace(/\sid="([^"]*)"/g, (_, id) => ` id="${id}-p${n}"`)
    .replace(/url\(#([^)]*)\)/g, (_, id) => `url(#${id}-p${n})`);
  return { inner, viewBox };
}
