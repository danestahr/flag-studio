import '../style.css';
import '../icons.js';
import { requireAuth } from '../auth.js';
import JSZip from 'jszip';
import { pngBlobToPdfBlob as pngToPdfPt } from '../pdf-utils.js';

await requireAuth();

import { S } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, renderInto, makeSvg, showGsTagVariant, resolveColors, preloadLogoAspects } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  loadProject, loadFlagConfig, loadLogosForProject,
  generateShareToken, getFeedback, supabase,
  loadOrderIntake, loadEventName, sendProofReady, sendPrestigeOrder,
} from '../supabase.js';
import { buildOrderSummaryPdf } from '../orderSummaryPdf.js';
import { esc, dl, slug, sanitizeFilename } from '../dom-utils.js';
import { renderSidebar, setSidebarProjectName } from '../sidebar.js';

let feedbackChannel = null;

function getVarFlag(v) {
  if (!v) return getFlag();
  const id = v.flagId || S.flagId;
  return FLAGS.find(f => f.id === id) || getFlag();
}
function getVarColors(v) { return (v && v.colors) ? v.colors : S.colors; }
function getVarColorEntries(v) {
  const flag = getVarFlag(v);
  const colors = getVarColors(v);
  return Object.entries(colors || {}).map(([zoneId, hex]) => {
    const zoneDef = flag?.colorZones?.find(z => z.id === zoneId);
    const colorDef = COLORS.find(c => c.hex.toLowerCase() === hex?.toLowerCase());
    return { zone: zoneId, label: zoneDef?.label || zoneId, hex: hex || '#000000', name: colorDef?.name || 'Custom' };
  });
}
function getVarGsTagOpts(v) {
  if (!v || (v.gsTag === undefined && v.gsTagMode === undefined)) return null;
  return { enabled: v.gsTag ?? S.gsTag, mode: v.gsTagMode ?? S.gsTagMode };
}

// ── Gallery ────────────────────────────────────────────────

function reviewStatusOf(v) {
  const fb = S.feedback?.find(f => f.variation_id === v.id);
  if (fb?.status === 'approved') return { cls: 'approved', label: 'Approved' };
  if (fb?.status === 'needs_edits') return { cls: 'needs-edits', label: 'Needs edits' };
  return { cls: 'not-reviewed', label: 'Not reviewed' };
}

function renderVarList() {
  const el = document.getElementById('varList');
  if (!el) return;
  el.innerHTML = '';
  const p = new URLSearchParams(window.location.search).get('project');
  const editBase = `flags-variations.html${p ? '?project=' + encodeURIComponent(p) : ''}`;
  const editIcon = `<i class="fa-solid fa-pen" aria-hidden="true"></i>`;
  const pdfIcon = `<i class="fa-solid fa-file-pdf" aria-hidden="true"></i>`;

  S.variations.forEach((v, i) => {
    const card = document.createElement('div');
    card.className = 'var-card';
    card.dataset.varIdx = i;
    card.id = `var-card-${i}`;
    const frontLogos = v.logos || v.assignment || [];
    const backLogos = S.sameLogoOnBothSides ? frontLogos : (v.backLogos || v.backAssignment || []);
    const backMirror = S.sameLogoOnBothSides;
    const backTextLayers = S.sameLogoOnBothSides ? (v.textLayers || []) : (v.backTextLayers || []);
    const editHref = `${editBase}#var-${encodeURIComponent(v.id)}`;
    const status = reviewStatusOf(v);
    card.innerHTML = `
      <div class="var-card-header">
        <span class="var-card-name">${esc(v.name)}</span>
      </div>
      <div class="var-card-flags">
        <div><div class="var-card-face-label">Front</div><div class="var-card-flag" id="vcf-f-${i}"></div></div>
        <div><div class="var-card-face-label">Back</div><div class="var-card-flag" id="vcf-b-${i}"></div></div>
      </div>
      <div class="var-card-actions">
        <span class="var-status-tile ${status.cls}">${status.label}</span>
        <a href="${editHref}" class="btn sm var-card-edit" title="Edit variation">${editIcon}</a>
        <button class="btn sm var-card-pdf" title="Download PDF" onclick="event.stopPropagation();downloadVariationPdf(${i})">${pdfIcon}</button>
      </div>`;
    el.appendChild(card);

    const frontEl = document.getElementById(`vcf-f-${i}`);
    if (frontEl) renderInto(frontEl, frontLogos, 'front', false, getVarFlag(v), getVarColors(v), v.textLayers || [], getVarGsTagOpts(v));
    const backEl = document.getElementById(`vcf-b-${i}`);
    if (backEl) renderInto(backEl, backLogos, 'back', backMirror, getVarFlag(v), getVarColors(v), backTextLayers, getVarGsTagOpts(v));
  });
}

