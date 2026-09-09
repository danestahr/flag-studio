// Lightweight dominant-color extraction from a logo image, used to suggest
// a flag's zone colors. Not full k-means clustering - just frequency-bucketed
// sampling that ignores background-y pixels (transparent, near-white,
// near-black, near-gray) since those are almost always page/canvas
// background or line-art rather than brand color, then picks whichever
// remaining colors appear most often. Also skips any pixel that sits on a
// boundary between two fills (see the edge guard below) - without it, the
// anti-aliased blend band along e.g. a ring's outer edge is common enough
// pixel-for-pixel to rank as its own "dominant" color, which shows up as a
// weird muddy swatch that isn't actually anywhere in the logo's real palette.

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  return { s, l };
}

function loadImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function colorDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

// Returns up to `count` distinct hex candidates, most-frequent first, or []
// if the image had no usable (non-background) pixels to sample (e.g. a
// plain black wordmark on a transparent/white background, with no real
// brand color to pull out). Candidates are spread out (min RGB distance)
// so the list isn't 4 near-identical shades of the same dominant hue.
export async function extractDominantColors(imageSrc, count = 4) {
  const img = await loadImage(imageSrc);
  if (!img) return [];

  const SIZE = 100; // sample grid - big enough that thin details (a ring, a
                     // stroke) still have interior pixels once edge pixels
                     // are excluded below
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Nearest-neighbor instead of the default bilinear resize, so two abutting
  // fills stay a hard edge here rather than a smear of in-between colors -
  // keeps the edge guard below to a thin, genuinely-ambiguous band.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  let data;
  try {
    data = ctx.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    return []; // canvas tainted - shouldn't happen for our own data/same-origin URLs, fail safe
  }
  const at = (x, y) => {
    const i = (y * SIZE + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };

  const buckets = new Map(); // "r,g,b" (quantized) -> { count, r, g, b }
  const quantize = v => Math.round(v / 24) * 24;
  const EDGE_THRESHOLD = 24; // combined |dR|+|dG|+|dB| vs. a neighbor
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const [r, g, b, a] = at(x, y);
      if (a < 200) continue; // transparent
      const { s, l } = rgbToHsl(r, g, b);
      if (l > 0.92 || l < 0.08) continue; // near-white / near-black
      if (s < 0.15) continue; // near-gray - not a "brand" color

      // Edge guard: a pixel bordering a different fill blends toward a color
      // that belongs to neither region, so skip it and only count pixels
      // sitting in a flat interior.
      let isEdge = false;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const [nr, ng, nb] = at(nx, ny);
        if (Math.abs(r - nr) + Math.abs(g - ng) + Math.abs(b - nb) > EDGE_THRESHOLD) { isEdge = true; break; }
      }
      if (isEdge) continue;

      const qr = quantize(r), qg = quantize(g), qb = quantize(b);
      const key = `${qr},${qg},${qb}`;
      const entry = buckets.get(key) || { count: 0, r: qr, g: qg, b: qb };
      entry.count++;
      buckets.set(key, entry);
    }
  }

  const MIN_DISTANCE = 40; // keep the picks visually distinct, not 4 shades of one hue
  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  const picked = [];
  for (const entry of sorted) {
    if (picked.some(p => colorDistance(p, entry) < MIN_DISTANCE)) continue;
    picked.push(entry);
    if (picked.length >= count) break;
  }
  return picked.map(e => rgbToHex(e.r, e.g, e.b));
}

// Back-compat single-color helper - used by callers that only ever apply
// one auto-picked color with no chooser UI (login preview, background sync).
export async function extractDominantColor(imageSrc) {
  const [first] = await extractDominantColors(imageSrc, 1);
  return first ?? null;
}
