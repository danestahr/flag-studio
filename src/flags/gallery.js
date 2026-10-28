import '../style.css';
import '../order.css';
import '../icons.js';
import { requireAuth, isStaffOrAdmin } from '../auth.js';

const session = await requireAuth();

import { S, navigateTo } from '../state.js';
import { FLAGS } from '../data.js';
import { renderInto, withMasterText, tplImages, printOpts, backSpecOf } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  generateShareToken, getFeedback, supabase,
  loadOrderIntake, loadEventName, sendProofReady, sendPrestigeOrder, loadLatestPrestigeOrder, currentFlagDesignHash, onDesignChanged,
  submitDesignForReview, adminSendDesignProof, saveFlagVariationQty,
} from '../supabase.js';
import {
  getVarFlag, getVarColors, getVarGsTagOpts, sameSidesOf,
  buildFlagSheetsPdfBlob, buildFlagsPrintZip, hydrateFlagStateForProject,
} from './print-export.js';
import { confirmPrestigeSend } from '../prestige-send-modal.js';
import { esc, dl, slug, sanitizeFilename } from '../dom-utils.js';
import { STATUS_LABEL } from '../status-labels.js';
import { renderSidebar, setSidebarProjectName } from '../sidebar.js';
import { fitSidePanel } from '../canvas-panel.js';

let feedbackChannel = null;
// True once we know the viewer is a non-admin customer and the project is
// past draft/needs_changes - Gallery & export stays viewable, but every path
// back into the editor (edit-variation links, sidebar nav, the Variations
// back button) is hidden. UI-convenience only, same as everywhere else in
// this app - RLS is the real boundary and already rejects the writes.
let isLockedForCustomer = false;
// True once we know the viewer is staff/admin - gates the status-transition
// RPCs in notifyCustomer below, which only staff/admin are permitted to call
// (admin_send_design_proof, per 20260913000000_per_design_status_workflow.sql).
// A customer can still generate/copy a link and notify via this same modal;
// it just never flips their own design's status to "In Review" for them.
let isAdmin = false;
// Declared up here, not beside publishFlags: the page's top-level await below runs
// renderGallerySidebar() -> refreshPublishState() before the rest of the module
// has evaluated, and a later `let` would still be in its temporal dead zone.
let _publishing = false;
// Whether the project's Prestige order has already been emailed. An update then
// changes files Prestige may already have, so it's confirmed first (no new email
// is sent; an open download page just shows its "newer version" banner).
let _prestigeSent = false;
const SENT_UPDATE_WARNING = 'This Prestige link was already emailed. Update the files behind it? Prestige will see a "newer version" banner on the page, but no new email is sent.';

// ── Gallery ────────────────────────────────────────────────

function reviewStatusOf(v) {
  const fb = S.feedback?.find(f => f.variation_id === v.id);
  if (fb?.status === 'approved') return { cls: 'approved', label: 'Approved' };
  if (fb?.status === 'rejected') return { cls: 'rejected', label: 'Not wanted' };
  if (fb?.status === 'needs_edits' && !fb?.resolved) return { cls: 'needs-edits', label: 'Needs edits' };
  return { cls: 'not-reviewed', label: 'Not reviewed' };
}

