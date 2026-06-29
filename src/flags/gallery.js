import '../style.css';
import { requireAuth } from '../auth.js';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

await requireAuth();

import { S } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, renderInto, makeSvg, showGsTagVariant } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import { loadGsTag, isLightColor } from '../gsTag.js';
import {
  loadProject, loadFlagConfig, loadLogosForProject,
  generateShareToken, getFeedback, supabase,
  loadOrderIntake, sendProofReady, sendPrestigeOrder,
} from '../supabase.js';
import { buildOrderSummaryPdf } from '../orderSummaryPdf.js';

let gFace = 'front';
let feedbackChannel = null;
let _currentVarIdx = 0;
let _varObserver = null;
const _varVisibility = new Map();

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function slug(s) { return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''); }
function dl(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── Gallery ────────────────────────────────────────────────

function renderVarList() {
  const el = document.getElementById('varList');
  if (!el) return;
  el.innerHTML = '';
  const p = new URLSearchParams(window.location.search).get('project');
  const editBase = `flags-variations.html${p ? '?project=' + encodeURIComponent(p) : ''}`;
  const editIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.5 1.5L12.5 4.5L4.5 12.5H1.5V9.5L9.5 1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 3.5L10.5 6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

  S.variations.forEach((v, i) => {
    const card = document.createElement('div');
    card.className = 'var-card';
    card.dataset.varIdx = i;
    card.id = `var-card-${i}`;
    const frontLogos = v.logos || v.assignment || [];
    const backLogos = S.sameLogoOnBothSides ? frontLogos : (v.backLogos || v.backAssignment || []);
    const backMirror = S.sameLogoOnBothSides;
    const editHref = `${editBase}#var-${encodeURIComponent(v.id)}`;
    card.innerHTML = `
      <div class="var-card-header">
        <span class="var-card-name">${esc(v.name)}</span>
      </div>
      <div class="var-card-flags">
        <div><div class="var-card-face-label">Front</div><div class="var-card-flag" id="vcf-f-${i}"></div></div>
        <div><div class="var-card-face-label">Back</div><div class="var-card-flag" id="vcf-b-${i}"></div></div>
      </div>
      <a href="${editHref}" class="btn sm var-card-edit" title="Edit variation">${editIcon}</a>`;
    card.addEventListener('click', e => { if (!e.target.closest('.var-card-edit')) renderDetails(i); });
    el.appendChild(card);

    const frontEl = document.getElementById(`vcf-f-${i}`);
    if (frontEl) renderInto(frontEl, frontLogos, 'front', false, null, null, v.textLayers || []);
    const backEl = document.getElementById(`vcf-b-${i}`);
    if (backEl) renderInto(backEl, backLogos, 'back', backMirror, null, null, v.textLayers || []);
  });
}

function renderDetails(idx) {
  _currentVarIdx = idx;
  S.gIndex = idx;
  const v = S.variations[idx];
  if (!v) return;
  const flag = getFlag();

  const nameEl = document.getElementById('detailsVarName');
  if (nameEl) nameEl.textContent = v.name;

  const logos = v.logos || [];
  const logoThumbs = logos.length
    ? logos.map(l => {
        const lib = S.library.find(x => x.id === l.logoId);
        return lib ? `<img src="${lib.src}" title="${esc(lib.name)}" style="width:20px;height:20px;object-fit:contain;border-radius:3px">` : '';
      }).join('')
    : '<span style="color:var(--gray-400)">None</span>';
  const zoneRows = `<div class="drow"><span class="dkey">Logos</span><span class="dval" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">${logoThumbs}</span></div>`;

  const colorRows = (flag?.colorZones || []).map(z => {
    const hex = S.colors[z.id] || '#ccc';
    const col = COLORS.find(c => c.hex === hex);
    return `<div class="drow"><span class="dkey">${z.label}</span><span class="dval"><span class="dot" style="background:${hex}"></span>${col?.name || hex}</span></div>`;
  }).join('');

  const fbEntry = S.feedback?.find(f => f.variation_id === v.id);
  const fbBadge = fbEntry
    ? (fbEntry.status === 'approved'
        ? '<span class="rv-badge approved">Approved</span>'
        : fbEntry.status === 'needs_edits'
          ? '<span class="rv-badge needs-edits">Needs edits</span>'
          : '<span class="rv-badge pending">Pending</span>')
    : '<span class="rv-badge pending">Pending</span>';

  document.getElementById('gDetails').innerHTML = `
    <div class="drow"><span class="dkey">Style</span><span class="dval">${flag?.name || '—'}</span></div>
    ${colorRows}${zoneRows}
    <div class="drow"><span class="dkey">Review</span><span class="dval">${fbBadge}</span></div>`;

  document.querySelectorAll('.var-card').forEach((c, i) => c.classList.toggle('in-view', i === idx));
}

function setupScrollObserver() {
  if (_varObserver) _varObserver.disconnect();
  _varVisibility.clear();

  _varObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      const idx = parseInt(e.target.dataset.varIdx, 10);
      _varVisibility.set(idx, e.intersectionRatio);
    });
    let bestIdx = _currentVarIdx, bestRatio = -1;
    _varVisibility.forEach((ratio, idx) => {
      if (ratio > bestRatio) { bestRatio = ratio; bestIdx = idx; }
    });
    if (bestRatio > 0 && bestIdx !== _currentVarIdx) renderDetails(bestIdx);
  }, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1.0] });

  document.querySelectorAll('.var-card').forEach(card => _varObserver.observe(card));
}

