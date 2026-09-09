import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Print-resolution equivalent for a PDF's default 72pt/in page size.
const RASTER_SCALE = 300 / 72;

// Onscreen thumbnails (order-intake previews) only need to fill a small
// grid tile, not print resolution.
const PREVIEW_MAX_DIM = 240;

// `toScale(unscaledViewport)` picks the render scale from the page's native
// (scale-1) size, so callers can target a fixed pixel budget without a
// throwaway first render.
async function renderFirstPageToCanvas(file, toScale) {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  try {
    const page = await doc.getPage(1);
    const scale = toScale(page.getViewport({ scale: 1 }));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  } finally {
    doc.loadingTask.destroy();
  }
}

// Browsers can't paint a PDF via <img>/SVG <image href>, so any PDF uploaded
// as a logo has to be converted to a raster image before it can be previewed
// or placed on a flag/sign. Only the first page is used — logos are single
// artwork, not documents.
export async function rasterizePdfToPng(file) {
  const canvas = await renderFirstPageToCanvas(file, () => RASTER_SCALE);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const name = file.name.replace(/\.pdf$/i, '.png');
  return new File([blob], name, { type: 'image/png' });
}

// Order-intake thumbnail for a PDF (or a PDF-compatible .ai file — Illustrator
// embeds a PDF page by default, so pdf.js can usually open one directly).
// Caller decides what to do if this rejects — e.g. .ai files saved without
// PDF compatibility, or real EPS/PostScript, aren't renderable this way.
export async function renderPdfPreviewUrl(file) {
  const canvas = await renderFirstPageToCanvas(file, vp => Math.min(1, PREVIEW_MAX_DIM / Math.max(vp.width, vp.height)));
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  return URL.createObjectURL(blob);
}
