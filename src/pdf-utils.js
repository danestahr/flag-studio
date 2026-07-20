import { PDFDocument } from 'pdf-lib';

// Wrap a single full-bleed PNG image as a one-page PDF. `ptW`/`ptH` are the
// page size in PDF points — callers convert from their own pixel/DPI or
// inches convention before calling this.
export async function pngBlobToPdfBlob(pngBlob, ptW, ptH) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([ptW, ptH]);
  const png = await pdfDoc.embedPng(await pngBlob.arrayBuffer());
  page.drawImage(png, { x: 0, y: 0, width: ptW, height: ptH });
  return new Blob([await pdfDoc.save()], { type: 'application/pdf' });
}