function setupGallery() {
  _currentVarIdx = 0;
  S.gIndex = 0;
  gFace = 'front';
  document.getElementById('gFtFront')?.classList.add('active');
  document.getElementById('gFtBack')?.classList.remove('active');
  if (S.shareToken) {
    const url = `${window.location.origin}/review.html?token=${S.shareToken}`;
    const input = document.getElementById('shareLinkInput');
    if (input) input.value = url;
  }
  if (S.projectId) {
    getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderDetails(_currentVarIdx); }).catch(() => {});
    if (feedbackChannel) feedbackChannel.unsubscribe();
    feedbackChannel = supabase
      .channel('feedback-' + S.projectId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_feedback', filter: `project_id=eq.${S.projectId}` },
        () => getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderDetails(_currentVarIdx); }).catch(() => {}))
      .subscribe();
  }
  renderVarList();
  renderDetails(0);
  setupScrollObserver();
}

window.setGFace = function (face) {
  gFace = face;
  document.getElementById('gFtFront')?.classList.toggle('active', face === 'front');
  document.getElementById('gFtBack')?.classList.toggle('active', face === 'back');
};

// ── Export ─────────────────────────────────────────────────

const FLAG_DPI = 300;

// Fetch Google Fonts CSS and inline all font files as base64 data URIs so that
// text renders correctly when SVG is drawn to canvas via a blob URL (which runs
// in a sandboxed context without access to the page's loaded @font-face rules).
let _fontStyleCache = null;
async function buildFontStyle() {
  if (_fontStyleCache !== null) return _fontStyleCache;
  const link = document.querySelector('link[href*="fonts.googleapis.com"]');
  if (!link) { _fontStyleCache = ''; return ''; }
  try {
    const cssRes = await fetch(link.href);
    if (!cssRes.ok) { _fontStyleCache = ''; return ''; }
    let css = await cssRes.text();
    const urlPattern = /url\((['"]?)(https?:\/\/[^'")]+)\1\)/g;
    const urls = [...new Set([...css.matchAll(urlPattern)].map(m => m[2]))];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const mime = url.includes('.woff2') ? 'font/woff2' : url.includes('.woff') ? 'font/woff' : 'font/truetype';
        css = css.replaceAll(url, `data:${mime};base64,${btoa(binary)}`);
      } catch { /* skip this URL */ }
    }
    _fontStyleCache = css;
    return css;
  } catch { _fontStyleCache = ''; return ''; }
}

async function injectFonts(svg) {
  const css = await buildFontStyle();
  if (!css) return;
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = css;
  svg.insertBefore(style, svg.firstChild);
}

async function rasterizeSvg(logos, face, mirrorX = false, textLayers = []) {
  const flag = getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, null, null, textLayers);

  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const mime = mimeMap[ext] ?? (res.headers.get('content-type') ?? 'image/png').split(';')[0];
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is */ }
  }));
  await injectFonts(svg);

  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = vbW; c.height = vbH;
      c.getContext('2d').drawImage(img, 0, 0, vbW, vbH);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => blob ? resolve({ blob, vbW, vbH }) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

