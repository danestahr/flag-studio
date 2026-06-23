import { HS, UI, getEffectiveState, getEffectiveVariation } from './state.js';
import { HS_H, HS_W, emptyTemplateLogos } from '../hole-sign-data.js';
import { escXml, makeHoleSignSvg, renderHoleSignInto } from '../hole-sign-render.js';
import { generateShareToken, saveHoleSignConfig, updateProject } from '../supabase.js';
import { PDFDocument, PDFName, PDFOperator, PDFString, rgb } from 'pdf-lib';
import JSZip from 'jszip';

// ── Step 3: Gallery ─────────────────────────────────────────
export function renderGallery() {
  const panel = document.getElementById('panel-3');
  panel.innerHTML = `
    <div>
      <div class="ptitle">Gallery & export</div>
      <div class="psub">Review all variations and export or share.</div>
    </div>
    <div class="s5layout">
      <div>
        <div class="hs-gallery-grid" id="hsGalleryGrid"></div>
      </div>
      <div class="review-card">
        <div class="rc-title">Selected</div>
        <div class="hs-gallery-selected" id="hsGallerySelected"></div>
        <div id="hsGallerySelectedName" style="font-size:13px;font-weight:500;text-align:center;margin-bottom:.5rem;color:var(--gray-600)"></div>
        <div class="exp-row">
          <button class="btn sm" id="hsExpPdf" onclick="exportHsPDF()">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PDF
          </button>
          <button class="btn sm" id="hsExpPng" onclick="exportHsPNG()">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PNG
          </button>
        </div>
        <button class="btn sm" style="width:100%;justify-content:center" onclick="exportHsAllPNG()">Export all PNG</button>
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--gray-100)">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-400);font-weight:500;margin-bottom:6px">Print files</div>
          <button class="btn sm primary" id="hsExpPrintBtn" style="width:100%;justify-content:center" onclick="downloadHsPrint()">↓ Download print sheets (zip)</button>
          <div id="hsExpPrintStatus" style="font-size:12px;color:var(--gray-600);min-height:14px;margin-top:6px"></div>
        </div>
        <div class="share-section">
          <div class="rc-title">Share</div>
          <button class="btn sm primary" onclick="generateHsShareLink()">Generate share link</button>
          <div class="share-link-box" id="hsShareLinkBox" style="display:none">
            <input class="share-link-input" id="hsShareLinkInput" readonly>
            <button class="btn sm" onclick="copyHsShareLink()">Copy</button>
          </div>
          <div id="hsShareStatus" style="font-size:12px;color:var(--gray-400)"></div>
        </div>
      </div>
    </div>
    <div class="arow">
      <button class="btn" onclick="tryGoStep(2)">← Back</button>
    </div>`;

  // Build gallery grid
  const grid = document.getElementById('hsGalleryGrid');
  if (!HS.variations.length) {
    grid.innerHTML = '<div style="font-size:13px;color:var(--gray-400);grid-column:1/-1">No variations yet.</div>';
    return;
  }

  HS.variations.forEach((v, i) => {
    const item = document.createElement('div');
    item.className = 'hs-gallery-item' + (i === 0 ? ' selected' : '');
    item.id = 'hsgal-' + v.id;
    item.setAttribute('onclick', `selectHsGallery('${v.id}')`);
    item.innerHTML = `<div class="hs-gallery-thumb" id="hsgalthumb-${v.id}"></div><div class="hs-gallery-name">${escXml(v.name)}</div>`;
    grid.appendChild(item);
  });

  HS.variations.forEach(v => {
    const el = document.getElementById('hsgalthumb-' + v.id);
    if (el) renderHoleSignInto(el, getEffectiveState(v), getEffectiveVariation(v));
  });

  if (HS.variations.length) {
    selectHsGallery(HS.variations[0].id);
  }
}

window.selectHsGallery = function (id) {
  document.querySelectorAll('.hs-gallery-item').forEach(el => el.classList.remove('selected'));
  const item = document.getElementById('hsgal-' + id);
  if (item) item.classList.add('selected');
  const v = HS.variations.find(v => v.id === id);
  const nameEl = document.getElementById('hsGallerySelectedName');
  if (nameEl && v) nameEl.textContent = v.name;
  const sel = document.getElementById('hsGallerySelected');
  if (sel && v) renderHoleSignInto(sel, getEffectiveState(v), getEffectiveVariation(v));
  window._hsGallerySelectedId = id;
};

