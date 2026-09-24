import { dl } from './dom-utils.js';

const IMAGE_EXTS = new Set([
  'jpg','jpeg','png','gif','webp','svg','svgz','avif','bmp','ico','tiff','tif',
]);

export function isDisplayableImage(src) {
  if (!src) return false;
  if (src.startsWith('blob:') || src.startsWith('data:image/')) return true;
  const ext = src.split('?')[0].split('.').pop().toLowerCase();
  return IMAGE_EXTS.has(ext);
}

export function fileTypeLabel(src) {
  if (!src) return 'FILE';
  const ext = src.split('?')[0].split('.').pop().toLowerCase();
  return ext.toUpperCase();
}

// Downloads a logo by fetching it to a blob first — a plain <a download> is
// silently ignored for cross-origin URLs (Supabase Storage's public URLs are
// on a different origin than the app), so it would just navigate instead of
// downloading.
export async function downloadLogo(src, name) {
  const ext = src.split('?')[0].split('.').pop();
  const filename = new RegExp(`\\.${ext}$`, 'i').test(name) ? name : `${name}.${ext}`;
  try {
    const res = await fetch(src);
    const blob = await res.blob();
    dl(URL.createObjectURL(blob), filename);
  } catch (err) {
    console.error('Logo download failed', err);
  }
}

// Returns an <img> or a styled badge div for use in HTML templates.
export function logoThumbHtml(src, alt = '', extraClass = '') {
  if (isDisplayableImage(src)) {
    return `<img src="${src}" alt="${alt}"${extraClass ? ` class="${extraClass}"` : ''}>`;
  }
  const label = fileTypeLabel(src);
  return `<div class="file-type-badge${extraClass ? ' ' + extraClass : ''}">${label}</div>`;
}