function setupGallery() {
  if (S.shareToken) {
    const url = `${window.location.origin}/review.html?token=${S.shareToken}`;
    const input = document.getElementById('shareLinkInput');
    if (input) input.value = url;
  }
  if (S.projectId) {
    getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderVarList(); }).catch(() => {});
    if (feedbackChannel) feedbackChannel.unsubscribe();
    feedbackChannel = supabase
      .channel('feedback-' + S.projectId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_feedback', filter: `project_id=eq.${S.projectId}` },
        () => getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderVarList(); }).catch(() => {}))
      .subscribe();
  }
  renderVarList();
}

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

async function rasterizeSvg(logos, face, mirrorX = false, textLayers = [], flagOverride = null, colorsOverride = null, gsTagOpts = null) {
  const flag = flagOverride || getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, flagOverride, colorsOverride, textLayers, gsTagOpts);

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

async function rasterizeThumbnail(logos, face, mirrorX = false, textLayers = [], flagOverride = null, colorsOverride = null, gsTagOpts = null) {
  const flag = flagOverride || getFlag();
  const colors = colorsOverride || S.colors;
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, flagOverride, colorsOverride, textLayers, gsTagOpts);
  // Always show GS tag in order summary thumbnails regardless of S.gsTag
  const gst = gsTagOpts ?? { enabled: S.gsTag, mode: S.gsTagMode };
  if (!gst.enabled) {
    const keyZone = flag?.tagKeyZone || 'zone-primary';
    showGsTagVariant(svg, face, 'auto', resolveColors(colors, flag)[keyZone]);
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

async function rasterizeForPrint(logos, face, mirrorX = false, textLayers = [], flagOverride = null, colorsOverride = null, gsTagOpts = null) {
  const flag = flagOverride || getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(logos, vbW, vbH, face, mirrorX, flagOverride, colorsOverride, textLayers, gsTagOpts);
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

function pngBlobToPdfBlob(pngBlob, vbW, vbH) {
  return pngToPdfPt(pngBlob, (vbW / FLAG_DPI) * 72, (vbH / FLAG_DPI) * 72);
}

window.sendToPrestige = async function () {
  if (!S.variations.length) { alert('No variations to export.'); return; }
  if (!S.projectId) { alert('Save your project first.'); return; }
  const btn = document.querySelector('[onclick="sendToPrestige()"]');
  const origLabel = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const status = document.getElementById('expPrintStatus');
  const setStatus = msg => { if (status) status.textContent = msg; };
  try {
    const { zipBlob } = await buildPrintZip(setStatus);
    setStatus('Sending to Prestige…');
    await sendPrestigeOrder(S.projectId, S.projectName || 'Flag Order', zipBlob);
    setStatus('✓ Sent to Prestige Flag!');
    setTimeout(() => setStatus(''), 5000);
  } catch (err) {
    console.error('sendToPrestige failed', err);
    setStatus('Failed: ' + (err.message || err));
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
  }
};

// Single-variation, front-face PDF — lives on each gallery tile.
window.downloadVariationPdf = async function (idx) {
  const v = S.variations[idx];
  if (!v) return;
  const btn = document.querySelector(`#var-card-${idx} .var-card-pdf`);
  if (btn) btn.disabled = true;
  try {
    const faceLogos = v.logos || v.assignment || [];
    const { blob, vbW, vbH } = await rasterizeSvg(faceLogos, 'front', false, v.textLayers || [], getVarFlag(v), getVarColors(v), getVarGsTagOpts(v));
    const pdfBlob = await pngBlobToPdfBlob(blob, vbW, vbH);
    dl(URL.createObjectURL(pdfBlob), slug(v.name) + '.pdf');
  } catch (err) {
    console.error('PDF export failed', err);
    alert('PDF export failed.');
  } finally {
    if (btn) btn.disabled = false;
  }
};

// Bulk export — every variation's front (and independent back) as separate PDFs.
window.expAllPDF = async function () {
  for (const v of S.variations) {
    try {
      const { blob, vbW, vbH } = await rasterizeSvg(v.logos || v.assignment || [], 'front', false, v.textLayers || [], getVarFlag(v), getVarColors(v), getVarGsTagOpts(v));
      dl(URL.createObjectURL(await pngBlobToPdfBlob(blob, vbW, vbH)), slug(v.name) + '.pdf');
      await new Promise(r => setTimeout(r, 400));
      if (!S.sameLogoOnBothSides) {
        const { blob: blobB, vbW: bW, vbH: bH } = await rasterizeSvg(v.backLogos || v.backAssignment || [], 'back', false, v.backTextLayers || [], getVarFlag(v), getVarColors(v), getVarGsTagOpts(v));
        dl(URL.createObjectURL(await pngBlobToPdfBlob(blobB, bW, bH)), slug(v.name) + '-back.pdf');
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) { console.error('PDF export failed for', v.name, err); }
  }
};

async function buildPrintZip(setStatus = () => {}) {
  const zip = new JSZip();
  const flag = getFlag();
  for (let i = 0; i < S.variations.length; i++) {
    const v = S.variations[i];
    setStatus(`Rendering ${i + 1} of ${S.variations.length}: ${v.name}…`);
    const frontLogos = v.logos || v.assignment || [];
    const backLogos  = S.sameLogoOnBothSides ? frontLogos : (v.backLogos || v.backAssignment || []);
    const backTextLayers = S.sameLogoOnBothSides ? (v.textLayers || []) : (v.backTextLayers || []);
    const { blob: frontPng, vbW: fW, vbH: fH } = await rasterizeForPrint(frontLogos, 'front', false, v.textLayers || [], getVarFlag(v), getVarColors(v), getVarGsTagOpts(v));
    const { blob: backPng,  vbW: bW, vbH: bH } = await rasterizeForPrint(backLogos,  'back', S.sameLogoOnBothSides, backTextLayers, getVarFlag(v), getVarColors(v), getVarGsTagOpts(v));
    const safe = slug(v.name) || 'variation-' + (i + 1);
    zip.file(`${safe}/${safe}-front.pdf`, await pngBlobToPdfBlob(frontPng, fW, fH));
    zip.file(`${safe}/${safe}-back.pdf`,  await pngBlobToPdfBlob(backPng,  bW, bH));
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
  const colorEntries = getVarColorEntries(null);
  setStatus('Rendering variation thumbnails…');
  const variationImages = [];
  for (const v of S.variations) {
    const frontLogos = v.logos || v.assignment || [];
    const backLogos  = S.sameLogoOnBothSides ? frontLogos : (v.backLogos || v.backAssignment || []);
    const backTextLayers = S.sameLogoOnBothSides ? (v.textLayers || []) : (v.backTextLayers || []);
    const [frontPng, backPng] = await Promise.all([
      rasterizeThumbnail(frontLogos, 'front', false, v.textLayers || [], getVarFlag(v), getVarColors(v), getVarGsTagOpts(v)).catch(() => null),
      rasterizeThumbnail(backLogos, 'back', S.sameLogoOnBothSides, backTextLayers, getVarFlag(v), getVarColors(v), getVarGsTagOpts(v)).catch(() => null),
    ]);
    variationImages.push({
      name: v.name, frontPng, backPng,
      flagName: getVarFlag(v)?.name || v.flagId || S.flagId || '',
      colorEntries: getVarColorEntries(v),
    });
  }
  const summaryPdf = await buildOrderSummaryPdf({
    projectId: S.projectId, productType: 'flags', colorEntries,
    templateName: flag?.name || S.flagId, variationCount: S.variations.length, variationImages,
  });
  zip.file('Order Summary.pdf', summaryPdf);
  setStatus('Zipping…');
  return { zipBlob: await zip.generateAsync({ type: 'blob' }), flag };
}

window.downloadForPrint = async function () {
  if (!S.variations.length) { alert('No variations to export.'); return; }
  const btn = document.getElementById('expPrintPdfBtn');
  const status = document.getElementById('expPrintStatus');
  const originalLabel = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const setStatus = msg => { if (status) status.textContent = msg; };
  try {
    const { zipBlob } = await buildPrintZip(setStatus);
    const eventName = await loadEventName(S.projectId).catch(() => null);
    dl(URL.createObjectURL(zipBlob), `Flags_${sanitizeFilename(eventName || S.projectName || 'Export')}.zip`);
    setStatus(`Done — ${S.variations.length} variation${S.variations.length === 1 ? '' : 's'} exported.`);
  } catch (err) {
    console.error('Print export failed', err);
    setStatus('Export failed: ' + (err.message || err));
    alert('Print export failed. See console for details.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalLabel; }
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

renderSidebar(document.getElementById('sidebar'), {
  projectType: 'Tournament Flags',
  activeStep: 3,
  customerSection: true,
  projectId: new URLSearchParams(window.location.search).get('project'),
  steps: [
    {
      id: 'navDesign', label: 'Design', desc: 'Style, colors & logos',
      onClick: () => {
        const p = new URLSearchParams(window.location.search).get('project');
        window.location.href = 'flags.html' + (p ? '?project=' + p : '');
      },
    },
    {
      id: 'navVariations', label: 'Variations', desc: 'Build combinations',
      onClick: () => {
        const p = new URLSearchParams(window.location.search).get('project');
        if (p) window.location.href = 'flags-variations.html?project=' + p;
      },
    },
    { id: 'navGallery', label: 'Gallery', desc: 'Review & export' },
  ],
});

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (!_urlProject) { window.location.href = '/'; }

await loadAllFlags(FLAGS);

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
  await preloadLogoAspects(S.library);
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
  setSidebarProjectName(S.projectName, S.projectId);

  setupGallery();
} catch (err) {
  console.error('Could not load project', err);
}