async function rasterizeThumbnail(logos, face, mirrorX = false, textLayers = []) {
  const flag = getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, null, null, textLayers);
  // Always show GS tag in order summary thumbnails regardless of S.gsTag
  if (!S.gsTag) {
    const keyZone = flag?.tagKeyZone || 'zone-primary';
    const keyHex = S.colors[keyZone];
    const style = keyHex ? (isLightColor(keyHex) ? 'Light' : 'Dark') : 'Dark';
    showGsTagVariant(svg, style, face);
  }
  await injectFonts(svg);
  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', svg:'image/svg+xml' };
      const mime = mimeMap[ext] ?? 'image/png';
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is */ }
  }));
  const thumbW = 800, thumbH = Math.round(800 * vbH / vbW);
  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = thumbW; c.height = thumbH;
      c.getContext('2d').drawImage(img, 0, 0, thumbW, thumbH);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => {
        if (!blob) { reject(new Error('toBlob failed')); return; }
        blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf))).catch(reject);
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

async function rasterizeForPrint(logos, face, mirrorX = false, textLayers = []) {
  const flag = getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, null, null, textLayers);
  // GolfStatus Tag lives inside Bleed. Move it to Bleed's parent first so it
  // survives the removal and stays in the same transform context (back-face
  // mirror, color-zone coordinate space, z-order below logos).
  const gsTagEl = svg.querySelector('[id="GolfStatus Tag"]');
  if (gsTagEl?.parentNode?.parentNode) {
    gsTagEl.parentNode.parentNode.appendChild(gsTagEl);
  }
  for (const gid of ['Bleed', 'bleed']) {
    const el = svg.querySelector(`[id="${gid}"]`);
    if (el) el.parentNode?.removeChild(el);
  }
  await Promise.all(Array.from(svg.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    try {
      const res = await fetch(src);
      if (!res.ok) return;
      const ext = src.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
      const mime = mimeMap[ext] ?? (res.headers.get('content-type') ?? 'image/png').split(';')[0];
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      img.setAttribute('href', `data:${mime};base64,${btoa(binary)}`);
    } catch { /* leave as-is */ }
  }));
  await injectFonts(svg);
  let str = new XMLSerializer().serializeToString(svg);
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = vbW; c.height = vbH;
      c.getContext('2d').drawImage(img, 0, 0, vbW, vbH);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => blob ? resolve({ blob, vbW, vbH }) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

async function pngBlobToPdfBlob(pngBlob, vbW, vbH) {
  const ptW = (vbW / FLAG_DPI) * 72;
  const ptH = (vbH / FLAG_DPI) * 72;
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([ptW, ptH]);
  const png = await pdfDoc.embedPng(await pngBlob.arrayBuffer());
  page.drawImage(png, { x: 0, y: 0, width: ptW, height: ptH });
  return new Blob([await pdfDoc.save()], { type: 'application/pdf' });
}

