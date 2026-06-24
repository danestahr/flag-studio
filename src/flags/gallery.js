import '../style.css';
import { requireAuth } from '../auth.js';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

await requireAuth();

import { S } from '../state.js';
import { FLAGS, COLORS } from '../data.js';
import { getFlag, getLogoData, renderInto, makeSvg } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  loadProject, loadFlagConfig, loadLogosForProject,
  generateShareToken, getFeedback, supabase,
  loadOrderIntake, sendProofReady,
} from '../supabase.js';

let gFace = 'front';
let feedbackChannel = null;

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

function renderGStrip() {
  const el = document.getElementById('gStrip');
  if (!el) return;
  el.innerHTML = S.variations.map((v, i) => `
    <div class="gthumb ${i === S.gIndex ? 'active' : ''}" id="gt-${i}" onclick="gGoTo(${i})">
      <div id="gti-${i}" style="width:100%;height:100%"></div>
    </div>`).join('');
  S.variations.forEach((v, i) => {
    const thumb = document.getElementById('gti-' + i);
    if (thumb) renderInto(thumb, v.assignment, 'front');
  });
}

function renderGSlide() {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const flag = getFlag();
  const atStart = S.gIndex === 0;
  const atEnd   = S.gIndex === S.variations.length - 1;
  const count   = `${S.gIndex + 1} / ${S.variations.length}`;

  if (S.sameLogoOnBothSides) {
    renderInto(document.getElementById('gFlag'), v.assignment, gFace, gFace === 'back');
    document.getElementById('gName').textContent  = v.name;
    document.getElementById('gCount').textContent = count;
    document.getElementById('gPrev').disabled = atStart;
    document.getElementById('gNext').disabled = atEnd;
  } else {
    renderInto(document.getElementById('gFlagFront'), v.assignment, 'front');
    renderInto(document.getElementById('gFlagBack'),  v.backAssignment || {}, 'back');
    document.getElementById('gNameD').textContent  = v.name;
    document.getElementById('gCountD').textContent = count;
    document.getElementById('gPrevD').disabled = atStart;
    document.getElementById('gNextD').disabled = atEnd;
  }

  document.querySelectorAll('.gthumb').forEach((t, i) => t.classList.toggle('active', i === S.gIndex));

  const zoneRows = (flag?.logoZones || []).map(z => {
    const ld = getLogoData(v.assignment, z.id);
    const logo = ld ? S.library.find(l => l.id === ld.id) : null;
    return `<div class="drow"><span class="dkey">${z.label}</span><span class="dval">
      ${logo ? `<img src="${logo.src}" style="width:20px;height:20px;object-fit:contain;border-radius:3px">${esc(logo.name)}` : '<span style="color:var(--gray-400)">Empty</span>'}
    </span></div>`;
  }).join('');

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
}

function setupGallery() {
  S.gIndex = 0;
  gFace = 'front';
  const dual = !S.sameLogoOnBothSides;
  document.getElementById('gSingleView').style.display = dual ? 'none' : '';
  document.getElementById('gDualView').style.display   = dual ? '' : 'none';
  document.getElementById('gFtFront')?.classList.add('active');
  document.getElementById('gFtBack')?.classList.remove('active');
  if (S.shareToken) {
    const url = `${window.location.origin}/review.html?token=${S.shareToken}`;
    const input = document.getElementById('shareLinkInput');
    if (input) input.value = url;
  }
  if (S.projectId) {
    getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderGSlide(); }).catch(() => {});
    if (feedbackChannel) feedbackChannel.unsubscribe();
    feedbackChannel = supabase
      .channel('feedback-' + S.projectId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'variation_feedback', filter: `project_id=eq.${S.projectId}` },
        () => getFeedback(S.projectId, 'flags').then(fb => { S.feedback = fb; renderGSlide(); }).catch(() => {}))
      .subscribe();
  }
  renderGStrip();
  renderGSlide();
}

window.setGFace = function (face) {
  gFace = face;
  document.getElementById('gFtFront')?.classList.toggle('active', face === 'front');
  document.getElementById('gFtBack')?.classList.toggle('active', face === 'back');
  renderGSlide();
};