// ── Export ─────────────────────────────────────────────────
export function hsSlug(s) { return (s || 'hole-sign').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''); }
export function dl(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

window.exportHsSVG = async function () {
  const id = window._hsGallerySelectedId;
  const v = HS.variations.find(v => v.id === id) || HS.variations[0];
  if (!v) return;
  const btn = document.getElementById('hsExpSvg');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const svgString = await hsBuildPortableSvg(v);
    dl(URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml' })), hsSlug(v.name) + '.svg');
  } catch (err) {
    console.error('Hole sign SVG export failed', err);
    alert('SVG export failed.');
  } finally {
    if (btn) {
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>SVG';
      btn.disabled = false;
    }
  }
};

window.exportHsPNG = async function () {
  const id = window._hsGallerySelectedId;
  const v = HS.variations.find(v => v.id === id) || HS.variations[0];
  if (!v) return;
  const btn = document.getElementById('hsExpPng');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const blob = await hsRasterize(v);
    dl(URL.createObjectURL(blob), hsSlug(v.name) + '.png');
  } catch (err) {
    console.error('Hole sign PNG export failed', err);
    alert('PNG export failed.');
  } finally {
    if (btn) {
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PNG';
      btn.disabled = false;
    }
  }
};

window.exportHsPDF = async function () {
  const id = window._hsGallerySelectedId;
  const v = HS.variations.find(v => v.id === id) || HS.variations[0];
  if (!v) return;
  const btn = document.getElementById('hsExpPdf');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const blob = await hsRasterize(v);
    const pngBytes = await blob.arrayBuffer();
    const ptW = 21.25 * 72;
    const ptH = Math.round(ptW * HS_H / HS_W);
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([ptW, ptH]);
    const pngImage = await pdfDoc.embedPng(pngBytes);
    page.drawImage(pngImage, { x: 0, y: 0, width: ptW, height: ptH });
    const pdfBytes = await pdfDoc.save();
    dl(URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' })), hsSlug(v.name) + '.pdf');
  } catch (err) {
    console.error('Hole sign PDF export failed', err);
    alert('PDF export failed.');
  } finally {
    if (btn) {
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PDF';
      btn.disabled = false;
    }
  }
};

window.exportHsAllPNG = async function () {
  for (const v of HS.variations) {
    try {
      const blob = await hsRasterize(v);
      dl(URL.createObjectURL(blob), hsSlug(v.name) + '.png');
      await new Promise(r => setTimeout(r, 400));
    } catch (err) { console.error('PNG export failed for', v.name, err); }
  }
};

// ── Print sheets ───────────────────────────────────────────
// Layout: 5 cols × 2 rows = 10 signs per sheet, each rotated 90° CW.
// Sheet: 91.25" × 42.5" @ 300 DPI. Sign native: 6375×5475 (= 21.25" × 18.25").
// After rotation, cell is 5475×6375 (= 18.25" × 21.25"), matching the grid.
const HS_PRINT = {
  cols: 5,
  rows: 2,
  perSheet: 10,
  sheetWIn: 91.25,
  sheetHIn: 42.5,
  dpi: 300,
};

