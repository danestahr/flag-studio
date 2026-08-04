import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

// Print-resolution equivalent for a PDF's default 72pt/in page size.
const RASTER_SCALE = 300 / 72;

// Browsers can't paint a PDF via <img>/SVG <image href>, so any PDF uploaded
// as a logo has to be converted to a raster image before it can be previewed
// or placed on a flag/sign. Only the first page is used — logos are single
// artwork, not documents.
export async function rasterizePdfToPng(file) {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: RASTER_SCALE });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const name = file.name.replace(/\.pdf$/i, '.png');
  return new File([blob], name, { type: 'image/png' });
}