function renderVarList() {
  const el = document.getElementById('varList');
  if (!el) return;
  el.innerHTML = '';
  const p = new URLSearchParams(window.location.search).get('project');
  const editBase = `flags-variations${p ? '?project=' + encodeURIComponent(p) : ''}`;
  const editIcon = `<i class="fa-solid fa-pen" aria-hidden="true"></i>`;
  const pdfIcon = `<i class="fa-solid fa-file-pdf" aria-hidden="true"></i>`;

  S.variations.forEach((v, i) => {
    const card = document.createElement('div');
    card.className = 'var-card';
    card.dataset.varIdx = i;
    card.id = `var-card-${i}`;
    const frontLogos = v.logos || v.assignment || [];
    const back = backSpecOf(v);
    const editHref = `${editBase}#var-${encodeURIComponent(v.id)}`;
    const status = reviewStatusOf(v);
    card.innerHTML = `
      <div class="var-card-header">
        <span class="var-card-name">${esc(v.name)}</span>
        <div class="var-card-header-meta">
          <span class="var-status-tile ${status.cls}">${status.label}</span>
          <div class="var-card-actions">
            ${isLockedForCustomer
              ? `<span class="var-card-qty" title="Quantity">&times; ${parseInt(v.qty, 10) || 1}</span>`
              : `<div class="qty-stepper var-card-qty-stepper">
                  <button class="qty-btn" type="button" data-qty-step="-1" aria-label="Decrease quantity"><i class="fa-solid fa-minus" aria-hidden="true"></i></button>
                  <input class="var-qty-input" type="number" min="1" step="1" value="${parseInt(v.qty, 10) || 1}" aria-label="Quantity">
                  <button class="qty-btn" type="button" data-qty-step="1" aria-label="Increase quantity"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
                </div>`}
            ${isLockedForCustomer ? '' : `<a href="${editHref}" class="btn sm var-card-edit" title="Edit variation">${editIcon} Edit</a>`}
            <button class="btn sm var-card-pdf" title="Download PDF" onclick="event.stopPropagation();downloadVariationPdf(${i})">${pdfIcon} PDF</button>
          </div>
        </div>
      </div>
      <div class="var-card-flags">
        <div><div class="var-card-face-label">Front</div><div class="var-card-flag" id="vcf-f-${i}"></div></div>
        <div><div class="var-card-face-label">Back</div><div class="var-card-flag" id="vcf-b-${i}"></div></div>
      </div>`;
    el.appendChild(card);
    wireGalleryQty(card, v);

    const frontEl = document.getElementById(`vcf-f-${i}`);
    if (frontEl) renderInto(frontEl, frontLogos, 'front', false, getVarFlag(v), getVarColors(v), withMasterText(v), getVarGsTagOpts(v), tplImages(v), printOpts(getVarFlag(v)));
    const backEl = document.getElementById(`vcf-b-${i}`);
    if (backEl) renderInto(backEl, back.logos, 'back', back.mirrored, getVarFlag(v), getVarColors(v), back.textLayers, getVarGsTagOpts(v), back.imageLayers, printOpts(getVarFlag(v)));
  });
}

async function commitGalleryQty(v, raw, input) {
  const prev = parseInt(v.qty, 10) || 1;
  const next = Math.max(1, parseInt(raw, 10) || 1);
  input.value = next;
  if (next === prev) return;
  v.qty = next;
  const total = S.variations.reduce((sum, x) => sum + (parseInt(x.qty, 10) || 1), 0);
  const n = S.variations.length;
  const stats = document.querySelector('.p1-header-stats');
  if (stats) stats.innerHTML = `${n} variation${n === 1 ? '' : 's'} &middot; ${total} flag${total === 1 ? '' : 's'} total`;
  try {
    await saveFlagVariationQty(S.projectId, v.id, next);
    refreshPublishState();
  } catch (e) {
    console.warn('Could not save quantity:', e);
    v.qty = prev;
    input.value = prev;
    alert('Could not save the quantity. Please try again.');
  }
}

function wireGalleryQty(card, v) {
  const wrap = card.querySelector('.var-card-qty-stepper');
  if (!wrap) return;
  const input = wrap.querySelector('input');
  wrap.querySelectorAll('[data-qty-step]').forEach(btn => btn.addEventListener('click', () =>
    commitGalleryQty(v, (parseInt(input.value, 10) || 1) + parseInt(btn.dataset.qtyStep, 10), input)));
  input.addEventListener('change', () => commitGalleryQty(v, input.value, input));
}