// Build a 90° CW rotated PNG blob for one sign. Used for both front and back —
// the back sheet keeps the same per-sign orientation (text stays readable);
// only the cell positions change (rows are swapped).
export async function buildRotatedSignPng(signCanvas) {
  const c = document.createElement('canvas');
  c.width  = HS_H;   // 5475 (rotated cell width)
  c.height = HS_W;   // 6375 (rotated cell height)
  const ctx = c.getContext('2d');
  ctx.save();
  // Rotate 90° CW: move origin to top-right, then rotate
  ctx.translate(HS_H, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(signCanvas, 0, 0);
  ctx.restore();
  return await new Promise((resolve, reject) =>
    c.toBlob(b => b ? resolve(b) : reject(new Error('rotate toBlob failed')), 'image/png'));
}

// Render the full-resolution PNG for a single variation (no rotation).
export async function rasterizeSignNative(variation) {
  const str = await hsBuildPortableSvg(variation);
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = HS_W;
      c.height = HS_H;
      c.getContext('2d').drawImage(img, 0, 0, HS_W, HS_H);
      URL.revokeObjectURL(blobUrl);
      resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

// Build two Optional Content Group "groups" on the document:
//   ▸ Thru   — contains one OCG named "Green Box" per cell (cut lines)
//   ▸ Art    — contains one OCG named "Sign" per cell (sign artwork)
// Each group head is itself an OCG so toggling the parent in Acrobat hides
// everything beneath it; individual items can also be toggled one at a time.
export function createLayerGroups(doc, page, cellCount) {
  const context = doc.context;

  // Intent [View, Design] tells design tools (Illustrator, Inkscape) that the
  // OCG is editable, not just a viewer toggle. Without /Design, Illustrator
  // tends to flatten OCGs into a single layer on import.
  const intent = [PDFName.of('View'), PDFName.of('Design')];
  const ocg = (name) => context.register(context.obj({
    Type: 'OCG',
    Name: PDFString.of(name),
    Intent: intent,
  }));

  const thruHead = ocg('Thru');
  const artHead  = ocg('Art');

  const greenBoxes = [];
  const signs = [];
  for (let i = 0; i < cellCount; i++) {
    greenBoxes.push(ocg('Green Box'));
    signs.push(ocg('Sign'));
  }

  const allOcgs = [thruHead, artHead, ...greenBoxes, ...signs];
  const oc = context.obj({
    OCGs: allOcgs,
    D: {
      Order: [
        [thruHead, ...greenBoxes],
        [artHead, ...signs],
      ],
      ON: allOcgs,
      OFF: [],
      BaseState: PDFName.of('ON'),
    },
  });
  doc.catalog.set(PDFName.of('OCProperties'), oc);

  // Wire each OCG into the page resources under a short property name
  // so BDC operators can reference them by alias.
  const resources = page.node.Resources();
  const PropertiesKey = PDFName.of('Properties');
  let properties = resources.get(PropertiesKey);
  if (!properties) {
    properties = context.obj({});
    resources.set(PropertiesKey, properties);
  }

  const names = {
    thru: 'OCThru',
    art: 'OCArt',
    greenBox: [],
    sign: [],
  };
  properties.set(PDFName.of(names.thru), thruHead);
  properties.set(PDFName.of(names.art),  artHead);
  for (let i = 0; i < cellCount; i++) {
    const gb = `OCGB${i}`;
    const sg = `OCSG${i}`;
    names.greenBox.push(gb);
    names.sign.push(sg);
    properties.set(PDFName.of(gb), greenBoxes[i]);
    properties.set(PDFName.of(sg), signs[i]);
  }
  return names;
}

export function beginLayer(page, layerName) {
  page.pushOperators(PDFOperator.of('BDC', [PDFName.of('OC'), PDFName.of(layerName)]));
}
export function endLayer(page) {
  page.pushOperators(PDFOperator.of('EMC'));
}

window.downloadHsPrint = async function () {
  if (!HS.variations.length) { alert('No variations to export.'); return; }

  const btn = document.getElementById('hsExpPrintBtn');
  const status = document.getElementById('hsExpPrintStatus');
  const origLabel = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const setStatus = msg => { if (status) status.textContent = msg; };

  try {
    // Build flat sequence: variation repeated by its qty.
    const sequence = [];
    HS.variations.forEach(v => {
      const qty = Math.max(1, parseInt(v.qty, 10) || 1);
      for (let i = 0; i < qty; i++) sequence.push(v);
    });
    const total = sequence.length;
    if (!total) { alert('No signs to print (set Qty on variations).'); return; }
    const sheets = Math.ceil(total / HS_PRINT.perSheet);

    setStatus(`Rendering ${total} sign${total === 1 ? '' : 's'} across ${sheets} sheet${sheets === 1 ? '' : 's'}…`);

    // Render each unique variation once at native size, then re-use across cells.
    const nativeBySig = new Map();
    const sigOf = v => v.id;
    for (let i = 0; i < sequence.length; i++) {
      const v = sequence[i];
      if (nativeBySig.has(sigOf(v))) continue;
      setStatus(`Rendering variation ${nativeBySig.size + 1}/${HS.variations.length}: ${v.name}…`);
      nativeBySig.set(sigOf(v), await rasterizeSignNative(v));
    }

    // Pre-compute rotated PNG once per variation (same orientation for both sides).
    const rotated = new Map();
    for (const [sig, canvas] of nativeBySig) {
      rotated.set(sig, await buildRotatedSignPng(canvas));
    }

    // Build the PDFs.
    const ptW = HS_PRINT.sheetWIn * 72;
    const ptH = HS_PRINT.sheetHIn * 72;
    const cellWpt = ptW / HS_PRINT.cols;
    const cellHpt = ptH / HS_PRINT.rows;

    // Cut-line guide: 21" tall × 18" wide rectangle centered in each cell.
    // 1px (1pt) stroke, color #bfd730. Marks where the finished sign is trimmed
    // from the print sheet; the surrounding area is bleed.
    const CUT_W_PT = 18 * 72;
    const CUT_H_PT = 21 * 72;
    const CUT_X_OFF = (cellWpt - CUT_W_PT) / 2;
    const CUT_Y_OFF = (cellHpt - CUT_H_PT) / 2;
    const CUT_COLOR = rgb(0xbf / 255, 0xd7 / 255, 0x30 / 255);
    const drawCutLine = (page, col, row) => {
      const x = col * cellWpt + CUT_X_OFF;
      const y = (HS_PRINT.rows - 1 - row) * cellHpt + CUT_Y_OFF;
      page.drawRectangle({
        x, y,
        width: CUT_W_PT,
        height: CUT_H_PT,
        borderColor: CUT_COLOR,
        borderWidth: 1,
      });
    };

    const zip = new JSZip();

    for (let s = 0; s < sheets; s++) {
      setStatus(`Building sheet ${s + 1} of ${sheets}…`);
      const start = s * HS_PRINT.perSheet;
      const cells = sequence.slice(start, start + HS_PRINT.perSheet);

      // Front PDF
      const frontDoc = await PDFDocument.create();
      const frontPage = frontDoc.addPage([ptW, ptH]);
      const frontNames = createLayerGroups(frontDoc, frontPage, cells.length);

      // Place sign images inside the "Art" group (each named "Sign")
      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        const sig = sigOf(cells[i]);
        const pngBytes = await (rotated.get(sig)).arrayBuffer();
        const img = await frontDoc.embedPng(pngBytes);
        const x = col * cellWpt;
        const y = (HS_PRINT.rows - 1 - row) * cellHpt;
        beginLayer(frontPage, frontNames.art);
        beginLayer(frontPage, frontNames.sign[i]);
        frontPage.drawImage(img, { x, y, width: cellWpt, height: cellHpt });
        endLayer(frontPage);
        endLayer(frontPage);
      }
      // Draw cut lines inside the "Thru" group (each named "Green Box")
      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        beginLayer(frontPage, frontNames.thru);
        beginLayer(frontPage, frontNames.greenBox[i]);
        drawCutLine(frontPage, col, row);
        endLayer(frontPage);
        endLayer(frontPage);
      }
      const frontBytes = await frontDoc.save();

      // Back PDF — same per-sign orientation, but rows are swapped so that when
      // the paper is duplexed (flipped along the long edge), each cell on the
      // back aligns with its corresponding cell on the front through the paper.
      const backDoc = await PDFDocument.create();
      const backPage = backDoc.addPage([ptW, ptH]);
      const backNames = createLayerGroups(backDoc, backPage, cells.length);

      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        const sig = sigOf(cells[i]);
        const pngBytes = await (rotated.get(sig)).arrayBuffer();
        const img = await backDoc.embedPng(pngBytes);
        const swappedRow = HS_PRINT.rows - 1 - row;
        const x = col * cellWpt;
        const y = (HS_PRINT.rows - 1 - swappedRow) * cellHpt;
        beginLayer(backPage, backNames.art);
        beginLayer(backPage, backNames.sign[i]);
        backPage.drawImage(img, { x, y, width: cellWpt, height: cellHpt });
        endLayer(backPage);
        endLayer(backPage);
      }
      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        const swappedRow = HS_PRINT.rows - 1 - row;
        beginLayer(backPage, backNames.thru);
        beginLayer(backPage, backNames.greenBox[i]);
        drawCutLine(backPage, col, swappedRow);
        endLayer(backPage);
        endLayer(backPage);
      }
      const backBytes = await backDoc.save();

      const num = String(s + 1).padStart(2, '0');
      zip.file(`sheet-${num}-front.pdf`, frontBytes);
      zip.file(`sheet-${num}-back.pdf`,  backBytes);
    }

    setStatus('Zipping…');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const projName = HS.projectName ? hsSlug(HS.projectName) : 'hole-signs';
    dl(URL.createObjectURL(zipBlob), `${projName}-print-sheets.zip`);
    setStatus(`Done — ${total} signs on ${sheets} sheet${sheets === 1 ? '' : 's'} (${sheets * 2} files).`);
  } catch (err) {
    console.error('Hole sign print export failed', err);
    setStatus('Export failed: ' + (err.message || err));
    alert('Print export failed. See console for details.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origLabel || '↓ Download print sheets (zip)'; }
  }
};

