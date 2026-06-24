import { HS, UI } from './state.js';
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

// Detect bounds, crop SVG viewBox, store tight src + aspect on variation
export async function prepareLogo(variation, src) {
  const ab = await detectArtworkBounds(src);
  variation.logoArtworkBounds = ab;
  if (!ab) return;
  const tight = await cropSvgToArtwork(src, ab);
  if (tight) {
    if (variation.logoSrcTight?.startsWith('blob:')) URL.revokeObjectURL(variation.logoSrcTight);
    variation.logoSrcTight = tight.url;
    variation.logoAspect   = tight.aspect;
  } else {
    // Raster fallback: compute actual artwork aspect from canvas bounds + natural dimensions.
    // ab.w and ab.h are fractions of natural width and height respectively (canvas was square
    // but fractions map 1:1 to natural coords), so artwork pixel dims are ab.w*natW × ab.h*natH.
    const artW = ab.w * ab.natW;
    const artH = ab.h * ab.natH;
    variation.logoAspect = artW > 0 ? artH / artW : 1;
  }
}

export function applyFillToVariation(variation) {
  const lz = getLogoZone(HS, variation.templateId);
  const aspect = variation.logoAspect ?? 1;
  const byHeight = 100 * (lz.h / lz.w) / aspect;
  const newW = Math.min(100, byHeight) * 0.97;
  if (!variation.logoData) variation.logoData = { x: 50, y: 50, w: 90 };
  variation.logoData.w = Math.round(newW * 10) / 10;
  variation.logoData.x = 50;
  variation.logoData.y = 50;
}

export function fillHsLogo() {
  const variation = UI.hsActiveZone?.variation;
  if (!variation?.logoSrc) return;
  applyFillToVariation(variation);
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
  UI.hsActiveZone = null;
}