window.gNav   = function (d) { S.gIndex = Math.max(0, Math.min(S.variations.length - 1, S.gIndex + d)); renderGSlide(); };
window.gGoTo  = function (i) { S.gIndex = i; renderGSlide(); };

// ── Export ─────────────────────────────────────────────────

const FLAG_DPI = 300;

async function rasterizeSvg(assignment, face, mirrorX = false) {
  const flag = getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(assignment, vbW, vbH, face, mirrorX);

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

async function rasterizeForPrint(assignment, face, mirrorX = false) {
  const flag = getFlag();
  const [, , vbW, vbH] = (flag?.viewBox || '0 0 7519 4669').split(' ').map(Number);
  const svg = makeSvg(assignment, vbW, vbH, face, mirrorX);
  for (const gid of ['Bleed', 'bleed']) {
    const el = svg.querySelector('#' + gid);
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

window.expPDF = async function () {
  const v = S.variations[S.gIndex];
  if (!v) return;
  const flag = getFlag();
  if (!flag) return;
  const btn = document.getElementById('expPdf');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const faceAssignment = (gFace === 'back' && !S.sameLogoOnBothSides) ? (v.backAssignment || {}) : v.assignment;
    const { blob, vbW, vbH } = await rasterizeSvg(faceAssignment, gFace, S.sameLogoOnBothSides && gFace === 'back');
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
    const faceAssignment = (gFace === 'back' && !S.sameLogoOnBothSides) ? (v.backAssignment || {}) : v.assignment;
    const { blob } = await rasterizeSvg(faceAssignment, gFace, S.sameLogoOnBothSides && gFace === 'back');
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
      const { blob } = await rasterizeSvg(v.assignment, 'front');
      dl(URL.createObjectURL(blob), slug(v.name) + '.png');
      await new Promise(r => setTimeout(r, 400));
      if (!S.sameLogoOnBothSides) {
        const { blob: blobB } = await rasterizeSvg(v.backAssignment || {}, 'back');
        dl(URL.createObjectURL(blobB), slug(v.name) + '-back.png');
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) { console.error('PNG export failed for', v.name, err); }
  }
};

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
    const zip = new JSZip();
    const [, , vbW, vbH] = (getFlag()?.viewBox || '0 0 7519 4669').split(' ').map(Number);
    for (let i = 0; i < S.variations.length; i++) {
      const v = S.variations[i];
      setStatus(`Rendering ${i + 1} of ${S.variations.length}: ${v.name}…`);
      const frontAssign = v.assignment;
      const backAssign  = S.sameLogoOnBothSides ? v.assignment : (v.backAssignment || {});
      const { blob: frontPng } = await rasterizeForPrint(frontAssign, 'front');
      const { blob: backPng }  = await rasterizeForPrint(backAssign, 'back', S.sameLogoOnBothSides);
      const safe = slug(v.name) || 'variation-' + (i + 1);
      if (format === 'png') {
        zip.file(`${safe}/${safe}-front.png`, frontPng);
        zip.file(`${safe}/${safe}-back.png`,  backPng);
      } else {
        zip.file(`${safe}/${safe}-front.pdf`, await pngBlobToPdfBlob(frontPng, vbW, vbH));
        zip.file(`${safe}/${safe}-back.pdf`,  await pngBlobToPdfBlob(backPng,  vbW, vbH));
      }
    }
    setStatus('Zipping…');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const flag = getFlag();
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
  if (flagCfg) {
    S.flagId = flagCfg.flag_id;
    S.colors = flagCfg.colors || {};
    const varData = flagCfg.variations || [];
    const varItems = Array.isArray(varData) ? varData : (varData.items || []);
    S.variations = varItems.map(v => ({ ...v, backAssignment: v.backAssignment || {} }));
    S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
    S.sameLogoOnBothSides = flagCfg.same_logo_on_both_sides ?? true;
    S.activeVarId = S.variations[0]?.id || null;
    // Apply logoLayout to the live flag object so renderInto/makeSvg uses the right zones
    const flag = getFlag();
    if (flag?.logoZoneSets) {
      flag.logoZones = flag.logoZoneSets[S.logoLayout] || flag.logoZones;
    }
  }
  const nameInput = document.getElementById('projectNameInput');
  if (nameInput) nameInput.value = S.projectName;

  setupGallery();
} catch (err) {
  console.error('Could not load project', err);
}