export async function hsInlineHrefs(svgEl) {
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  await Promise.all(Array.from(svgEl.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ctMime = (res.headers.get('content-type') ?? '').split(';')[0];
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mime = ctMime || mimeMap[ext] || 'image/png';
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is on failure */ }
  }));
}

// Fetch the Google Fonts CSS and inline each woff2 url() as a base64 data URI.
// This is required because <img src=blob:svg> can't see the host document's
// @font-face rules — without inlining, DM Sans / DM Serif Display fall back to
// generic serif/sans-serif when rasterized.
export async function getEmbeddedFontCss() {
  if (UI.fontCssCache !== null) return UI.fontCssCache;
  try {
    const cssUrl = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=DM+Serif+Display&display=swap';
    const res = await fetch(cssUrl);
    let css = await res.text();
    const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+\.woff2)\)/g)].map(m => m[1]))];
    for (const url of urls) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const dataUri = `data:font/woff2;base64,${btoa(bin)}`;
        css = css.split(url).join(dataUri);
      } catch (err) { console.warn('Font fetch failed:', url, err); }
    }
    UI.fontCssCache = css;
    return css;
  } catch (err) {
    console.warn('Could not embed fonts:', err);
    UI.fontCssCache = '';
    return '';
  }
}

export async function hsBuildPortableSvg(variation) {
  const { content } = makeHoleSignSvg(getEffectiveState(variation), getEffectiveVariation(variation));
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'image/svg+xml');
  await hsInlineHrefs(doc.documentElement);

  // Embed @font-face rules so DM Sans / DM Serif Display render correctly
  // when this SVG is loaded into an Image for canvas rasterization.
  const fontCss = await getEmbeddedFontCss();
  if (fontCss) {
    const svgEl = doc.documentElement;
    const ns = 'http://www.w3.org/2000/svg';
    const defs = doc.createElementNS(ns, 'defs');
    const style = doc.createElementNS(ns, 'style');
    style.setAttribute('type', 'text/css');
    style.textContent = fontCss;
    defs.appendChild(style);
    svgEl.insertBefore(defs, svgEl.firstChild);
  }

  let str = new XMLSerializer().serializeToString(doc.documentElement);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  return str;
}