window.sendToPrestige = async function () {
  if (!S.variations.length) { alert('No variations to export.'); return; }
  if (!S.projectId) { alert('Save your project first.'); return; }
  const btn = document.querySelector('[onclick="sendToPrestige()"]');
  const origLabel = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const status = document.getElementById('expPrintStatus');
  const setStatus = msg => { if (status) status.textContent = msg; };
  try {
    const { zipBlob } = await buildPrintZip('pdf', setStatus);
    setStatus('Sending to Prestige…');
    await sendPrestigeOrder(S.projectId, S.projectName || 'Flag Order', zipBlob);
    setStatus('✓ Sent to Prestige Flag!');
    setTimeout(() => setStatus(''), 5000);
  } catch (err) {
    console.error('sendToPrestige failed', err);
    setStatus('Failed: ' + (err.message || err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
  }
};

window.expPDF = async function () {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const flag = getFlag();
  if (!flag) return;
  const btn = document.getElementById('expPdf');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const faceLogos = (gFace === 'back' && !S.sameLogoOnBothSides) ? (v.backLogos || v.backAssignment || []) : (v.logos || v.assignment);
    const { blob, vbW, vbH } = await rasterizeSvg(faceLogos, gFace, S.sameLogoOnBothSides && gFace === 'back', v.textLayers || []);
    const pdfBlob = await pngBlobToPdfBlob(blob, vbW, vbH);
    dl(URL.createObjectURL(pdfBlob), slug(v.name) + (gFace === 'back' ? '-back' : '') + '.pdf');
  } catch (err) {
    console.error('PDF export failed', err);
    alert('PDF export failed.');
  } finally {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PDF';
    btn.disabled = false;
  }
};

window.expPNG = async function () {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const btn = document.getElementById('expPng');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const faceLogos = (gFace === 'back' && !S.sameLogoOnBothSides) ? (v.backLogos || v.backAssignment || []) : (v.logos || v.assignment);
    const { blob } = await rasterizeSvg(faceLogos, gFace, S.sameLogoOnBothSides && gFace === 'back', v.textLayers || []);
    dl(URL.createObjectURL(blob), slug(v.name) + (gFace === 'back' ? '-back' : '') + '.png');
  } catch (err) {
    console.error('PNG export failed', err);
    alert('PNG export failed.');
  } finally {
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 1v8M4 6l3 3 3-3M2 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>PNG';
    btn.disabled = false;
  }
};

