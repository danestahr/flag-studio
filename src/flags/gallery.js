import '../style.css';
import '../order.css';
import '../icons.js';
import { requireAuth, isStaffOrAdmin } from '../auth.js';

const session = await requireAuth();

import { S, navigateTo } from '../state.js';
import { FLAGS } from '../data.js';
import { renderInto, withMasterText } from '../render.js';
import { loadAllFlags } from '../svgLoader.js';
import {
  generateShareToken, getFeedback, supabase,
  loadOrderIntake, loadEventName, sendProofReady, sendPrestigeOrder,
  submitDesignForReview, adminSendDesignProof,
} from '../supabase.js';
import {
  getVarFlag, getVarColors, getVarGsTagOpts, sameSidesOf,
  rasterizeSvg, pngBlobToPdfBlob, buildFlagsPrintZip, hydrateFlagStateForProject,
} from './print-export.js';
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

// ── Gallery ────────────────────────────────────────────────

function reviewStatusOf(v) {
  const fb = S.feedback?.find(f => f.variation_id === v.id);
  if (fb?.status === 'approved') return { cls: 'approved', label: 'Approved' };
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
    const backMirror = sameSidesOf(v);
    const backLogos = backMirror ? frontLogos : (v.backLogos || v.backAssignment || []);
    const backTextLayers = backMirror ? (v.textLayers || []) : (v.backTextLayers || []);
    const editHref = `${editBase}#var-${encodeURIComponent(v.id)}`;
    const status = reviewStatusOf(v);
    card.innerHTML = `
      <div class="var-card-header">
        <span class="var-card-name">${esc(v.name)}</span>
        <div class="var-card-header-meta">
          <span class="var-status-tile ${status.cls}">${status.label}</span>
          <div class="var-card-actions">
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

    const frontEl = document.getElementById(`vcf-f-${i}`);
    if (frontEl) renderInto(frontEl, frontLogos, 'front', false, getVarFlag(v), getVarColors(v), withMasterText(v), getVarGsTagOpts(v), S.imageLayers || []);
    const backEl = document.getElementById(`vcf-b-${i}`);
    if (backEl) renderInto(backEl, backLogos, 'back', backMirror, getVarFlag(v), getVarColors(v), [...(S.textLayers || []), ...backTextLayers], getVarGsTagOpts(v), S.imageLayers || []);
  });
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

window.sendToPrestige = async function () {
  if (!S.variations.length) { alert('No variations to export.'); return; }
  if (!S.projectId) { alert('Save your project first.'); return; }
  const btn = document.querySelector('[onclick="sendToPrestige()"]');
  const origLabel = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const status = document.getElementById('expPrintStatus');
  const setStatus = msg => { if (status) status.textContent = msg; };
  try {
    const { zipBlob } = await buildFlagsPrintZip(setStatus);
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
    const { blob, vbW, vbH } = await rasterizeSvg(faceLogos, 'front', false, withMasterText(v), getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), S.imageLayers || []);
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
      const { blob, vbW, vbH } = await rasterizeSvg(v.logos || v.assignment || [], 'front', false, withMasterText(v), getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), S.imageLayers || []);
      dl(URL.createObjectURL(await pngBlobToPdfBlob(blob, vbW, vbH)), slug(v.name) + '.pdf');
      await new Promise(r => setTimeout(r, 400));
      if (!sameSidesOf(v)) {
        const { blob: blobB, vbW: bW, vbH: bH } = await rasterizeSvg(v.backLogos || v.backAssignment || [], 'back', false, [...(S.textLayers || []), ...(v.backTextLayers || [])], getVarFlag(v), getVarColors(v), getVarGsTagOpts(v), S.imageLayers || []);
        dl(URL.createObjectURL(await pngBlobToPdfBlob(blobB, bW, bH)), slug(v.name) + '-back.pdf');
        await new Promise(r => setTimeout(r, 400));
      }
    } catch (err) { console.error('PDF export failed for', v.name, err); }
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
    customerSection: true,
    logosTile: true,
    projectId: p,
    completedSteps: S.projectStatus === 'sent_to_print' ? [3] : [],
    steps: [
      {
        id: 'navDesign', label: 'Design', desc: 'Style, colors & logos',
        ...(isLockedForCustomer ? {} : { onClick: () => { navigateTo('flags' + (p ? '?project=' + p : '')); } }),
      },
      {
        id: 'navVariations', label: 'Variations', desc: 'Build combinations',
        ...(isLockedForCustomer ? {} : { onClick: () => { if (p) navigateTo('flags-variations?project=' + p); } }),
      },
      { id: 'navGallery', label: 'Review', desc: 'Review & export' },
    ],
  });
  document.getElementById('sidebarPanelHeader').innerHTML = `
    <div class="p1-header hs-panel-header">
      <div>
        <div class="ptitle">Review</div>
        <div class="psub">Review all variations and export.</div>
      </div>
      <div class="p1-header-actions"></div>
    </div>`;
  const logosTile = document.getElementById('sidebarLogosTile');
  if (logosTile) logosTile.innerHTML = `
    <div class="hs-design-controls-body">
      <div class="share-section" id="shareSection">
        <div class="rc-title">Share for review</div>
        ${S.shareToken ? `<div class="status-pill status-${S.projectStatus}" style="margin-bottom:8px">${esc(STATUS_LABEL[S.projectStatus] || S.projectStatus)}</div>` : ''}
        <div id="shareStatus" style="font-size:13px;color:var(--gray-400);min-height:16px"></div>
        <button class="btn sm primary" style="width:100%;justify-content:center" onclick="openShareModal()">Share for review <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        <div class="share-link-box" id="shareLinkBox" style="display:${S.shareToken ? 'flex' : 'none'}">
          <input class="share-link-input" id="sidebarShareLinkInput" readonly value="${S.shareToken ? esc(`${window.location.origin}/review?token=${S.shareToken}&tab=flags`) : ''}">
          <button class="btn sm" onclick="copySidebarShareLink()">Copy</button>
          <button class="btn sm" onclick="window.refreshGallery()" title="Refresh with the latest saved design"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Update</button>
        </div>
      </div>
      <div class="share-section">
        <div class="rc-title">Print files</div>
        <button class="btn sm primary" style="width:100%;justify-content:center" onclick="expAllPDF()"><i class="fa-solid fa-download" aria-hidden="true"></i> Download all as PDF</button>
        <button class="btn sm primary" style="width:100%;justify-content:center" id="expPrintPdfBtn" onclick="downloadForPrint()"><i class="fa-solid fa-download" aria-hidden="true"></i> Print download (PDF zip)</button>
        <div id="expPrintStatus" style="font-size:12px;color:var(--gray-600);min-height:14px"></div>
        <button class="btn sm" style="width:100%;justify-content:center" onclick="sendToPrestige()"><i class="fa-solid fa-envelope" aria-hidden="true"></i> Send to Prestige Flag</button>
      </div>
    </div>`;
  if (logosTile) fitSidePanel('sidebarLogosTile');
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

window.refreshGallery = async function () {
  // Look the status element up AFTER loadAndRenderGallery() below, not
  // before — it re-renders the sidebar via renderGallerySidebar(), replacing
  // #shareStatus's whole parent's innerHTML wholesale, so a reference grabbed
  // beforehand would be a detached node the reviewer never sees updated.
  try {
    await loadAndRenderGallery();
    const statusEl = document.getElementById('shareStatus');
    if (statusEl) {
      statusEl.textContent = 'Updated with the latest design.';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    }
  } catch (err) {
    console.error('Could not refresh gallery', err);
    const statusEl = document.getElementById('shareStatus');
    if (statusEl) statusEl.textContent = 'Could not refresh — try again.';
  }
};
