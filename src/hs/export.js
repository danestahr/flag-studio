import '../order.css';
import { HS, UI, getEffectiveState, getEffectiveVariation } from './state.js';
import { HS_H, HS_W } from '../hole-sign-data.js';
import { escXml, makeHoleSignSvg, renderHoleSignInto } from '../hole-sign-render.js';
import {
  generateShareToken, loadEventName, loadHoleSignConfig,
  loadOrderIntake, uploadPrintSheet, sendPrintSheetReady, sendProofReady,
  submitDesignForReview, adminSendDesignProof, resolveFeedback,
} from '../supabase.js';
import { PDFDocument, PDFName, PDFNumber, PDFOperator, PDFString } from 'pdf-lib';
import JSZip from 'jszip';
import { dl, slug, sanitizeFilename, mapWithConcurrency } from '../dom-utils.js';
import { pngBlobToPdfBlob } from '../pdf-utils.js';
import { saveDraftInternal } from './draft.js';
import { applyRequestedHsTemplate, applyRequestedHsColors, applyRequestedHsLogo } from './variations.js';
import { STATUS_LABEL } from '../status-labels.js';

// ── Step 3: Review ──────────────────────────────────────────

// Mirrors flags/gallery.js's reviewStatusOf/variation-list.js's statusTileHtml —
// same three states, same class names (.var-status-tile), sourced from
// HS.feedback instead of S.feedback.
function reviewStatusOf(v) {
  const fb = HS.feedback?.find(f => f.variation_id === v.id);
  if (fb?.status === 'approved') return { cls: 'approved', label: 'Approved' };
  if (fb?.status === 'needs_edits' && !fb?.resolved) return { cls: 'needs-edits', label: 'Needs edits' };
  return { cls: 'not-reviewed', label: 'Not reviewed' };
}

function hsReviewStats() {
  const total = HS.variations.length;
  let approved = 0, needsEdits = 0;
  HS.variations.forEach(v => {
    const cls = reviewStatusOf(v).cls;
    if (cls === 'approved') approved++;
    else if (cls === 'needs-edits') needsEdits++;
  });
  return { total, approved, needsEdits, pending: total - approved - needsEdits };
}

// Only shown once a share-for-review link exists (see HS.shareToken) —
// before that there's nothing for a customer to have responded to yet.
function renderReviewProgress() {
  if (!HS.shareToken || !HS.variations.length) return '';
  const { total, approved, needsEdits, pending } = hsReviewStats();
  return `
    <div class="hs-review-progress" id="hsReviewProgress">
      <div class="hs-review-progress-counts">
        <span class="hs-review-progress-count approved">${approved} approved</span>
        <span class="hs-review-progress-count needs-edits">${needsEdits} needs edits</span>
        <span class="hs-review-progress-count pending">${pending} pending</span>
      </div>
      <div class="hs-review-progress-bar">
        <div class="hs-review-progress-fill approved" style="width:${Math.round((approved / total) * 100)}%"></div>
        <div class="hs-review-progress-fill needs-edits" style="width:${Math.round((needsEdits / total) * 100)}%"></div>
      </div>
    </div>`;
}

