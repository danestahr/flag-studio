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

// Returns an <img> or a styled badge div for use in HTML templates.
export function logoThumbHtml(src, alt = '', extraClass = '') {
  if (isDisplayableImage(src)) {
    return `<img src="${src}" alt="${alt}"${extraClass ? ` class="${extraClass}"` : ''}>`;
  }
  const label = fileTypeLabel(src);
  return `<div class="file-type-badge${extraClass ? ' ' + extraClass : ''}">${label}</div>`;
}