export async function hsRasterize(variation) {
  const str = await hsBuildPortableSvg(variation);
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = HS_W; c.height = HS_H;
      c.getContext('2d').drawImage(img, 0, 0, HS_W, HS_H);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

// ── Share ──────────────────────────────────────────────────
window.generateHsShareLink = async function () {
  const status = document.getElementById('hsShareStatus');
  if (!HS.projectId) { if (status) status.textContent = 'No project loaded.'; return; }
  if (status) status.textContent = 'Saving…';
  try {
    await saveDraftInternal();
    if (status) status.textContent = 'Generating link…';
    const token = await generateShareToken(HS.projectId);
    const url = `${window.location.origin}/review.html?token=${token}`;
    const input = document.getElementById('hsShareLinkInput');
    const box   = document.getElementById('hsShareLinkBox');
    if (input) input.value = url;
    if (box)   box.style.display = 'flex';
    if (status) status.textContent = '';
  } catch (err) {
    console.error(err);
    if (status) status.textContent = 'Could not generate link.';
  }
};

window.copyHsShareLink = function () {
  const input = document.getElementById('hsShareLinkInput');
  if (!input) return;
  input.select();
  document.execCommand('copy');
  const status = document.getElementById('hsShareStatus');
  if (status) { status.textContent = 'Copied!'; setTimeout(() => { status.textContent = ''; }, 2000); }
};

// ── Save ───────────────────────────────────────────────────
export async function saveDraftInternal() {
  if (!HS.projectId) return;
  // Strip blob: URLs from logoSrcTight before persisting — they're regenerable
  // from logoArtworkBounds + logoSrc on load and would otherwise be dead refs.
  const variations = HS.variations.map(v => {
    const { logoSrcTight, ...rest } = v;
    return rest;
  });
  // Strip blob URLs from template-logo slots before persisting; they're regenerable
  // from logoArtworkBounds + logoSrc on load.
  const tplLogos = HS.templateLogos ? {
    ...HS.templateLogos,
    slots: (HS.templateLogos.slots || []).map(({ logoSrcTight, ...rest }) => rest),
  } : emptyTemplateLogos();
  await saveHoleSignConfig(HS.projectId, {
    templateStyle: HS.templateStyle,
    colors: {
      background: HS.background,
      topText:    HS.topText,
      bottomText: HS.bottomText,
      bannerTop:    HS.bannerTop,
      bannerBottom: HS.bannerBottom,
      templateLogos: tplLogos,
    },
    variations,
    defaults: HS.defaults,
  });
  if (HS.projectName) {
    await updateProject(HS.projectId, { name: HS.projectName });
  }
}

window.saveDraft = async function () {
  const btn = document.getElementById('saveDraftBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await saveDraftInternal();
    if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save draft'; btn.disabled = false; }, 2000); }
  } catch (err) {
    console.error(err);
    if (btn) { btn.textContent = 'Save failed'; setTimeout(() => { btn.textContent = 'Save draft'; btn.disabled = false; }, 2000); }
  }
};