export function renderGallery() {
  const panel = document.getElementById('panel-3');
  panel.innerHTML = `
    <div class="hs-design-layout">
      <div class="hs-design-preview-col">
        ${renderReviewProgress()}
        <div class="hs-review-list" id="hsReviewList"></div>
      </div>
    </div>
`;
  const hsGalleryCount = HS.variations.length;
  const hsGalleryQty = HS.variations.reduce((sum, v) => sum + (parseInt(v.qty, 10) || 1), 0);
  document.getElementById('sidebarPanelHeader').innerHTML = `
    <div class="p1-header hs-panel-header">
      <div>
        <div class="ptitle">Review</div>
        <div class="p1-header-stats">${hsGalleryCount} variation${hsGalleryCount === 1 ? '' : 's'} &middot; ${hsGalleryQty} sign${hsGalleryQty === 1 ? '' : 's'} total</div>
      </div>
      <div class="p1-header-actions">
        <button class="btn sm save-draft-btn" id="saveDraftBtn" onclick="saveDraft()" style="display:none">Save draft</button>
      </div>
    </div>`;

  // Share/print actions live in the left menu's logos-tile slot, same as the
  // flag wizard's Gallery step (flags/gallery.js) — not a right-hand card
  // full-width above the list.
  const logosTile = document.getElementById('sidebarLogosTile');
  if (logosTile) {
    logosTile.style.display = '';
    const shareUrl = HS.shareToken ? `${window.location.origin}/review?token=${HS.shareToken}&tab=hole-signs` : '';
    logosTile.innerHTML = `
    <div class="hs-design-controls-body">
      <div class="share-section" id="shareSection">
        <div class="rc-title">Share for review</div>
        ${shareUrl ? `<div class="status-pill status-${HS.projectStatus}" style="margin-bottom:8px">${escXml(STATUS_LABEL[HS.projectStatus] || HS.projectStatus)}</div>` : ''}
        <div id="hsShareStatus" style="font-size:13px;color:var(--gray-400);min-height:16px"></div>
        <button class="btn sm primary" style="width:100%;justify-content:center" onclick="openHsShareModal()">Share for review <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        <div class="share-link-box" id="hsShareLinkBox" style="display:${shareUrl ? 'flex' : 'none'}">
          <input class="share-link-input" id="hsShareLinkInput" readonly value="${escXml(shareUrl)}">
          <button class="btn sm" onclick="copyHsShareLink()">Copy</button>
          <button class="btn sm" onclick="window.refreshHsGallery()" title="Refresh with the latest saved design"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Update</button>
        </div>
      </div>
      <div class="share-section">
        <div class="rc-title">Print files</div>
        <button class="btn sm primary" id="hsExpPrintBtn" style="width:100%;justify-content:center" onclick="downloadHsPrint()"><i class="fa-solid fa-download" aria-hidden="true"></i> Download print sheets (zip)</button>
        <div id="hsExpPrintStatus" style="font-size:12px;color:var(--gray-600);min-height:14px"></div>
      </div>
      <div class="share-section" id="hsEmailPrintSheetSection" style="display:${UI.isStaffOrAdmin ? '' : 'none'}">
        <div class="rc-title">Email PDF sheet link</div>
        <button class="btn sm primary" style="width:100%;justify-content:center" onclick="openEmailPrintSheetModal()">Email PDF sheet link <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
      </div>
    </div>`;
  }

  ensureEmailPrintSheetModal();
  ensureHsShareModal();

  const list = document.getElementById('hsReviewList');
  if (!HS.variations.length) {
    list.innerHTML = '<div style="font-size:13px;color:var(--gray-400)">No variations yet.</div>';
    return;
  }

  HS.variations.forEach(v => {
    const status = reviewStatusOf(v);
    const fb = HS.feedback?.find(f => f.variation_id === v.id);
    const requestedButtons = [];
    if (fb?.status === 'needs_edits' && !fb?.resolved) {
      if (fb.requested_template_id) requestedButtons.push(`<button type="button" class="hs-review-apply-btn" onclick="hsApplyRequestedTemplate('${v.id}')">Apply requested template</button>`);
      if (fb.requested_colors && Object.keys(fb.requested_colors).length) requestedButtons.push(`<button type="button" class="hs-review-apply-btn" onclick="hsApplyRequestedColors('${v.id}')">Apply requested colors</button>`);
      if (fb.requested_logo_url) requestedButtons.push(`<button type="button" class="hs-review-apply-btn" onclick="hsApplyRequestedLogo('${v.id}')">Apply requested logo</button>`);
    }
    const card = document.createElement('div');
    card.className = 'hs-review-card';
    card.id = 'hsrev-' + v.id;
    card.innerHTML = `
      <div class="hs-review-card-header">
        <span class="hs-review-card-name">${escXml(v.name)}</span>
        <div class="hs-review-card-meta">
          <span class="var-status-tile ${status.cls}">${status.label}</span>
          <div class="hs-review-actions">
            ${UI.hsLocked ? '' : `<button class="btn sm" onclick="editHsVariation('${v.id}')"><i class="fa-solid fa-pen" aria-hidden="true"></i> Edit</button>`}
            <button class="btn sm" onclick="exportHsPDF('${v.id}', this)"><i class="fa-solid fa-file-pdf" aria-hidden="true"></i> PDF</button>
          </div>
        </div>
      </div>
      <div class="hs-review-card-body">
        <div class="hs-review-image" id="hsrevimg-${v.id}"></div>
        <div class="hs-review-info">
          <div class="hs-review-notes">
            <span class="hs-review-notes-label">Review notes</span>
            ${fb?.note ? escXml(fb.note) : 'No notes yet.'}
          </div>
          ${requestedButtons.length ? `<div class="hs-review-requested">${requestedButtons.join('')}</div>` : ''}
        </div>
      </div>`;
    list.appendChild(card);
    const imgEl = document.getElementById('hsrevimg-' + v.id);
    if (imgEl) renderHoleSignInto(imgEl, getEffectiveState(v), getEffectiveVariation(v));
  });
}

// Jumps back to Variations with this design selected for editing — same
// "resume where the reviewer was looking" pattern as flags/gallery.js's
// per-card Edit link, just via goStep() instead of a page navigation since
// the hole-sign wizard is a single page.
window.editHsVariation = function (id) {
  HS.activeVarId = id;
  window.goStep(2);
};

// Apply a customer's requested quick-pick change (see review.js's
// Request-edits quick-picks and the variation_feedback.requested_* columns)
// straight onto this one variation — the mutation itself lives in
// hs/variations.js (applyRequestedHsTemplate/Colors/Logo) so the "View
// Edits" modal on the Variations step can apply the same requests without
// duplicating this logic.
async function resolveHsGalleryFeedback(fb) {
  if (!fb) return;
  await resolveFeedback(HS.projectId, 'hole-signs', fb.variation_id);
  fb.resolved = true;
}

window.hsApplyRequestedTemplate = async function (id) {
  const v = HS.variations.find(v => v.id === id);
  const fb = HS.feedback?.find(f => f.variation_id === id);
  if (!v || !applyRequestedHsTemplate(v, fb)) return;
  await saveDraftInternal().catch(() => {});
  await resolveHsGalleryFeedback(fb);
  renderGallery();
};

window.hsApplyRequestedColors = async function (id) {
  const v = HS.variations.find(v => v.id === id);
  const fb = HS.feedback?.find(f => f.variation_id === id);
  if (!v || !applyRequestedHsColors(v, fb)) return;
  await saveDraftInternal().catch(() => {});
  await resolveHsGalleryFeedback(fb);
  renderGallery();
};

window.hsApplyRequestedLogo = async function (id) {
  const v = HS.variations.find(v => v.id === id);
  const fb = HS.feedback?.find(f => f.variation_id === id);
  if (!v || !(await applyRequestedHsLogo(v, fb))) return;
  await saveDraftInternal().catch(() => {});
  await resolveHsGalleryFeedback(fb);
  renderGallery();
};