function setupGallery() {
  if (S.shareToken) {
    const url = `${window.location.origin}/review?token=${S.shareToken}&tab=flags`;
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
// Rasterization/print-zip building now lives in ./print-export.js so
// project.js can build the same print PDFs without loading this page's DOM
// or state hydration — see that module for rasterizeSvg/pngBlobToPdfBlob/
// buildFlagsPrintZip.

// Link to the permanent Prestige download page for the latest send, so staff can
// inspect exactly what Tom sees. Row is only readable by staff/owner via RLS.
async function loadPrestigeLink() {
  if (!document.getElementById('prestigeLinkBox') || !S.projectId) return;
  try {
    const order = await loadLatestPrestigeOrder(S.projectId);
    // Looked up after the await - the sidebar can re-render while it runs.
    const box = document.getElementById('prestigeLinkBox');
    const input = document.getElementById('prestigeLinkInput');
    if (!order || !box || !input) return;
    input.value = `${window.location.origin}/prestige-download?id=${order.id}`;
    box.style.display = 'flex';
    _prestigeSent = !!order.sent_at;
    const send = document.getElementById('prestigeSendBtn');
    if (send && !send.disabled) send.innerHTML = `${_prestigeSent ? 'Resend to Prestige Flag' : 'Send to Prestige Flag'} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>`;
    const note = document.getElementById('prestigeStatus');
    if (note && !note.textContent && _prestigeSent) {
      note.textContent = `Emailed ${new Date(order.sent_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    }
  } catch (err) {
    console.error('Failed to load Prestige order', err);
  }
}

// Builds the zip from the latest saved design and (re)writes the project's
// Prestige order in place - same link, new files, no email. Shared by the
// link's Update button and "Publish flags".
async function rebuildPrestigePage(setStatus) {
  // Hash first: an edit landing mid-build then reads as out of date (one extra
  // publish) rather than being recorded as already included.
  const designHash = await currentFlagDesignHash(S.projectId);
  const { zipBlob } = await buildFlagsPrintZip(setStatus);
  setStatus('Creating download page…');
  return sendPrestigeOrder(S.projectId, S.projectName || 'Flag Order', zipBlob, { prepareOnly: true, designHash });
}

window.copyPrestigeLink = function () {
  const input = document.getElementById('prestigeLinkInput');
  if (!input?.value) return;
  navigator.clipboard.writeText(input.value).then(() => {
    const status = document.getElementById('prestigeStatus');
    if (status) { status.textContent = 'Link copied!'; setTimeout(() => { status.textContent = ''; }, 2000); }
  });
};

// The Prestige counterpart of the review link's Update: rebuild the files from
// the latest saved design into the same order, so the link doesn't change.
window.updatePrestigeLink = async function () {
  if (!S.variations.length || !S.projectId || _publishing) return;
  if (_prestigeSent && !window.confirm(SENT_UPDATE_WARNING)) return;
  const btn = document.getElementById('prestigeLinkUpdateBtn');
  const origLabel = btn?.innerHTML;
  const setStatus = msg => { const el = document.getElementById('prestigeStatus'); if (el) el.textContent = msg; };
  if (btn) btn.disabled = true;
  try {
    await rebuildPrestigePage(setStatus);
    await loadPrestigeLink();
    setStatus('Updated with the latest design.');
    setTimeout(() => setStatus(''), 2000);
  } catch (err) {
    console.error('updatePrestigeLink failed', err);
    setStatus('Could not update — try again.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
    refreshPublishState();
  }
};

window.sendToPrestige = async function () {
  if (!S.variations.length) { alert('No variations to export.'); return; }
  if (!S.projectId) { alert('Save your project first.'); return; }
  if (!(await confirmPrestigeSend())) return;
  const btn = document.getElementById('prestigeSendBtn');
  const origLabel = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const setStatus = msg => { const el = document.getElementById('prestigeStatus'); if (el) el.textContent = msg; };
  try {
    const designHash = await currentFlagDesignHash(S.projectId);
    const { zipBlob } = await buildFlagsPrintZip(setStatus);
    setStatus('Sending to Prestige…');
    await sendPrestigeOrder(S.projectId, S.projectName || 'Flag Order', zipBlob, { designHash });
    setStatus('✓ Sent to Prestige Flag!');
    loadPrestigeLink();
    setTimeout(() => setStatus(''), 5000);
  } catch (err) {
    console.error('sendToPrestige failed', err);
    setStatus('Failed: ' + (err.message || err));
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
  }
};

// Single-variation PDF (front on top, back below) — lives on each gallery tile.
window.downloadVariationPdf = async function (idx) {
  const v = S.variations[idx];
  if (!v) return;
  const btn = document.querySelector(`#var-card-${idx} .var-card-pdf`);
  if (btn) btn.disabled = true;
  try {
    dl(URL.createObjectURL(await buildFlagSheetsPdfBlob([v])), (slug(v.name) || 'variation-' + (idx + 1)) + '.pdf');
  } catch (err) {
    console.error('PDF export failed', err);
    alert('PDF export failed.');
  } finally {
    if (btn) btn.disabled = false;
  }
};

// Bulk export — one PDF with a sheet per variation.
window.expAllPDF = async function () {
  if (!S.variations.length) { alert('No variations to export.'); return; }
  try {
    dl(URL.createObjectURL(await buildFlagSheetsPdfBlob()), `Flags_${sanitizeFilename(S.projectName || 'Export')}.pdf`);
  } catch (err) {
    console.error('PDF export failed', err);
    alert('PDF export failed.');
  }
};

window.downloadForPrint = async function () {
  if (!S.variations.length) { alert('No variations to export.'); return; }
  const btn = document.getElementById('expPrintPdfBtn');
  const status = document.getElementById('expPrintStatus');
  const originalLabel = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const setStatus = msg => { if (status) status.textContent = msg; };
  try {
    const { zipBlob } = await buildFlagsPrintZip(setStatus);
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
    const url = `${window.location.origin}/review?token=${S.shareToken}&tab=flags`;
    document.getElementById('shareLinkInput').value = url;
    refreshShareLinkBox();
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

// Keeps the persistent link box in the sidebar's "Share for review" section
// (separate from the modal's own #shareLinkInput) in sync once a token
// exists, so staff can copy the link again later without reopening the modal.
function refreshShareLinkBox() {
  const box = document.getElementById('shareLinkBox');
  const input = document.getElementById('sidebarShareLinkInput');
  if (!box || !input || !S.shareToken) return;
  input.value = `${window.location.origin}/review?token=${S.shareToken}&tab=flags`;
  box.style.display = 'flex';
  // The status pill only exists in the sidebar template once S.shareToken
  // was already truthy at render time - insert it now if this is the first
  // time a token's been generated this session, same reasoning as the box above.
  const shareStatusEl = document.getElementById('shareStatus');
  if (shareStatusEl && !document.querySelector('#shareSection .status-pill')) {
    shareStatusEl.insertAdjacentHTML('beforebegin', `<div class="status-pill status-${S.projectStatus}" style="margin-bottom:8px">${esc(STATUS_LABEL[S.projectStatus] || S.projectStatus)}</div>`);
  }
}

window.copySidebarShareLink = function () {
  const input = document.getElementById('sidebarShareLinkInput');
  if (!input?.value) return;
  navigator.clipboard.writeText(input.value).then(() => {
    const status = document.getElementById('shareStatus');
    if (status) { status.textContent = 'Link copied!'; setTimeout(() => { status.textContent = ''; }, 2000); }
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
    // Staff sending the notification is what actually commits to sharing the
    // proof, so this is where status moves to "In Review" (proof_sent) - not
    // openShareModal, which only previews/copies a link and may never be
    // followed by an actual send. admin_send_design_proof only accepts
    // submitted/needs_changes/proof_sent (see
    // 20260913000000_per_design_status_workflow.sql), so a still-draft design
    // (e.g. an admin fast-path project the customer never submitted) needs
    // submit_design_for_review first.
    if (isAdmin) {
      if (S.projectStatus === 'draft') await submitDesignForReview(S.projectId, 'flags');
      await adminSendDesignProof(S.projectId, 'flags');
    }
    const intake = await loadOrderIntake(S.projectId).catch(() => null);
    await sendProofReady({
      contactName: intake?.contact_name || '',
      contactEmail: email,
      eventName: intake?.event_name || 'your event',
      reviewUrl: url,
    });
    if (isAdmin) {
      S.projectStatus = 'proof_sent';
      const pill = document.querySelector('#shareSection .status-pill');
      if (pill) { pill.className = `status-pill status-${S.projectStatus}`; pill.textContent = STATUS_LABEL[S.projectStatus] || S.projectStatus; }
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

// ── Init ──────────────────────────────────────────────────

// Sidebar renders once we know whether the viewer is locked out of the
// editor (see isLockedForCustomer above) - unlike the other flags pages,
// that isn't known until the project itself has loaded, so this waits
// rather than rendering an initially-clickable nav that would immediately
// bounce a locked customer back here.
function renderGallerySidebar() {
  const p = new URLSearchParams(window.location.search).get('project');
  renderSidebar(document.getElementById('sidebar'), {
    projectType: 'Tournament Flags',
    activeStep: 3,
    collapsible: false,
    customerSection: true,
    logosTile: true,
    projectId: p,
    completedSteps: S.projectStatus === 'sent_to_print' ? [3] : [],
    steps: [
      {
        id: 'navDesign', label: 'Template', desc: 'Style, colors & logos',
        ...(isLockedForCustomer ? {} : { onClick: () => { navigateTo('flags' + (p ? '?project=' + p : '')); } }),
      },
      {
        id: 'navVariations', label: 'Flags', desc: 'Build combinations',
        ...(isLockedForCustomer ? {} : { onClick: () => { if (p) navigateTo('flags-variations?project=' + p); } }),
      },
      { id: 'navGallery', label: 'Review', desc: 'Review & export' },
    ],
  });
  const galleryVarCount = S.variations.length;
  const galleryFlagQty = S.variations.reduce((sum, v) => sum + (parseInt(v.qty, 10) || 1), 0);
  document.getElementById('sidebarPanelHeader').innerHTML = `
    <div class="p1-header hs-panel-header">
      <div>
        <div class="ptitle">Review</div>
        <div class="p1-header-stats">${galleryVarCount} variation${galleryVarCount === 1 ? '' : 's'} &middot; ${galleryFlagQty} flag${galleryFlagQty === 1 ? '' : 's'} total</div>
      </div>
      <div class="p1-header-actions"></div>
    </div>`;
  const logosTile = document.getElementById('sidebarLogosTile');
  if (logosTile) logosTile.innerHTML = `
    <div class="hs-design-controls-body">
      ${isAdmin ? `
      <div class="share-section" id="publishSection" style="display:none">
        <div id="publishNotice" style="font-size:12px;line-height:1.4;color:#b45309"></div>
        <button class="btn sm primary" id="publishFlagsBtn" style="width:100%;justify-content:center" onclick="publishFlags()"><i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i> Publish flags</button>
        <div id="publishStatus" style="font-size:12px;color:var(--gray-600)"></div>
      </div>` : ''}
      ${S.shareToken || isAdmin ? `
      <div class="share-section" id="statusSection">
        <div class="rc-title">Status</div>
        <div class="status-pill status-${S.projectStatus}" style="align-self:flex-start">${esc(STATUS_LABEL[S.projectStatus] || S.projectStatus)}</div>
      </div>` : ''}
      <div class="share-section" id="shareSection">
        <div class="rc-title">Share for review</div>
        <div id="shareStatus" style="font-size:13px;color:var(--gray-400);min-height:16px"></div>
        <button class="btn sm primary" style="width:100%;justify-content:center" onclick="openShareModal()">Share for review <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        <div class="share-link-box" id="shareLinkBox" style="display:${S.shareToken ? 'flex' : 'none'}">
          <input class="share-link-input" id="sidebarShareLinkInput" readonly value="${S.shareToken ? esc(`${window.location.origin}/review?token=${S.shareToken}&tab=flags`) : ''}">
          <button class="btn sm" onclick="copySidebarShareLink()">Copy</button>
          <button class="btn sm" onclick="window.refreshGallery()" title="Refresh with the latest saved design"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Update</button>
        </div>
      </div>
      ${isAdmin ? `
      <div class="share-section" id="prestigeSection">
        <div class="rc-title">Send to Prestige</div>
        <div id="prestigeStatus" style="font-size:13px;color:var(--gray-400)"></div>
        <button class="btn sm primary" id="prestigeSendBtn" style="width:100%;justify-content:center" onclick="sendToPrestige()">Send to Prestige Flag <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        <div class="share-link-box" id="prestigeLinkBox" style="display:none">
          <input class="share-link-input" id="prestigeLinkInput" readonly>
          <button class="btn sm" onclick="copyPrestigeLink()">Copy</button>
          <button class="btn sm" id="prestigeLinkUpdateBtn" onclick="updatePrestigeLink()" title="Rebuild the files behind this link from the latest saved design"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Update</button>
        </div>
      </div>` : ''}
      <div class="share-section">
        <div class="rc-title">Downloads</div>
        <button class="btn sm" style="width:100%;justify-content:center" onclick="expAllPDF()"><i class="fa-solid fa-download" aria-hidden="true"></i> Download all as PDF</button>
        <button class="btn sm" style="width:100%;justify-content:center" id="expPrintPdfBtn" onclick="downloadForPrint()"><i class="fa-solid fa-download" aria-hidden="true"></i> Print download (PDF zip)</button>
        <div id="expPrintStatus" style="font-size:12px;color:var(--gray-600)"></div>
      </div>
    </div>`;
  if (logosTile) {
    loadPrestigeLink();
    refreshPublishState(); // after the tile renders: the Publish button lives in it
    fitSidePanel('sidebarLogosTile');
  }
  if (isLockedForCustomer) {
    ['navDesign', 'navVariations'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.cssText += 'opacity:.45;cursor:default';
    });
  }
}

const _urlProject = new URLSearchParams(window.location.search).get('project');
if (!_urlProject) { window.location.href = '/'; }

await loadAllFlags(FLAGS);

// Fetches the project/logos/flag_config fresh from Supabase into `S` and
// repaints the sidebar + gallery grid — the page's own load path, and also
// what the sidebar's "Update" button (next to its share-link Copy button)
// re-runs on demand. This page has no realtime subscription of its own
// (unlike review.html), so without an explicit re-run it only ever reflects
// whatever was loaded at initial page load — most relevant if variations
// were changed in another tab (or by someone else) after this one opened.
async function loadAndRenderGallery() {
  await hydrateFlagStateForProject(_urlProject);
  setSidebarProjectName(S.projectName, S.projectId);

  isAdmin = await isStaffOrAdmin(session);
  isLockedForCustomer = !isAdmin && !['draft', 'needs_changes'].includes(S.projectStatus);
  renderGallerySidebar();

  setupGallery();
}

try {
  await loadAndRenderGallery();
} catch (err) {
  console.error('Could not load project', err);
}

// Publish is enabled only when the saved design differs from what was last
// published - i.e. from the design hash recorded on the project's Prestige order
// (the review link always shows the live design, so the order is the marker).
// No order yet means no links to refresh, so Publish stays hidden; an order with no
// hash (built before hashes existed) is unknown, so it's treated as out of date.
// The notice above the button says so in plain words.
async function refreshPublishState() {
  if (!document.getElementById('publishFlagsBtn') || _publishing) return;
  try {
    const [order, hash] = await Promise.all([
      loadLatestPrestigeOrder(S.projectId),
      currentFlagDesignHash(S.projectId),
    ]);
    // Looked up AFTER the awaits: the sidebar can re-render while they run,
    // which replaces the section - updating references grabbed earlier would
    // hit detached nodes and leave the live one stuck in its initial state.
    const section = document.getElementById('publishSection');
    const btn = document.getElementById('publishFlagsBtn');
    const notice = document.getElementById('publishNotice');
    if (!section || !btn) return;
    _prestigeSent = !!order?.sent_at;
    // Publish only refreshes links that already exist - it never creates one - so
    // with no Prestige order there's nothing to compare against or update (the
    // review link has no stale marker of its own; it shows the live design).
    const outOfDate = !!S.variations.length && !!order && order.design_hash !== hash;
    // The section only exists while there's something to publish - plus however
    // long the "Published." confirmation is still on screen after a publish.
    const hasMessage = !!document.getElementById('publishStatus')?.textContent;
    section.style.display = outOfDate || hasMessage ? '' : 'none';
    notice.style.display = btn.style.display = outOfDate ? '' : 'none';
    notice.innerHTML = `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${S.shareToken
      ? 'The review link and print files don\u2019t include your latest changes. Publish to update both.'
      : 'The print files don\u2019t include your latest changes. Publish to update them.'}`;
    btn.disabled = !outOfDate;
  } catch (err) {
    console.error('Could not check publish state', err);
  }
}

// Edits happen on other pages/tabs (contact info, template, flags); re-check when
// this tab comes back into view.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshPublishState(); });

// ...and react the moment another tab saves the template, flags or contact info
// (see notifyDesignChanged in supabase.js). Debounced: autosave can save in bursts.
let _designChangedTimer = null;
onDesignChanged(changedId => {
  if (changedId !== S.projectId) return;
  clearTimeout(_designChangedTimer);
  _designChangedTimer = setTimeout(refreshPublishState, 400);
});

// Brings both outputs in line with the latest saved design: the print download
// (Prestige page, rebuilt in place) first - it's the heavy, failure-prone step,
// so the review link isn't touched if it fails - then the review link via the
// same path as the sidebar's Update button. Sending/print status handling is
// deliberately not part of this yet.
window.publishFlags = async function () {
  if (_publishing || !S.variations.length) return;
  if (_prestigeSent && !window.confirm(SENT_UPDATE_WARNING)) return;
  _publishing = true;
  const btn = document.getElementById('publishFlagsBtn');
  const origLabel = btn?.innerHTML;
  // Looked up per call: refreshGallery() re-renders the sidebar.
  const setStatus = msg => { const el = document.getElementById('publishStatus'); if (el) el.textContent = msg; };
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Publishing…';
  }
  try {
    // Only update what exists; Publish never creates a link.
    if (await loadLatestPrestigeOrder(S.projectId)) await rebuildPrestigePage(setStatus);
    setStatus('Updating review link…');
    const reviewOk = await window.refreshGallery(); // re-renders the sidebar
    await loadPrestigeLink();
    setStatus(reviewOk
      ? '✓ Published.'
      : 'Print files updated, but the review link could not be refreshed — try its Update button.');
    setTimeout(() => { setStatus(''); refreshPublishState(); }, reviewOk ? 4000 : 8000);
  } catch (err) {
    console.error('publishFlags failed', err);
    setStatus('Publish failed: ' + (err.message || err));
    if (btn) btn.innerHTML = origLabel;
  } finally {
    _publishing = false;
    refreshPublishState();
  }
};

window.refreshGallery = async function () {
  // Look the status element up AFTER loadAndRenderGallery() below, not
  // before — it re-renders the sidebar via renderGallerySidebar(), replacing
  // #shareStatus's whole parent's innerHTML wholesale, so a reference grabbed
  // beforehand would be a detached node the reviewer never sees updated.
  try {
    // For staff, Update is the same as re-sending the proof: it puts the
    // design (back) into review (proof_sent) so the customer's link reflects
    // the latest edits and they can act on it again. approved/sent_to_print
    // designs are left alone — the RPC doesn't allow moving those backward.
    if (isAdmin && S.shareToken && ['draft', 'submitted', 'needs_changes', 'proof_sent'].includes(S.projectStatus)) {
      if (S.projectStatus === 'draft') await submitDesignForReview(S.projectId, 'flags');
      await adminSendDesignProof(S.projectId, 'flags');
    }
    await loadAndRenderGallery();
    const statusEl = document.getElementById('shareStatus');
    if (statusEl) {
      statusEl.textContent = 'Updated with the latest design.';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    }
    return true;
  } catch (err) {
    console.error('Could not refresh gallery', err);
    const statusEl = document.getElementById('shareStatus');
    if (statusEl) statusEl.textContent = 'Could not refresh — try again.';
    return false;
  }
};
