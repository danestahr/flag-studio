import { HS, UI, getEffectiveState, getVariationLayer } from './state.js';
import { renderVarList } from './variations.js';
import { renderVariationPreview } from './var-canvas.js';
import { getLogoZone } from '../hole-sign-render.js';
import { uploadLogo } from '../supabase.js';

// Remove the background from a logo using @imgly/background-removal (lazy-loaded
// so the large ONNX model is only downloaded on first use).
export async function removeBgFromLogo(logo, onProgress) {
  onProgress?.('loading');
  const { removeBackground } = await import('@imgly/background-removal');
  const blob = await removeBackground(logo.src);
  const file = new File([blob], logo.name.replace(/\.[^.]+$/, '') + ' (no bg).png', { type: 'image/png' });
  onProgress?.('uploading');
  const newLogo = await uploadLogo(HS.projectId, file);
  return newLogo;
}

// Scan alpha channel on a 256×256 canvas to find opaque pixel bounds (fractions of image size)
export async function detectArtworkBounds(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const SZ = 256;
      const canvas = document.createElement('canvas');
      canvas.width = SZ; canvas.height = SZ;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, SZ, SZ);
      let d;
      try { d = ctx.getImageData(0, 0, SZ, SZ).data; } catch { resolve(null); return; }
      let minX = SZ, maxX = -1, minY = SZ, maxY = -1;
      for (let y = 0; y < SZ; y++) {
        for (let x = 0; x < SZ; x++) {
          if (d[(y * SZ + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) { resolve(null); return; }
      resolve({
        x: minX / SZ, y: minY / SZ,
        w: (maxX - minX + 1) / SZ, h: (maxY - minY + 1) / SZ,
        natW: img.naturalWidth  || SZ,
        natH: img.naturalHeight || SZ,
      });
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Fetch SVG, tighten viewBox to artwork bounds, return { url, aspect } or null
export async function cropSvgToArtwork(src, ab) {
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.includes('<svg')) return null;
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return null;
    let vpX = 0, vpY = 0, vpW = 0, vpH = 0;
    const vb = svg.getAttribute('viewBox');
    if (vb) {
      [vpX, vpY, vpW, vpH] = vb.trim().split(/[\s,]+/).map(Number);
    } else {
      vpW = parseFloat(svg.getAttribute('width')) || 0;
      vpH = parseFloat(svg.getAttribute('height')) || 0;
    }
    if (!vpW || !vpH) return null;
    const nx = vpX + ab.x * vpW, ny = vpY + ab.y * vpH;
    const nw = ab.w * vpW,       nh = ab.h * vpH;
    svg.setAttribute('viewBox', `${nx} ${ny} ${nw} ${nh}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
    return { url, aspect: nh / nw };
  } catch { return null; }
}

// If a variation still carries the old single-logo fields (from before
// sponsor logos became a per-variation array — see var-canvas.js), fold them
// into a one-element `logos` array and drop the legacy fields. Mirrors
// flags' own `v.assignment` → `v.logos` migration (src/flags/variations.js).
export function migrateVariationLogos(v) {
  if (!v || v.logos !== undefined) return;
  if (v.logoSrc) {
    v.logos = [{
      id: crypto.randomUUID(),
      logoId: v.logoId ?? null,
      logoSrc: v.logoSrc,
      logoSrcTight: v.logoSrcTight,
      logoAspect: v.logoAspect,
      logoArtworkBounds: v.logoArtworkBounds,
      x: v.logoData?.x ?? 50, y: v.logoData?.y ?? 50, w: v.logoData?.w ?? 90,
      aboveFrame: !!v.aboveFrame,
      belowBackground: !!v.belowBackground,
    }];
  } else {
    v.logos = [];
  }
  delete v.logoId; delete v.logoSrc; delete v.logoSrcTight;
  delete v.logoAspect; delete v.logoArtworkBounds; delete v.logoData;
}

// Detect bounds, crop SVG viewBox, store tight src + aspect on one logo layer
export async function prepareLogo(layer, src) {
  const ab = await detectArtworkBounds(src);
  layer.logoArtworkBounds = ab;
  if (!ab) return;
  const tight = await cropSvgToArtwork(src, ab);
  if (tight) {
    if (layer.logoSrcTight?.startsWith('blob:')) URL.revokeObjectURL(layer.logoSrcTight);
    layer.logoSrcTight = tight.url;
    layer.logoAspect   = tight.aspect;
  } else {
    // Raster fallback: compute actual artwork aspect from canvas bounds + natural dimensions.
    // ab.w and ab.h are fractions of natural width and height respectively (canvas was square
    // but fractions map 1:1 to natural coords), so artwork pixel dims are ab.w*natW × ab.h*natH.
    const artW = ab.w * ab.natW;
    const artH = ab.h * ab.natH;
    layer.logoAspect = artW > 0 ? artH / artW : 1;
  }
}

export function applyFillToVariation(variation, layer) {
  const lz = getLogoZone(getEffectiveState(variation));
  const aspect = layer.logoAspect ?? 1;
  const byHeight = 100 * (lz.h / lz.w) / aspect;
  const newW = Math.min(100, byHeight) * 0.97;
  layer.w = Math.round(newW * 10) / 10;
  layer.x = 50;
  layer.y = 50;
}

// Pushes a new logo layer onto `variation.logos` and resolves once it's fully
// prepared (or failed) — the caller should render right after calling this
// (before awaiting) to show the pushed layer's loading spinner (`layer.loading`,
// see var-canvas.js), then render again once the returned promise settles.
// Always ADDS a layer — dragging a logo onto a variation never overwrites one
// already there; only the toolbar's explicit Replace/Remove BG mutate a
// specific *selected* layer in place. `isFullGraphic` templates are the one
// exception: they show a single full-bleed image with no way to usefully
// address more than one, so there a drop replaces the sole layer instead.
export async function addLogoLayer(variation, logo, { isFullGraphic = false } = {}) {
  delete variation.sponsorText;
  if (isFullGraphic) variation.logos.length = 0;
  const idx = variation.logos.length;
  const layer = {
    id: crypto.randomUUID(), logoId: logo.id, logoSrc: logo.src,
    x: 50, y: 50, w: isFullGraphic ? 100 : 90,
    aboveFrame: false, belowBackground: false, loading: true,
  };
  variation.logos.push(layer);
  try {
    await prepareLogo(layer, logo.src);
    if (!isFullGraphic) {
      applyFillToVariation(variation, layer);
      // Cascade each additional layer a bit off-center so it doesn't land
      // perfectly on top of the ones already there.
      if (idx > 0) {
        const cascade = Math.min(idx, 6) * 5;
        layer.x = Math.min(85, 50 + cascade);
        layer.y = Math.min(85, 50 + cascade);
      }
    }
  } finally {
    delete layer.loading;
  }
  return layer;
}

// Resolves the logo layer currently selected on the canvas (see
// UI.hsActiveZone.layerId, set in var-canvas.js), or null if none/not a logo.
export function activeLogoLayer() {
  const z = UI.hsActiveZone;
  if (!z?.variation || !z.layerId) return null;
  return z.variation.logos?.find(l => l.id === z.layerId) || null;
}

// Multiple logos in one variation can share a tier (below-bg/below-frame/
// above-frame — see HS_LAYER_ORDER in state.js); paint order within a shared
// tier is v.logos array order (hole-sign-render.js's `(variation.logos ||
// []).forEach`, and the matching DOM append order in var-canvas.js), so
// reordering within a tier means swapping array position. Nearest same-tier
// sibling one step forward (dir=1) or backward (dir=-1) from `layer`, or -1
// if none — used by var-toolbar.js's arrange buttons to decide whether a
// step swaps a sibling or crosses into the next/previous global tier.
function sameTierSiblingIndex(v, layer, dir) {
  const list = v?.logos || [];
  const idx = list.indexOf(layer);
  if (idx < 0) return -1;
  const tier = getVariationLayer(layer);
  for (let i = idx + dir; i >= 0 && i < list.length; i += dir) {
    if (getVariationLayer(list[i]) === tier) return i;
  }
  return -1;
}

export function hasSiblingInDirection(v, layer, dir) {
  return sameTierSiblingIndex(v, layer, dir) >= 0;
}

// Swaps `layer` with its nearest same-tier sibling one step forward/backward.
// Returns true if a swap happened (false when there's no such sibling).
export function swapLogoWithSibling(v, layer, dir) {
  const list = v?.logos || [];
  const idx = list.indexOf(layer);
  const siblingIdx = sameTierSiblingIndex(v, layer, dir);
  if (idx < 0 || siblingIdx < 0) return false;
  [list[idx], list[siblingIdx]] = [list[siblingIdx], list[idx]];
  return true;
}

// Moves `layer` to the absolute front/back of v.logos — paired with setting
// its tier to the top/bottom in HS_LAYER_ORDER, so "move to front"/"move to
// back" land it unambiguously frontmost/backmost even among same-tier
// siblings, not just "whichever tier this is."
export function moveLogoToEdge(v, layer, edge) {
  const list = v?.logos || [];
  const idx = list.indexOf(layer);
  if (idx < 0) return;
  list.splice(idx, 1);
  if (edge === 'front') list.push(layer);
  else list.unshift(layer);
}

export function fillHsLogo() {
  const variation = UI.hsActiveZone?.variation;
  const layer = activeLogoLayer();
  if (!layer) return;
  applyFillToVariation(variation, layer);
  hideHsToolbar();
  renderVarList();
  renderVariationPreview();
}

export function hideHsToolbar() {
  const tb = document.getElementById('hsZoneToolbar');
  if (tb) tb.style.display = 'none';
  const picker = document.getElementById('hsLibPicker');
  if (picker) picker.style.display = 'none';
  if (UI.hsActiveZone?.dzone) UI.hsActiveZone.dzone.classList.remove('selected');
  UI.hsActiveZone?.wrap?.classList.remove('selected');
  UI.hsActiveZone = null;
}