window.expAllPNG = async function () {
  for (const v of S.variations) {
    try {
      const { blob } = await rasterizeSvg(v.logos || v.assignment || [], 'front', false, v.textLayers || []);
      dl(URL.createObjectURL(blob), slug(v.name) + '.png');
      await new Promise(r => setTimeout(r, 400));
      if (!S.sameLogoOnBothSides) {
        const { blob: blobB } = await rasterizeSvg(v.backLogos || v.backAssignment || [], 'back', true, v.textLayers || []);
        dl(URL.createObjectURL(blobB), slug(v.name) + '-back.png');
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) { console.error('PNG export failed for', v.name, err); }
  }
};

async function buildPrintZip(format, setStatus = () => {}) {
  const zip = new JSZip();
  const flag = getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  for (let i = 0; i < S.variations.length; i++) {
    const v = S.variations[i];
    setStatus(`Rendering ${i + 1} of ${S.variations.length}: ${v.name}…`);
    const frontLogos = v.logos || v.assignment || [];
    const backLogos  = S.sameLogoOnBothSides ? frontLogos : (v.backLogos || v.backAssignment || []);
    const { blob: frontPng } = await rasterizeForPrint(frontLogos, 'front', false, v.textLayers || []);
    const { blob: backPng }  = await rasterizeForPrint(backLogos, 'back', S.sameLogoOnBothSides, v.textLayers || []);
    const safe = slug(v.name) || 'variation-' + (i + 1);
    if (format === 'png') {
      zip.file(`${safe}/${safe}-front.png`, frontPng);
      zip.file(`${safe}/${safe}-back.png`,  backPng);
    } else {
      zip.file(`${safe}/${safe}-front.pdf`, await pngBlobToPdfBlob(frontPng, vbW, vbH));
      zip.file(`${safe}/${safe}-back.pdf`,  await pngBlobToPdfBlob(backPng,  vbW, vbH));
    }
  }
  setStatus('Adding logos…');
  for (const logo of S.library || []) {
    try {
      const res = await fetch(logo.src);
      if (!res.ok) continue;
      const ext = (logo.storagePath || logo.src).split('.').pop().split('?')[0] || 'png';
      zip.file(`Logos/${logo.name}.${ext}`, await res.arrayBuffer());
    } catch { /* skip on error */ }
  }
  setStatus('Building order summary…');
  const colorEntries = Object.entries(S.colors || {}).map(([zoneId, hex]) => {
    const zoneDef = flag?.colorZones?.find(z => z.id === zoneId);
    const colorDef = COLORS.find(c => c.hex.toLowerCase() === hex?.toLowerCase());
    return { zone: zoneId, label: zoneDef?.label || zoneId, hex: hex || '#000000', name: colorDef?.name || 'Custom' };
  });
  setStatus('Rendering variation thumbnails…');
  const variationImages = [];
  for (const v of S.variations) {
    const frontLogos = v.logos || v.assignment || [];
    const backLogos  = S.sameLogoOnBothSides ? frontLogos : (v.backLogos || v.backAssignment || []);
    const [frontPng, backPng] = await Promise.all([
      rasterizeThumbnail(frontLogos, 'front', false, v.textLayers || []).catch(() => null),
      rasterizeThumbnail(backLogos, 'back', S.sameLogoOnBothSides, v.textLayers || []).catch(() => null),
    ]);
    variationImages.push({ name: v.name, frontPng, backPng });
  }
  const summaryPdf = await buildOrderSummaryPdf({
    projectId: S.projectId, productType: 'flags', colorEntries,
    templateName: flag?.name || S.flagId, variationCount: S.variations.length, variationImages,
  });
  zip.file('Order Summary.pdf', summaryPdf);
  setStatus('Zipping…');
  return { zipBlob: await zip.generateAsync({ type: 'blob' }), flag };
}

window.downloadForPrint = async function (format) {
  if (!S.variations.length) { alert('No variations to export.'); return; }
  if (format !== 'pdf' && format !== 'png') return;
  const btnPdf = document.getElementById('expPrintPdfBtn');
  const btnPng = document.getElementById('expPrintPngBtn');
  const status = document.getElementById('expPrintStatus');
  const activeBtn = format === 'pdf' ? btnPdf : btnPng;
  const originalLabel = activeBtn?.textContent;
  if (btnPdf) btnPdf.disabled = true;
  if (btnPng) btnPng.disabled = true;
  if (activeBtn) activeBtn.textContent = 'Preparing…';
  const setStatus = msg => { if (status) status.textContent = msg; };
  try {
    const { zipBlob, flag } = await buildPrintZip(format, setStatus);
    dl(URL.createObjectURL(zipBlob), `flags-${slug(flag?.name || S.flagId || 'export')}-${format}.zip`);
    setStatus(`Done — ${S.variations.length} variation${S.variations.length === 1 ? '' : 's'} exported.`);
  } catch (err) {
    console.error('Print export failed', err);
    setStatus('Export failed: ' + (err.message || err));
    alert('Print export failed. See console for details.');
  } finally {
    if (btnPdf) btnPdf.disabled = false;
    if (btnPng) btnPng.disabled = false;
    if (activeBtn && originalLabel) activeBtn.textContent = originalLabel;
  }
};

// ── Share ──────────────────────────────────────────────────

window.openShareModal = async function () {
  const status = document.getElementById('shareStatus');
  const btn = document.querySelector('#shareSection .btn.primary');
  if (!S.projectId) { if (status) status.textContent = 'Save your project first.'; return; }
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Generating link…';
  try {
    if (!S.shareToken) S.shareToken = await generateShareToken(S.projectId);
    const url = `${window.location.origin}/review.html?token=${S.shareToken}`;
    document.getElementById('shareLinkInput').value = url;
    if (status) status.textContent = '';
    const emailInput = document.getElementById('shareEmailInput');
    emailInput.value = '';
    loadOrderIntake(S.projectId).then(intake => { if (intake?.contact_email) emailInput.value = intake.contact_email; }).catch(() => {});
    document.getElementById('shareNotifyStatus').textContent = '';
    document.getElementById('shareModalOverlay').style.display = 'flex';
  } catch (err) {
    console.error(err);
    if (status) status.textContent = 'Could not generate link.';
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.closeShareModal = function (e) {
  if (e && e.target !== document.getElementById('shareModalOverlay')) return;
  document.getElementById('shareModalOverlay').style.display = 'none';
};

window.copyShareLink = function () {
  const url = document.getElementById('shareLinkInput').value;
  navigator.clipboard.writeText(url).then(() => {
    const status = document.getElementById('shareNotifyStatus');
    status.textContent = 'Link copied!';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
};

window.notifyCustomer = async function () {
  const email = document.getElementById('shareEmailInput').value.trim();
  const url = document.getElementById('shareLinkInput').value;
  const status = document.getElementById('shareNotifyStatus');
  if (!email) { status.textContent = 'Enter an email address.'; return; }
  const btn = document.querySelector('.share-modal .btn.primary');
  if (btn) btn.disabled = true;
  status.textContent = 'Sending…';
  try {
    const intake = await loadOrderIntake(S.projectId).catch(() => null);
    await sendProofReady({
      contactName: intake?.contact_name || '',
      contactEmail: email,
      eventName: intake?.event_name || 'your event',
      reviewUrl: url,
    });
    status.style.color = 'var(--green, #2d9d5c)';
    status.textContent = 'Notification sent!';
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 3000);
  } catch (err) {
    console.error(err);
    status.style.color = 'var(--red, #c0392b)';
    status.textContent = `Failed to send: ${err.message || err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
};

// ── Init ──────────────────────────────────────────────────

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (!_urlProject) { window.location.href = '/'; }

await Promise.all([loadAllFlags(FLAGS), loadGsTag()]);

try {
  const [project, logos, flagCfg] = await Promise.all([
    loadProject(_urlProject),
    loadLogosForProject(_urlProject),
    loadFlagConfig(_urlProject).catch(() => null),
  ]);
  S.projectId = project.id;
  S.projectName = project.name || '';
  S.shareToken  = project.share_token || null;
  S.library = logos;
  if (flagCfg) {
    S.flagId = flagCfg.flag_id;
    S.colors = flagCfg.colors || {};
    const varData = flagCfg.variations || [];
    const varItems = Array.isArray(varData) ? varData : (varData.items || []);
    S.variations = varItems.map(v => ({ ...v, backAssignment: v.backAssignment || {} }));
    S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
    S.gsTag = Array.isArray(varData) ? true : (varData.gsTag ?? true);
    S.gsTagMode = Array.isArray(varData) ? 'auto' : (varData.gsTagMode ?? 'auto');
    S.gsTagColor = Array.isArray(varData) ? '#ffffff' : (varData.gsTagColor ?? '#ffffff');
    S.sameLogoOnBothSides = flagCfg.same_logo_on_both_sides ?? true;
    S.activeVarId = S.variations[0]?.id || null;
    // Apply logoLayout to the live flag object so renderInto/makeSvg uses the right zones
    const flag = getFlag();
    if (flag?.logoZoneSets) {
      flag.logoZones = flag.logoZoneSets[S.logoLayout] || flag.logoZones;
    }
  }
  const nameDisplay = document.getElementById('projectNameDisplay');
  if (nameDisplay) nameDisplay.textContent = S.projectName || '—';

  setupGallery();
} catch (err) {
  console.error('Could not load project', err);
}