// The gallery panel (unlike flags-gallery.html) is built entirely from JS,
// so there's no static modal markup to add to - inject it once into the
// body the first time the gallery renders.
function ensureEmailPrintSheetModal() {
  if (document.getElementById('hsEmailPrintSheetModalOverlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'share-modal-overlay';
  overlay.id = 'hsEmailPrintSheetModalOverlay';
  overlay.style.display = 'none';
  overlay.setAttribute('onclick', 'closeEmailPrintSheetModal(event)');
  overlay.innerHTML = `
    <div class="share-modal">
      <div class="share-modal-header">
        <span class="share-modal-title">Email PDF sheet link</span>
        <button class="share-modal-close" onclick="closeEmailPrintSheetModal()" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
      <div class="share-modal-body">
        <p style="font-size:13px;color:var(--gray-500);line-height:1.5;margin:0 0 1rem">This renders the full print-quality PDF sheets, uploads them privately, and emails a download link that expires in 7 days — not the customer-facing share link above.</p>
        <p class="share-modal-label">Send to</p>
        <input class="share-email-input" id="hsEmailPrintSheetEmailInput" type="email" placeholder="vendor@example.com">
        <div id="hsEmailPrintSheetStatus" style="font-size:13px;color:var(--gray-400);min-height:16px;margin-top:6px"></div>
        <button class="btn sm primary" style="width:100%;justify-content:center;margin-top:8px" onclick="sendHsPrintSheetEmail()">Send link</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

window.openEmailPrintSheetModal = async function () {
  if (!HS.projectId) { alert('Save your project first.'); return; }
  const emailInput = document.getElementById('hsEmailPrintSheetEmailInput');
  emailInput.value = '';
  loadOrderIntake(HS.projectId).then(intake => { if (intake?.contact_email) emailInput.value = intake.contact_email; }).catch(() => {});
  document.getElementById('hsEmailPrintSheetStatus').textContent = '';
  document.getElementById('hsEmailPrintSheetModalOverlay').style.display = 'flex';
};

window.closeEmailPrintSheetModal = function (e) {
  if (e && e.target !== document.getElementById('hsEmailPrintSheetModalOverlay')) return;
  document.getElementById('hsEmailPrintSheetModalOverlay').style.display = 'none';
};

window.sendHsPrintSheetEmail = async function () {
  const email = document.getElementById('hsEmailPrintSheetEmailInput').value.trim();
  const status = document.getElementById('hsEmailPrintSheetStatus');
  if (!email) { status.textContent = 'Enter an email address.'; return; }
  const btn = document.querySelector('#hsEmailPrintSheetModalOverlay .btn.primary');
  if (btn) btn.disabled = true;
  const setStatus = msg => { status.textContent = msg; };
  try {
    const intake = await loadOrderIntake(HS.projectId).catch(() => null);
    const eventName = intake?.event_name || HS.projectName || 'your event';
    const eventNameSlug = sanitizeFilename(eventName);
    let sent = 0;
    // One zip (and one email) per sheet, same reasoning as downloadHsPrint —
    // uploading/sending as each sheet's zip is ready keeps memory bounded
    // regardless of order size, at the cost of multiple emails for a
    // multi-sheet order instead of one with several links.
    await buildHsPrintSheets(eventNameSlug, setStatus, async ({ from, to, baseName, zipBlob, sheets }) => {
      setStatus(`Uploading ${baseName}…`);
      const storagePath = await uploadPrintSheet(HS.projectId, 'hole-signs', zipBlob);
      setStatus(`Sending ${baseName}…`);
      await sendPrintSheetReady({
        projectId: HS.projectId,
        storagePath,
        recipientEmail: email,
        recipientName: intake?.contact_name || '',
        eventName: sheets === 1 ? eventName : `${eventName} — signs ${from}-${to}`,
        productType: 'hole-signs',
      });
      sent++;
    });
    status.style.color = 'var(--green, #2d9d5c)';
    status.textContent = sent === 1 ? 'Link sent!' : `${sent} links sent!`;
    setTimeout(() => { status.textContent = ''; status.style.color = ''; }, 3000);
  } catch (err) {
    console.error('sendHsPrintSheetEmail failed', err);
    status.style.color = 'var(--red, #c0392b)';
    status.textContent = `Failed to send: ${err.message || err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
};

// ── Export ─────────────────────────────────────────────────
export function hsSlug(s) { return slug(s, 'hole-sign'); }

// Per-card PDF download on the Review step — id/btn identify which
// variation and which button triggered it (there's no single "selected"
// design anymore now that every variation gets its own row).
window.exportHsPDF = async function (id, btn) {
  const v = HS.variations.find(v => v.id === id);
  if (!v) return;
  const originalHtml = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '…'; }
  try {
    const blob = await hsRasterize(v);
    const ptW = 21.25 * 72;
    const ptH = Math.round(ptW * HS_H / HS_W);
    const pdfBlob = await pngBlobToPdfBlob(blob, ptW, ptH);
    dl(URL.createObjectURL(pdfBlob), hsSlug(v.name) + '.pdf');
  } catch (err) {
    console.error('Hole sign PDF export failed', err);
    alert('PDF export failed.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
  }
};

// ── Print sheets ───────────────────────────────────────────
// Layout: 5 cols × 2 rows = 10 signs per sheet, each rotated 90° CW.
// Sheet: 94.25" × 44" @ 300 DPI, with a 0.5" gap between every bleed box
// and a 0.5" margin around the outer edge (Fred's template — the extra
// room is deliberate wiggle room for imprecise material cuts). Sign
// native: 6375×5475 (= 21.25" × 18.25" incl. bleed; 21" × 18" trim).
// After rotation, each cell is 5475×6375 (= 18.25" × 21.25"), matching
// the grid: 5 × 18.25 + 4 × 0.5 + 2 × 0.5 = 94.25; 2 × 21.25 + 1 × 0.5 + 2 × 0.5 = 44.
const HS_PRINT = {
  cols: 5,
  rows: 2,
  perSheet: 10,
  sheetWIn: 94.25,
  sheetHIn: 44,
  gapIn: 0.5,
  marginIn: 0.5,
  dpi: 300,
};

// Sign artwork is always fully opaque — makeHoleSignSvg always paints a
// full-bleed background rect first (hole-sign-render.js), color or image —
// so there's no alpha channel to lose by rasterizing to JPEG instead of PNG
// here. That choice matters beyond file size: pdf-lib's embedJpg just reads
// the JPEG header and stores the compressed bytes as-is, while embedPng has
// to fully decode the PNG (inflate + convert every pixel to RGBA) in pure
// JS — for a 6375×5475 sign that decode is the actual bottleneck in the
// print-sheet export, not the rasterization that produces this blob.
const SIGN_JPEG_QUALITY = 0.92;

// Build a 90° CW rotated JPEG blob for one sign. Used for both front and back —
// the back sheet keeps the same per-sign orientation (text stays readable);
// only the cell positions change (rows are swapped).
export async function buildRotatedSignJpeg(signCanvas) {
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
    c.toBlob(b => b ? resolve(b) : reject(new Error('rotate toBlob failed')), 'image/jpeg', SIGN_JPEG_QUALITY));
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

// Build two Optional Content Groups on the document — "Thru" (cut lines) and
// "Art" (sign artwork). Individual cut-line rectangles and sign groups are
// deliberately left as plain, anonymous content inside these two — not
// wrapped in their own per-cell OCGs — so a design tool's Layers panel shows
// them by their own recognized type (a plain rectangle path as "<Rectangle>",
// a Form XObject as "<Group>") directly under "Thru"/"Art", matching how the
// printer's reference template is organized, rather than as a third
// named-sublayer level we invented.
export function createLayerGroups(doc, page) {
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

  const allOcgs = [thruHead, artHead];
  const oc = context.obj({
    OCGs: allOcgs,
    D: {
      Order: allOcgs,
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
    thruColorSpace: createThruSpotColorSpace(doc, page),
  };
  properties.set(PDFName.of(names.thru), thruHead);
  properties.set(PDFName.of(names.art),  artHead);
  return names;
}

// Registers a true named spot color ("Thru", the printer's cut-line ink) as
// a PDF Separation color space, rather than approximating it as process
// CMYK — the printer's RIP reads the colorant name itself to route the cut
// line to their machines, so it must survive as a named ink, not a 4-color
// mix. Tint 1.0 maps to CMYK 30/0/100/0 (their spec); 0 maps to no ink.
function createThruSpotColorSpace(doc, page) {
  const context = doc.context;
  const tintTransform = context.register(context.obj({
    FunctionType: 2,
    Domain: [0, 1],
    C0: [0, 0, 0, 0],
    C1: [0.3, 0, 1, 0],
    N: 1,
  }));
  const separation = context.register(
    context.obj(['Separation', 'Thru', 'DeviceCMYK', tintTransform]),
  );

  const resources = page.node.Resources();
  const ColorSpaceKey = PDFName.of('ColorSpace');
  let colorSpaces = resources.get(ColorSpaceKey);
  if (!colorSpaces) {
    colorSpaces = context.obj({});
    resources.set(ColorSpaceKey, colorSpaces);
  }
  const alias = 'CSThru';
  colorSpaces.set(PDFName.of(alias), separation);
  return alias;
}

export function beginLayer(page, layerName) {
  page.pushOperators(PDFOperator.of('BDC', [PDFName.of('OC'), PDFName.of(layerName)]));
}
export function endLayer(page) {
  page.pushOperators(PDFOperator.of('EMC'));
}

// Strokes a rectangle using the named "Thru" spot color instead of
// pdf-lib's drawRectangle (which only knows DeviceRGB/Gray/CMYK, not
// Separation) — CS/SCN select the spot color space and full tint directly
// via raw content-stream operators, same technique as beginLayer/endLayer.
function strokeSpotRectangle(page, colorSpaceAlias, x, y, width, height, lineWidthPt) {
  page.pushOperators(
    PDFOperator.of('q'),
    PDFOperator.of('w', [PDFNumber.of(lineWidthPt)]),
    PDFOperator.of('CS', [PDFName.of(colorSpaceAlias)]),
    PDFOperator.of('SCN', [PDFNumber.of(1)]),
    PDFOperator.of('re', [PDFNumber.of(x), PDFNumber.of(y), PDFNumber.of(width), PDFNumber.of(height)]),
    PDFOperator.of('S'),
    PDFOperator.of('Q'),
  );
}

// Wraps one embedded sign image in its own Form XObject so it reads as a
// "<Group>" (rather than a bare "<Image>") in a design tool's Layers panel —
// matching the printer's reference template, where each sign sits inside its
// own group. BBox must cover the drawn area or the form's content is clipped
// away entirely (PDF forms clip to their BBox).
function buildSignForm(doc, image, width, height) {
  const context = doc.context;
  const resources = context.obj({ XObject: { Im0: image.ref } });
  const ops = [
    PDFOperator.of('q'),
    PDFOperator.of('cm', [PDFNumber.of(width), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(height), PDFNumber.of(0), PDFNumber.of(0)]),
    PDFOperator.of('Do', [PDFName.of('Im0')]),
    PDFOperator.of('Q'),
  ];
  const form = context.formXObject(ops, { BBox: [0, 0, width, height], Resources: resources });
  return context.register(form);
}

// Wraps a row's worth of sign-group Form XObjects (see buildSignForm) in one
// outer Form XObject, so a full row of signs groups together as a single
// "<Group>" in the Layers panel — the printer's reference template groups
// one row of signs together this way, same idea one level up. Cells are
// spaced by cellWpt + gapPt so the 0.5" gap between bleed boxes carries
// through to the grouped row, not just the ungapped per-row math.
function buildRowForm(doc, signFormRefs, cellWpt, cellHpt, gapPt) {
  const context = doc.context;
  const xobjectDict = {};
  const ops = [];
  const strideWpt = cellWpt + gapPt;
  signFormRefs.forEach((ref, i) => {
    const alias = `S${i}`;
    xobjectDict[alias] = ref;
    ops.push(
      PDFOperator.of('q'),
      PDFOperator.of('cm', [PDFNumber.of(1), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(1), PDFNumber.of(i * strideWpt), PDFNumber.of(0)]),
      PDFOperator.of('Do', [PDFName.of(alias)]),
      PDFOperator.of('Q'),
    );
  });
  const width = strideWpt * signFormRefs.length - gapPt;
  const resources = context.obj({ XObject: xobjectDict });
  const form = context.formXObject(ops, { BBox: [0, 0, width, cellHpt], Resources: resources });
  return context.register(form);
}

// Wires an already-registered Form XObject ref into a page's own resources
// under a fresh alias, then draws it translated to (x, y) — the counterpart
// to buildSignForm/buildRowForm, which only build the reusable object itself.
let _formAliasCounter = 0;
function drawFormOnPage(doc, page, formRef, x, y) {
  const context = doc.context;
  const resources = page.node.Resources();
  const XObjectKey = PDFName.of('XObject');
  let xobjects = resources.get(XObjectKey);
  if (!xobjects) {
    xobjects = context.obj({});
    resources.set(XObjectKey, xobjects);
  }
  const alias = `Row${_formAliasCounter++}`;
  xobjects.set(PDFName.of(alias), formRef);
  page.pushOperators(
    PDFOperator.of('q'),
    PDFOperator.of('cm', [PDFNumber.of(1), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(1), PDFNumber.of(x), PDFNumber.of(y)]),
    PDFOperator.of('Do', [PDFName.of(alias)]),
    PDFOperator.of('Q'),
  );
}

// How many signs to rasterize/rotate concurrently. Since rotated PNGs are
// built lazily per-sheet (see rotatedCache in buildHsPrintSheets) rather than
// for the whole order up front, this also bounds peak memory: at most this
// many full-resolution native canvases exist at once, regardless of how
// many unique signs are in the order.
const HS_EXPORT_CONCURRENCY = 4;

// Builds one small zip per print sheet (front/back PDF, ~10-20MB total)
// instead of one big zip for the whole order, and hands each to
// `onSheetReady` as soon as it's ready rather than accumulating them —
// shared by the local "Download print sheets" button and the "Email PDF
// sheet link" flow, so the actual rendering only lives in one place.
//
// Why per-sheet instead of one zip: JSZip's generateAsync assembles
// everything it's been given into one contiguous output. Bundling every
// sheet's PDFs into a single JSZip instance means that final assembly's
// size — and the memory still resident from every prior sheet's rendering
// that hasn't been GC'd yet — grows with the order's total sign count, and
// large real orders (with actual photo/logo content, not flat test swatches)
// were hitting "Array buffer allocation failed" there even after rendering
// itself was already bounded per-sheet. Generating a tiny zip per sheet and
// handing it off immediately means every JSZip call and its inputs are
// released before the next sheet starts, so peak memory no longer scales
// with order size at all.
export async function buildHsPrintSheets(eventNameSlug, setStatus = () => {}, onSheetReady = () => {}) {
  if (!HS.variations.length) throw new Error('No variations to export.');

  // Build flat sequence: variation repeated by its qty.
  const sequence = [];
    HS.variations.forEach(v => {
      const qty = Math.max(1, parseInt(v.qty, 10) || 1);
      for (let i = 0; i < qty; i++) sequence.push(v);
    });
    const total = sequence.length;
    if (!total) throw new Error('No signs to print (set Qty on variations).');
    const sheets = Math.ceil(total / HS_PRINT.perSheet);

    setStatus(`Rendering ${total} sign${total === 1 ? '' : 's'} across ${sheets} sheet${sheets === 1 ? '' : 's'}…`);

    const sigOf = v => v.id;
    const seenSigs = new Set();
    const uniqueVariations = sequence.filter(v => {
      if (seenSigs.has(sigOf(v))) return false;
      seenSigs.add(sigOf(v));
      return true;
    });

    // Rotated JPEG per unique variation (same orientation for both sides),
    // built lazily and cached by sig — NOT pre-rendered for the whole order
    // up front. A native canvas is full print resolution (6375×5475, ~133MB
    // of raw pixels); at large order sizes, rendering every unique sign
    // before building any sheet would hold gigabytes of raw canvases at
    // once. A sign only needs to exist as a rotated JPEG (already compressed)
    // by the time its sheet is built, so the native canvas is rasterized,
    // rotated, and dropped one sheet's worth at a time (see the
    // ensureRotatedJpeg prefetch in the sheet loop below) — peak memory is
    // bounded by HS_EXPORT_CONCURRENCY, not by the order's total unique
    // sign count. The rotated JPEG itself (compressed, much smaller) is kept
    // cached across sheets in case a sign repeats on a later one.
    let renderedCount = 0;
    const rotatedCache = new Map(); // sig -> Promise<Blob>
    const ensureRotatedJpeg = v => {
      const sig = sigOf(v);
      if (!rotatedCache.has(sig)) {
        rotatedCache.set(sig, (async () => {
          const nativeCanvas = await rasterizeSignNative(v);
          const jpeg = await buildRotatedSignJpeg(nativeCanvas);
          setStatus(`Rendering variation ${++renderedCount}/${uniqueVariations.length}: ${v.name}…`);
          return jpeg;
        })());
      }
      return rotatedCache.get(sig);
    };

    // Build the PDFs. Each cell is a fixed bleed-box size (the rotated sign
    // dimensions), not derived from the sheet size — the sheet is the cells
    // plus a 0.5" gap between them and a 0.5" outer margin (see HS_PRINT).
    const ptW = HS_PRINT.sheetWIn * 72;
    const ptH = HS_PRINT.sheetHIn * 72;
    const cellWpt = (HS_H / HS_PRINT.dpi) * 72;
    const cellHpt = (HS_W / HS_PRINT.dpi) * 72;
    const gapPt = HS_PRINT.gapIn * 72;
    const marginPt = HS_PRINT.marginIn * 72;
    const cellX = col => marginPt + col * (cellWpt + gapPt);
    const cellY = row => marginPt + (HS_PRINT.rows - 1 - row) * (cellHpt + gapPt);

    // Cut-line guide: 21" tall × 18" wide rectangle centered in each cell.
    // 1px (1pt) stroke, the printer's named "Thru" spot color (see
    // createThruSpotColorSpace). Marks where the finished sign is trimmed
    // from the print sheet; the surrounding area is bleed.
    const CUT_W_PT = 18 * 72;
    const CUT_H_PT = 21 * 72;
    const CUT_X_OFF = (cellWpt - CUT_W_PT) / 2;
    const CUT_Y_OFF = (cellHpt - CUT_H_PT) / 2;
    const drawCutLine = (page, colorSpaceAlias, col, row) => {
      const x = cellX(col) + CUT_X_OFF;
      const y = cellY(row) + CUT_Y_OFF;
      strokeSpotRectangle(page, colorSpaceAlias, x, y, CUT_W_PT, CUT_H_PT, 1);
    };

    // Builds one row's worth of sign artwork as a row-of-groups Form XObject
    // (see buildSignForm/buildRowForm) and places it on the page — matching
    // the printer's reference template, where each row of signs groups
    // together under "Art" instead of sitting as flat per-cell images.
    const drawArtRow = async (doc, page, rowCells, imageCache, y) => {
      if (!rowCells.length) return;
      const signRefs = [];
      for (const cell of rowCells) {
        const sig = sigOf(cell);
        let image = imageCache.get(sig);
        if (!image) {
          const jpegBlob = await ensureRotatedJpeg(cell);
          const jpegBytes = await jpegBlob.arrayBuffer();
          image = await doc.embedJpg(jpegBytes);
          imageCache.set(sig, image);
        }
        signRefs.push(buildSignForm(doc, image, cellWpt, cellHpt));
      }
      const rowFormRef = buildRowForm(doc, signRefs, cellWpt, cellHpt, gapPt);
      drawFormOnPage(doc, page, rowFormRef, marginPt, y);
    };

    for (let s = 0; s < sheets; s++) {
      setStatus(`Building sheet ${s + 1} of ${sheets}…`);
      const start = s * HS_PRINT.perSheet;
      const cells = sequence.slice(start, start + HS_PRINT.perSheet);
      const from = start + 1;
      const to = Math.min(start + HS_PRINT.perSheet, total);
      const baseName = `${eventNameSlug}_Signs_${from}-${to}`;

      // Rasterize/rotate this sheet's unique signs up front, with bounded
      // concurrency, before building its pages — reused below for both the
      // front and back layouts (drawArtRow just hits the now-warm cache).
      const sheetVariations = [...new Map(cells.map(c => [sigOf(c), c])).values()];
      await mapWithConcurrency(sheetVariations, HS_EXPORT_CONCURRENCY, ensureRotatedJpeg);

      // Front PDF
      const frontDoc = await PDFDocument.create();
      const frontPage = frontDoc.addPage([ptW, ptH]);
      const frontNames = createLayerGroups(frontDoc, frontPage);

      // Place sign images inside the "Art" group, one row-of-groups at a time
      beginLayer(frontPage, frontNames.art);
      const frontImageCache = new Map();
      for (let row = 0; row < HS_PRINT.rows; row++) {
        const rowCells = cells.slice(row * HS_PRINT.cols, row * HS_PRINT.cols + HS_PRINT.cols);
        await drawArtRow(frontDoc, frontPage, rowCells, frontImageCache, cellY(row));
      }
      endLayer(frontPage);
      // Draw cut lines inside the "Thru" group — flat, one rectangle per cell
      beginLayer(frontPage, frontNames.thru);
      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        drawCutLine(frontPage, frontNames.thruColorSpace, col, row);
      }
      endLayer(frontPage);
      const frontBytes = await frontDoc.save();

      // Back PDF — same per-sign orientation, but rows are swapped so that when
      // the paper is duplexed (flipped along the long edge), each cell on the
      // back aligns with its corresponding cell on the front through the paper.
      const backDoc = await PDFDocument.create();
      const backPage = backDoc.addPage([ptW, ptH]);
      const backNames = createLayerGroups(backDoc, backPage);

      beginLayer(backPage, backNames.art);
      const backImageCache = new Map();
      for (let row = 0; row < HS_PRINT.rows; row++) {
        const rowCells = cells.slice(row * HS_PRINT.cols, row * HS_PRINT.cols + HS_PRINT.cols);
        const swappedRow = HS_PRINT.rows - 1 - row;
        await drawArtRow(backDoc, backPage, rowCells, backImageCache, cellY(swappedRow));
      }
      endLayer(backPage);
      beginLayer(backPage, backNames.thru);
      for (let i = 0; i < cells.length; i++) {
        const col = i % HS_PRINT.cols;
        const row = Math.floor(i / HS_PRINT.cols);
        const swappedRow = HS_PRINT.rows - 1 - row;
        drawCutLine(backPage, backNames.thruColorSpace, col, swappedRow);
      }
      endLayer(backPage);
      const backBytes = await backDoc.save();

      setStatus(`Zipping sheet ${s + 1} of ${sheets}…`);
      const sheetZip = new JSZip();
      sheetZip.file(`${baseName}_Front.pdf`, frontBytes);
      sheetZip.file(`${baseName}_Back.pdf`,  backBytes);
      const zipBlob = await sheetZip.generateAsync({ type: 'blob' });

      await onSheetReady({ index: s, from, to, baseName, zipBlob, sheets, total });
      // Nothing from this sheet (cells' rasterized canvases aside, already
      // freed) is referenced past this point, so it's eligible for GC before
      // the next sheet's rendering starts.
    }

  return { total, sheets };
}

window.downloadHsPrint = async function () {
  const btn = document.getElementById('hsExpPrintBtn');
  const status = document.getElementById('hsExpPrintStatus');
  const origLabel = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const setStatus = msg => { if (status) status.textContent = msg; };

  try {
    const eventName = await loadEventName(HS.projectId).catch(() => null);
    const eventNameSlug = sanitizeFilename(eventName || HS.projectName || 'Export');
    let downloaded = 0;
    const { total, sheets } = await buildHsPrintSheets(eventNameSlug, setStatus, async ({ baseName, zipBlob, sheets }) => {
      dl(URL.createObjectURL(zipBlob), `${baseName}.zip`);
      downloaded++;
      setStatus(`Downloaded ${downloaded} of ${sheets} zip${sheets === 1 ? '' : 's'}…`);
    });
    setStatus(`Done — ${total} signs across ${sheets} zip${sheets === 1 ? '' : 's'} (${sheets * 2} files).`);
  } catch (err) {
    console.error('Hole sign print export failed', err);
    setStatus('Export failed: ' + (err.message || err));
    alert('Print export failed. See console for details.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel || '<i class="fa-solid fa-download" aria-hidden="true"></i> Download print sheets (zip)'; }
  }
};

// Keyed by source URL, not per-call — many signs in an order share the same
// background/banner/template-logo asset (only the text differs between
// them), so without this cache a large print export would re-fetch and
// re-base64-encode the identical bytes once per sign that uses it. Same
// "cache once, reuse across the whole export" reasoning as
// UI.fontCssCache/getEmbeddedFontCss below.
const _hsInlineHrefCache = new Map(); // src URL -> data: URI

export async function hsInlineHrefs(svgEl) {
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  await Promise.all(Array.from(svgEl.querySelectorAll('image')).map(async img => {
    const src = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (!src || src.startsWith('data:')) return;
    const cached = _hsInlineHrefCache.get(src);
    if (cached) { img.setAttribute('href', cached); return; }
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
      const dataUri = `data:${mime};base64,${btoa(binary)}`;
      _hsInlineHrefCache.set(src, dataUri);
      img.setAttribute('href', dataUri);
    } catch { /* leave as-is on failure */ }
  }));
}

// Fetch the Google Fonts + Adobe Fonts (Typekit) CSS and inline each font file
// as a base64 data URI. This is required because <img src=blob:svg> can't see
// the host document's @font-face rules — without inlining, DM Sans / DM Serif
// Display / Meatball fall back to generic serif/sans-serif when rasterized.
const FONT_CSS_URLS = [
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500&family=DM+Serif+Display&display=swap',
  'https://use.typekit.net/ouu2gxk.css',
];

export async function getEmbeddedFontCss() {
  if (UI.fontCssCache !== null) return UI.fontCssCache;
  try {
    const cssParts = await Promise.all(FONT_CSS_URLS.map(async url => {
      const res = await fetch(url);
      return res.ok ? await res.text() : '';
    }));
    let css = cssParts.join('\n');
    // Google's CSS uses unquoted url()s; Typekit's uses quoted url()s with a
    // format() hint and no file extension — capture both, keyed by format.
    const urlPattern = /url\((['"]?)([^'")]+)\1\)(?:\s*format\((['"]?)([\w-]+)\3\))?/g;
    const matches = new Map();
    for (const m of css.matchAll(urlPattern)) {
      if (!matches.has(m[2])) matches.set(m[2], m[4]);
    }
    const replacements = await Promise.all([...matches].map(async ([url, format]) => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const f = (format || '').toLowerCase();
        const mime = f.includes('woff2') ? 'font/woff2' : f === 'woff' ? 'font/woff'
          : f.includes('opentype') || f.includes('truetype') ? 'font/otf'
          : url.includes('.woff2') ? 'font/woff2' : url.includes('.woff') ? 'font/woff' : 'font/truetype';
        return { url, dataUri: `data:${mime};base64,${btoa(bin)}` };
      } catch (err) { console.warn('Font fetch failed:', url, err); return null; }
    }));
    for (const rep of replacements) {
      if (rep) css = css.split(rep.url).join(rep.dataUri);
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

// Mirrors flags.html's static "Share modal" markup - this page (unlike
// flags-gallery.html) has no static HTML to add it to, same reasoning as
// ensureEmailPrintSheetModal above.
function ensureHsShareModal() {
  if (document.getElementById('hsShareModalOverlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'share-modal-overlay';
  overlay.id = 'hsShareModalOverlay';
  overlay.style.display = 'none';
  overlay.setAttribute('onclick', 'closeHsShareModal(event)');
  overlay.innerHTML = `
    <div class="share-modal">
      <div class="share-modal-header">
        <span class="share-modal-title">Share for review</span>
        <button class="share-modal-close" onclick="closeHsShareModal()" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
      <div class="share-modal-body">
        <p class="share-modal-label">Review link</p>
        <div class="share-link-box">
          <input class="share-link-input" id="hsShareModalLinkInput" readonly>
          <button class="btn sm" onclick="copyHsShareModalLink()">Copy</button>
        </div>
        <p class="share-modal-label" style="margin-top:1.25rem">Notify customer by email</p>
        <input class="share-email-input" id="hsShareModalEmailInput" type="email" placeholder="customer@email.com">
        <div id="hsShareModalNotifyStatus" style="font-size:13px;color:var(--gray-400);min-height:16px;margin-top:6px"></div>
        <button class="btn sm primary" style="width:100%;justify-content:center;margin-top:8px" onclick="notifyHsCustomer()">Send notification</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

// Mints/reuses the share link (same as the old generateHsShareLink), updates
// the persistent sidebar copy box, then opens the modal to actually notify
// the customer - mirrors flags/gallery.js's openShareModal/notifyCustomer
// split so both designers behave the same way.
window.openHsShareModal = async function () {
  const status = document.getElementById('hsShareStatus');
  if (!HS.projectId) { if (status) status.textContent = 'No project loaded.'; return; }
  if (status) status.textContent = 'Saving…';
  try {
    await saveDraftInternal();
    if (status) status.textContent = 'Generating link…';
    if (!HS.shareToken) HS.shareToken = await generateShareToken(HS.projectId);
    const url = `${window.location.origin}/review?token=${HS.shareToken}&tab=hole-signs`;
    const input = document.getElementById('hsShareLinkInput');
    const box   = document.getElementById('hsShareLinkBox');
    if (input) input.value = url;
    if (box)   box.style.display = 'flex';
    if (status) status.textContent = '';
    // Same "insert now rather than wait for a full re-render" reasoning as
    // the review-progress summary just below — this pill only exists in the
    // template once shareUrl is truthy, which it wasn't on the initial render.
    if (status && !document.querySelector('#shareSection .status-pill')) {
      status.insertAdjacentHTML('beforebegin', `<div class="status-pill status-${HS.projectStatus}" style="margin-bottom:8px">${escXml(STATUS_LABEL[HS.projectStatus] || HS.projectStatus)}</div>`);
    }
    // The approval progress summary only appears once a link exists (see
    // renderReviewProgress) — insert it now rather than waiting for the
    // user to leave and revisit this step.
    if (!document.getElementById('hsReviewProgress')) {
      const col = document.querySelector('#panel-3 .hs-design-preview-col');
      const html = renderReviewProgress();
      if (col && html) col.insertAdjacentHTML('afterbegin', html);
    }
    const emailInput = document.getElementById('hsShareModalEmailInput');
    emailInput.value = '';
    loadOrderIntake(HS.projectId).then(intake => { if (intake?.contact_email) emailInput.value = intake.contact_email; }).catch(() => {});
    document.getElementById('hsShareModalLinkInput').value = url;
    document.getElementById('hsShareModalNotifyStatus').textContent = '';
    document.getElementById('hsShareModalOverlay').style.display = 'flex';
  } catch (err) {
    console.error(err);
    if (status) status.textContent = 'Could not generate link.';
  }
};

window.closeHsShareModal = function (e) {
  if (e && e.target !== document.getElementById('hsShareModalOverlay')) return;
  document.getElementById('hsShareModalOverlay').style.display = 'none';
};

window.copyHsShareModalLink = function () {
  const url = document.getElementById('hsShareModalLinkInput').value;
  navigator.clipboard.writeText(url).then(() => {
    const status = document.getElementById('hsShareModalNotifyStatus');
    status.textContent = 'Link copied!';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
};

window.copyHsShareLink = function () {
  const input = document.getElementById('hsShareLinkInput');
  if (!input) return;
  input.select();
  document.execCommand('copy');
  const status = document.getElementById('hsShareStatus');
  if (status) { status.textContent = 'Copied!'; setTimeout(() => { status.textContent = ''; }, 2000); }
};

// Sending the notification is what actually commits to sharing the proof,
// so this is where status moves to "In Review" (proof_sent) - not
// openHsShareModal, which only previews/copies a link and may never be
// followed by an actual send. Mirrors flags/gallery.js's notifyCustomer.
window.notifyHsCustomer = async function () {
  const email = document.getElementById('hsShareModalEmailInput').value.trim();
  const url = document.getElementById('hsShareModalLinkInput').value;
  const status = document.getElementById('hsShareModalNotifyStatus');
  if (!email) { status.textContent = 'Enter an email address.'; return; }
  const btn = document.querySelector('#hsShareModalOverlay .btn.primary');
  if (btn) btn.disabled = true;
  status.textContent = 'Sending…';
  try {
    // admin_send_design_proof only accepts submitted/needs_changes/proof_sent
    // (see 20260913000000_per_design_status_workflow.sql), so a still-draft
    // design (e.g. an admin fast-path project the customer never submitted)
    // needs submit_design_for_review first. Only staff/admin may call either
    // RPC - a customer can still generate/copy a link and notify via this
    // same modal, it just never flips their own design's status for them.
    if (UI.isStaffOrAdmin) {
      if (HS.projectStatus === 'draft') await submitDesignForReview(HS.projectId, 'hole-signs');
      await adminSendDesignProof(HS.projectId, 'hole-signs');
    }
    const intake = await loadOrderIntake(HS.projectId).catch(() => null);
    await sendProofReady({
      contactName: intake?.contact_name || '',
      contactEmail: email,
      eventName: intake?.event_name || 'your event',
      reviewUrl: url,
    });
    if (UI.isStaffOrAdmin) {
      HS.projectStatus = 'proof_sent';
      const pill = document.querySelector('#shareSection .status-pill');
      if (pill) { pill.className = `status-pill status-${HS.projectStatus}`; pill.textContent = STATUS_LABEL[HS.projectStatus] || HS.projectStatus; }
    }
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

// Re-fetches just the saved variations (not the full app.js init() — that
// re-runs one-time legacy-data migrations, e.g. pushing newly-generated text
// layers for an old banner-caption shape, that aren't safe to redo on every
// click) and repaints this Review panel, for the same reason as flags'
// refreshGallery (flags/gallery.js): this page reflects whatever HS held at
// last load/save, with nothing pushing in a change made from another tab.
window.refreshHsGallery = async function () {
  // Look #hsShareStatus up AFTER renderGallery() below, not before — it
  // regenerates the sidebar's innerHTML wholesale, so a reference grabbed
  // beforehand would be a detached node the reviewer never sees updated.
  try {
    const hsCfg = await loadHoleSignConfig(HS.projectId);
    if (hsCfg?.variations?.length) {
      HS.variations = hsCfg.variations;
      if (!HS.variations.some(v => v.id === HS.activeVarId)) HS.activeVarId = HS.variations[0]?.id || null;
    }
    renderGallery();
    const status = document.getElementById('hsShareStatus');
    if (status) { status.textContent = 'Updated with the latest design.'; setTimeout(() => { status.textContent = ''; }, 2000); }
  } catch (err) {
    console.error('Could not refresh hole sign gallery', err);
    const status = document.getElementById('hsShareStatus');
    if (status) status.textContent = 'Could not refresh — try again.';
  }
};

// saveDraftInternal / window.saveDraft moved to ./draft.js so steps 1-2
// don't have to load pdf-lib/jszip just to autosave.
