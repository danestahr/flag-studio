import './icons.js';
import { S, findLogo } from './state.js';
import { FLAGS } from './data.js';
import { HS_DEFAULT_TEMPLATES } from './hole-sign-data.js';
import { getFlag, renderInto, preloadLogoAspects, withMasterText, normaliseLogos, resolveColors } from './render.js';
import { loadAllFlags } from './svgLoader.js';
import { getProjectByToken, loadLogosForProject, submitFeedback, getFeedback, supabase, createReviewClient, clientApproveDesignProof, clientRejectDesignProof, sendReviewDecision, uploadFeedbackLogo, loadOrderIntake } from './supabase.js';
import { renderHoleSignInto } from './hole-sign-render.js';
import { esc } from './dom-utils.js';

const root = document.getElementById('reviewRoot');
const localFeedback = {};    // flags: { [variation_id]: { status, note, resolved } }
const localHsFeedback = {};  // hole signs: same
const submittedFlags = new Set();   // variation_ids loaded from DB (already submitted)
const submittedHs    = new Set();
let previousReviewerName = '';
let previousReviewerEmail = '';
let previousGeneralNote = '';
let hsState = null;
let hsVariations = [];
let projectId = null;
let projectName = null;
let reviewToken = null;
let reviewClient = null;
let configChannel = null;
let currentProject = null;
// 'flags' | 'hole-signs' | null (null = not yet decided; renderPage() picks a
// default once it knows which product types this project actually has).
// Seeded from the ?tab= URL param so a gallery's "share for review" link can
// deep-link a reviewer straight to the relevant product.
let activeTab = null;

// Loads the flag design (template, colors, variations, logo library) from a
// freshly-fetched project record into `S`. Shared by the initial load and the
// realtime refresh so the designer's edits don't require the customer to
// reload the page to see them.
async function loadFlagsInto(project) {
  const flagCfg = project.flagConfig;
  if (!flagCfg) { S.variations = []; return; }
  S.flagId = flagCfg.flag_id;
  S.colors = flagCfg.colors || {};
  try { S.library = await loadLogosForProject(project.id, reviewClient); } catch { S.library = []; }
  await preloadLogoAspects(S.library);
  const varData = flagCfg.variations || [];
  const varItems = Array.isArray(varData) ? varData : (varData.items || []);
  S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
  S.gsTag = Array.isArray(varData) ? false : (varData.gsTag ?? false);
  S.gsTagMode = Array.isArray(varData) ? 'auto' : (varData.gsTagMode ?? 'auto');
  S.textLayers = Array.isArray(varData) ? [] : (varData.textLayers || []);
  S.imageLayers = Array.isArray(varData) ? [] : (varData.imageLayers || []);
  await preloadLogoAspects(S.imageLayers);
  S.variations = varItems.map(v => ({ ...v }));
  await loadAllFlags(FLAGS);
  const activeFlag = FLAGS.find(f => f.id === S.flagId);
  if (activeFlag?.logoZoneSets && S.logoLayout) {
    activeFlag.logoZones = activeFlag.logoZoneSets[S.logoLayout] || activeFlag.logoZones;
  }
}

// Same idea as loadFlagsInto, for the hole-sign design.
function loadHsInto(project) {
  const hsCfg = project.holeSignConfig;
  if (!hsCfg) { hsState = null; hsVariations = []; return; }
  // Spread all fields from `colors` so new design properties are picked up
  // automatically when the hole sign editor adds them, without needing to
  // manually update this page. `template_style` lives as a top-level DB
  // column, not inside `colors`, so it's merged in separately.
  hsState = {
    templateStyle: hsCfg.template_style || 'hole-sign-1',
    ...(hsCfg.colors || {}),
  };
  hsVariations = hsCfg.variations || [];
}

// Re-fetches the design (not feedback — that's a separate concern the
// reviewer's own actions already keep in sync) and re-renders. Any
// not-yet-submitted local approve/edit selections survive since `localFeedback`
// /`localHsFeedback` are keyed by variation id and untouched here.
async function reloadDesigns() {
  try {
    const project = await getProjectByToken(reviewToken, reviewClient);
    currentProject = project;
    await loadFlagsInto(project);
    loadHsInto(project);
    renderPage(project);
  } catch (err) {
    console.error('Could not refresh review page with latest design:', err);
  }
}

function subscribeToDesignChanges() {
  if (configChannel) configChannel.unsubscribe();
  configChannel = supabase
    .channel('review-config-' + projectId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flag_config', filter: `project_id=eq.${projectId}` }, reloadDesigns)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'hole_sign_config', filter: `project_id=eq.${projectId}` }, reloadDesigns)
    .subscribe();
}

// A variation can override the project's flag template/colors/GS-tag
// (mirrors the same resolution used in the designer's own gallery).
function getVarFlag(v) {
  if (!v) return getFlag();
  const id = v.flagId || S.flagId;
  return FLAGS.find(f => f.id === id) || getFlag();
}
function getVarColors(v) { return (v && v.colors) ? v.colors : S.colors; }
function getVarGsTagOpts(v) {
  if (!v || (v.gsTag === undefined && v.gsTagMode === undefined)) return null;
  return { enabled: v.gsTag ?? S.gsTag, mode: v.gsTagMode ?? S.gsTagMode };
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (!token) { showError('Invalid review link.'); return; }
  reviewToken = token;
  reviewClient = createReviewClient(token);

  // Deep-link support: a gallery's "share for review" link carries
  // ?tab=flags or ?tab=hole-signs so the reviewer lands on the product they
  // were actually shown, instead of always defaulting to flags first.
  const tabParam = params.get('tab');
  activeTab = (tabParam === 'flags' || tabParam === 'hole-signs') ? tabParam : null;

  root.innerHTML = '<div class="rv-loading">Loading…</div>';

  try {
    const project = await getProjectByToken(token, reviewClient);
    currentProject = project;
    projectId = project.id;
    projectName = project.name;

    // ── Flags ──────────────────────────────────────────────
    await loadFlagsInto(project);
    if (project.flagConfig) {
      try {
        (await getFeedback(project.id, 'flags', reviewClient)).forEach(f => {
          localFeedback[f.variation_id] = { status: f.status, note: f.note || '', resolved: f.resolved || false };
          submittedFlags.add(f.variation_id);
          if (!previousReviewerName && f.reviewer_name) previousReviewerName = f.reviewer_name;
          if (!previousReviewerEmail && f.reviewer_email) previousReviewerEmail = f.reviewer_email;
          if (!previousGeneralNote && f.general_note) previousGeneralNote = f.general_note;
        });
      } catch (e) { console.warn('Could not load flag feedback:', e); }
    }

    // ── Hole signs ─────────────────────────────────────────
    loadHsInto(project);
    if (project.holeSignConfig) {
      try {
        (await getFeedback(project.id, 'hole-signs', reviewClient)).forEach(f => {
          localHsFeedback[f.variation_id] = { status: f.status, note: f.note || '', resolved: f.resolved || false };
          submittedHs.add(f.variation_id);
          if (!previousReviewerName && f.reviewer_name) previousReviewerName = f.reviewer_name;
          if (!previousReviewerEmail && f.reviewer_email) previousReviewerEmail = f.reviewer_email;
          if (!previousGeneralNote && f.general_note) previousGeneralNote = f.general_note;
        });
      } catch (e) { console.warn('Could not load hole sign feedback:', e); }
    }

    // A returning reviewer's own prior submission wins; otherwise default the
    // name/email fields to the project's known contact details - customer_info
    // (staff-corrected) falling back to the original order intake, same
    // precedence as the Customer details modal in project.js.
    if (!previousReviewerName || !previousReviewerEmail) {
      const ci = project.customer_info || {};
      let intake = null;
      try { intake = await loadOrderIntake(project.id); } catch { intake = null; }
      if (!previousReviewerName) previousReviewerName = ci.contact_name ?? intake?.contact_name ?? '';
      if (!previousReviewerEmail) previousReviewerEmail = ci.contact_email ?? intake?.contact_email ?? '';
    }

    renderPage(project);
    subscribeToDesignChanges();
  } catch (err) {
    console.error('Review page failed to load:', err);
    showError('Could not load this review. The link may be invalid or expired.');
  }
}

function showError(msg) {
  root.innerHTML = `<div class="rv-error"><p style="font-size:15px;color:var(--gray-600)">${msg}</p></div>`;
}

function getEffectiveStatus(fb) {
  if (!fb || !fb.status) return 'pending';
  if (fb.status === 'approved') return 'approved';
  if (fb.status === 'needs_edits' && !fb.resolved) return 'needs_edits';
  return 'pending';
}

function updateSummary() {
  const total = S.variations.length;
  if (!total) return;
  const approved = S.variations.filter(v => getEffectiveStatus(localFeedback[v.id]) === 'approved').length;
  const edits    = S.variations.filter(v => getEffectiveStatus(localFeedback[v.id]) === 'needs_edits').length;
  const pending  = total - approved - edits;
  const el = document.getElementById('rcApproved');
  if (!el) return;
  document.getElementById('rcApproved').textContent = `${approved} approved`;
  document.getElementById('rcEdits').textContent    = `${edits} needs edits`;
  document.getElementById('rcPending').textContent  = `${pending} pending`;
  document.getElementById('rvBarApproved').style.width = `${(approved / total) * 100}%`;
  document.getElementById('rvBarEdits').style.width    = `${(edits   / total) * 100}%`;
}

// ── Flag card helpers ─────────────────────────────────────────────────────────

function collapseCard(card, v) {
  card.className = 'rv-card rv-approved rv-card-collapsed';
  card.innerHTML = `
    <div class="rv-collapsed-row">
      <div class="rv-collapsed-thumb" id="rvct-${v.id}"></div>
      <div class="rv-vname">${esc(v.name)}</div>
      <span class="rv-status-badge approved"><i class="fa-solid fa-check" aria-hidden="true"></i> Approved</span>
      <button class="rv-unapprove-btn" id="rvunapprove-${v.id}">Unapprove</button>
    </div>`;
  const thumbEl = card.querySelector('#rvct-' + v.id);
  if (thumbEl) renderInto(thumbEl, v.logos || v.assignment, 'front', false, getVarFlag(v), getVarColors(v), withMasterText(v), getVarGsTagOpts(v), S.imageLayers || []);
  card.querySelector('#rvunapprove-' + v.id)?.addEventListener('click', () => unapproveVariation(localFeedback, v.id));
}

// Reverts a locally/previously approved variation back to pending so the
// reviewer can change their mind before (or after) submitting. Only clears
// local UI state — a variation that was already submitted as 'approved'
// stays that way in the DB until the reviewer submits a new decision for it
// (submitFeedback upserts by variation_id, so the next submit overwrites it).
function unapproveVariation(map, variationId) {
  const fb = map[variationId];
  if (fb) delete fb.status;
  renderPage(currentProject);
}

window.approveAll = function () {
  S.variations.forEach(v => {
    if (getEffectiveStatus(localFeedback[v.id]) === 'approved') return;
    localFeedback[v.id] = { ...(localFeedback[v.id] || {}), status: 'approved' };
    const card = document.getElementById('rvc-' + v.id);
    if (card) collapseCard(card, v);
  });
  updateSummary();
};

function updateHsSummary() {
  const total = hsVariations.length;
  if (!total) return;
  const approved = hsVariations.filter(v => getEffectiveStatus(localHsFeedback[v.id]) === 'approved').length;
  const edits    = hsVariations.filter(v => getEffectiveStatus(localHsFeedback[v.id]) === 'needs_edits').length;
  const pending  = total - approved - edits;
  const el = document.getElementById('hsrcApproved');
  if (!el) return;
  document.getElementById('hsrcApproved').textContent = `${approved} approved`;
  document.getElementById('hsrcEdits').textContent    = `${edits} needs edits`;
  document.getElementById('hsrcPending').textContent  = `${pending} pending`;
  document.getElementById('hsrvBarApproved').style.width = `${(approved / total) * 100}%`;
  document.getElementById('hsrvBarEdits').style.width    = `${(edits   / total) * 100}%`;
}

window.approveAllHs = function () {
  hsVariations.forEach(v => {
    if (getEffectiveStatus(localHsFeedback[v.id]) === 'approved') return;
    localHsFeedback[v.id] = { ...(localHsFeedback[v.id] || {}), status: 'approved' };
    const card = document.getElementById('hsc-' + v.id);
    if (card) collapseHsCard(card, v);
  });
  updateHsSummary();
};

// ── Hole sign card helpers ────────────────────────────────────────────────────

// Mirrors the per-variation template resolution in hs/state.js getEffectiveState,
// without the editing-draft logic (not applicable on the review page).
function effectiveHsState(v) {
  if (!hsState) return null;
  const out = { ...hsState };
  if (v?.template) {
    if (v.template.templateStyle) out.templateStyle = v.template.templateStyle;
    if (v.template.background)    out.background    = v.template.background;
    if (v.template.topText)       out.topText       = v.template.topText;
    if (v.template.bottomText)    out.bottomText    = v.template.bottomText;
    if (v.template.bannerTop)     out.bannerTop     = v.template.bannerTop;
    if (v.template.bannerBottom)  out.bannerBottom  = v.template.bannerBottom;
    if (v.template.templateLogos) out.templateLogos = v.template.templateLogos;
  }
  // Quick-edited per-slot sponsor logo overrides (see getEffectiveState in
  // hs/state.js) — without this, a variation whose sponsor logo was swapped
  // via a quick-edit (rather than a full v.template snapshot) would render
  // here with the unmodified template logo, and the "replace a logo" quick-pick
  // below would offer the wrong current image to replace.
  if (v?.templateLogoOverrides) {
    const slots = (out.templateLogos?.slots || []).map((s, i) => {
      const ov = v.templateLogoOverrides[i];
      return ov ? { ...s, ...ov } : s;
    });
    out.templateLogos = { ...out.templateLogos, slots };
  }
  return out;
}

function collapseHsCard(card, v) {
  card.className = 'rv-card rv-approved rv-card-collapsed';
  card.innerHTML = `
    <div class="rv-collapsed-row">
      <div class="hs-rv-thumb" id="hscthumb-${v.id}"></div>
      <div class="rv-vname">${esc(v.name)}</div>
      <span class="rv-status-badge approved"><i class="fa-solid fa-check" aria-hidden="true"></i> Approved</span>
      <button class="rv-unapprove-btn" id="hsunapprove-${v.id}">Unapprove</button>
    </div>`;
  const el = card.querySelector('#hscthumb-' + v.id);
  const state = effectiveHsState(v);
  if (el && state) renderHoleSignInto(el, state, v);
  card.querySelector('#hsunapprove-' + v.id)?.addEventListener('click', () => unapproveVariation(localHsFeedback, v.id));
}

// ── Page render ───────────────────────────────────────────────────────────────

// A design only becomes visible to the reviewer once a proof has actually
// gone out for it - 'draft'/'submitted' mean the designer hasn't shared
// anything yet, so there's nothing here for the reviewer to look at even if
// the design already has variations. Without this, a project with (say)
// flags proof_sent but hole signs still mid-draft would show a Hole Signs
// tab the client was never actually invited to review.
const SENT_FOR_REVIEW_STATUSES = ['proof_sent', 'needs_changes', 'approved', 'sent_to_print'];
function isSentForReview(status) { return SENT_FOR_REVIEW_STATUSES.includes(status); }

// Shared by renderPage (drives the locked/approved UI per tab) and the
// post-submit success screen (which needs to know if the *whole* project -
// every product type it actually has, not just the one tab just submitted -
// just became fully approved).
function computeApprovalState() {
  const hasFlags = S.variations.length > 0 && isSentForReview(currentProject?.flagConfig?.status);
  const hasHoleSigns = hsVariations.length > 0 && isSentForReview(currentProject?.holeSignConfig?.status);

  // Locked when every variation of that product type has been submitted with
  // feedback that is still active (approved, or needs_edits and not yet
  // resolved). In that state the reviewer has nothing left to submit for
  // that product until the designer responds, so its submit row disappears.
  const allFlagsLocked = !hasFlags || S.variations.every(v => {
    const fb = localFeedback[v.id];
    if (!submittedFlags.has(v.id)) return false;
    return fb?.status === 'approved' || (fb?.status === 'needs_edits' && !fb?.resolved);
  });
  const allHsLocked = !hasHoleSigns || hsVariations.every(v => {
    const fb = localHsFeedback[v.id];
    if (!submittedHs.has(v.id)) return false;
    return fb?.status === 'approved' || (fb?.status === 'needs_edits' && !fb?.resolved);
  });
  const allLocked = (hasFlags || hasHoleSigns) && allFlagsLocked && allHsLocked
    && (submittedFlags.size > 0 || submittedHs.size > 0);

  // All approved is a strict subset of locked — every variation has status='approved'.
  const allFlagsApproved = !hasFlags || S.variations.every(v => localFeedback[v.id]?.status === 'approved');
  const allHsApproved    = !hasHoleSigns || hsVariations.every(v => localHsFeedback[v.id]?.status === 'approved');
  const allApproved = allLocked && allFlagsApproved && allHsApproved;

  return { hasFlags, hasHoleSigns, allFlagsLocked, allHsLocked, allLocked, allFlagsApproved, allHsApproved, allApproved };
}

function renderPage(project) {
  currentProject = project;
  const { hasFlags, hasHoleSigns, allFlagsLocked, allHsLocked, allLocked, allFlagsApproved, allHsApproved, allApproved } = computeApprovalState();
  const showTabs = hasFlags && hasHoleSigns;
  const n = S.variations.length;
  const hsTotalQty = hsVariations.reduce((sum, v) => sum + (parseInt(v.qty, 10) || 1), 0);

  // Keep activeTab valid for whatever this project actually has — falls
  // back to whichever product type exists when unset (fresh load with no
  // ?tab= param) or when it pointed at a type this project doesn't have.
  if (!activeTab || (activeTab === 'flags' && !hasFlags) || (activeTab === 'hole-signs' && !hasHoleSigns)) {
    activeTab = hasFlags ? 'flags' : 'hole-signs';
  }

  const meta = hasFlags && hasHoleSigns ? 'Flags & Hole Signs' : hasFlags ? 'Flags' : hasHoleSigns ? 'Hole Signs' : '';

  // The instructions banner reflects whichever product is on screen right
  // now (the active tab), not the other one — a reviewer who just finished
  // flags shouldn't be told to keep reviewing because hole signs are still
  // pending underneath a tab they're not looking at.
  const hasAny = hasFlags || hasHoleSigns;
  const activeIsFlags = showTabs ? activeTab === 'flags' : hasFlags;
  const activeApproved = hasAny && (activeIsFlags ? allFlagsApproved : allHsApproved);
  const activeLocked   = hasAny && (activeIsFlags ? allFlagsLocked   : allHsLocked);

  const instructionsText = activeApproved
    ? 'Approved — this design will be sent to print.'
    : activeLocked
      ? 'Feedback has been received. The designer will notify you once changes are made.'
      : 'Review each variation below. Mark it as approved or request changes — add a note to explain what needs adjusting.';

  const instructionsClass = activeApproved
    ? ' rv-instructions-approved'
    : activeLocked
      ? ' rv-instructions-locked'
      : '';

  // The name/email/general-note fields stay single, project-wide values
  // (only freeze once truly everything is locked) — unlike the instructions
  // banner, there's only ever one reviewer identity regardless of which tab
  // is active. Once the active tab's design is fully approved there's
  // nothing left to submit for it, so the contact/notes fields (and the
  // variations grid below, see allFlagsApproved/allHsApproved) disappear
  // entirely rather than lingering as a read-only summary - if the other
  // product type still needs review, switching tabs brings them right back.
  const nameRow = activeApproved
    ? ''
    : allLocked
      ? ((previousReviewerName || previousReviewerEmail || previousGeneralNote)
          ? `<div class="rv-name-row">
               ${previousReviewerName ? `<div class="rv-field"><div class="rv-field-label">Your name</div><div class="rv-name-readonly">${esc(previousReviewerName)}</div></div>` : ''}
               ${previousReviewerEmail ? `<div class="rv-field"><div class="rv-field-label">Your email</div><div class="rv-name-readonly">${esc(previousReviewerEmail)}</div></div>` : ''}
               ${previousGeneralNote ? `<div class="rv-field"><div class="rv-field-label">Notes</div><div class="rv-name-readonly">${esc(previousGeneralNote)}</div></div>` : ''}
             </div>`
          : '')
      : `<div class="rv-name-row">
           <div class="rv-field">
             <div class="rv-field-label">Full name *</div>
             <input class="rv-name-input" id="reviewerName" type="text" placeholder="e.g. Sarah Johnson" value="${esc(previousReviewerName)}">
           </div>
           <div class="rv-field">
             <div class="rv-field-label">Email *</div>
             <input class="rv-name-input" id="reviewerEmail" type="email" placeholder="e.g. sarah@email.com" value="${esc(previousReviewerEmail)}">
           </div>
           <div class="rv-field">
             <div class="rv-field-label">General notes</div>
             <textarea class="rv-note rv-general-note" id="reviewerGeneralNote" placeholder="Anything else we should know?">${esc(previousGeneralNote)}</textarea>
           </div>
         </div>`;

  const tabsHtml = showTabs ? `
    <div class="rv-product-tabs">
      <button class="rv-product-tab${activeTab === 'flags' ? ' active' : ''}" onclick="setActiveTab('flags')"><i class="fa-solid fa-flag" aria-hidden="true"></i> Flags</button>
      <button class="rv-product-tab${activeTab === 'hole-signs' ? ' active' : ''}" onclick="setActiveTab('hole-signs')"><i class="fa-solid fa-signs-post" aria-hidden="true"></i> Hole Signs</button>
    </div>` : '';

  root.innerHTML = `
    <div class="rv-root">
      <div class="rv-hero">
        <div class="rv-hero-tag">Design Review</div>
        <div class="rv-project">${esc(project.name) || 'Review'}</div>
        <div class="rv-meta">${meta}</div>
      </div>
      ${tabsHtml}
      <div class="rv-info-section">
        <div class="rv-instructions${instructionsClass}">${activeApproved ? '<span class="rv-instructions-icon"><i class="fa-solid fa-check" aria-hidden="true"></i></span>' : ''}${instructionsText}</div>
        ${nameRow}
      </div>

      ${hasFlags ? `
        <div class="rv-tab-panel" data-tab="flags"${showTabs && activeTab !== 'flags' ? ' hidden' : ''}>
          ${allFlagsApproved ? '' : `
          <div class="rv-summary" id="rvSummary">
            <div class="rv-summary-left">
              <div class="rv-summary-counts">
                <span class="rv-count approved" id="rcApproved">0 approved</span>
                <span class="rv-count needs-edits" id="rcEdits">0 needs edits</span>
                <span class="rv-count pending" id="rcPending">${n} pending</span>
              </div>
              <div class="rv-progress-bar">
                <div class="rv-progress-approved" id="rvBarApproved" style="width:0%"></div>
                <div class="rv-progress-edits" id="rvBarEdits" style="width:0%"></div>
              </div>
            </div>
            <button class="rv-approve-all-btn" onclick="approveAll()">Approve all</button>
          </div>
          <div class="rv-variations" id="rvVariations"></div>
          ${allFlagsLocked ? '' : `
          <div class="rv-submit-row">
            <button class="rv-submit-btn" id="rvSubmit" onclick="submitProductReview('flags')">Submit flag feedback <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
          </div>`}`}
        </div>
      ` : ''}

      ${hasHoleSigns ? `
        <div class="rv-tab-panel" data-tab="hole-signs"${showTabs && activeTab !== 'hole-signs' ? ' hidden' : ''}>
          ${allHsApproved ? '' : `
          <div class="rv-summary" id="hsRvSummary">
            <div class="rv-summary-left">
              <div class="rv-summary-total">${hsVariations.length} variation${hsVariations.length === 1 ? '' : 's'} &middot; ${hsTotalQty} sign${hsTotalQty === 1 ? '' : 's'} total</div>
              <div class="rv-summary-counts">
                <span class="rv-count approved" id="hsrcApproved">0 approved</span>
                <span class="rv-count needs-edits" id="hsrcEdits">0 needs edits</span>
                <span class="rv-count pending" id="hsrcPending">${hsVariations.length} pending</span>
              </div>
              <div class="rv-progress-bar">
                <div class="rv-progress-approved" id="hsrvBarApproved" style="width:0%"></div>
                <div class="rv-progress-edits" id="hsrvBarEdits" style="width:0%"></div>
              </div>
            </div>
            <button class="rv-approve-all-btn" onclick="approveAllHs()">Approve all</button>
          </div>
          <div class="rv-variations" id="hsRvVariations"></div>
          ${allHsLocked ? '' : `
          <div class="rv-submit-row">
            <button class="rv-submit-btn" id="hsRvSubmit" onclick="submitProductReview('hole-signs')">Submit hole sign feedback <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
          </div>`}`}
        </div>
      ` : ''}
    </div>`;

  if (hasFlags && !allFlagsApproved) {
    const container = document.getElementById('rvVariations');
    S.variations.forEach(v => container.appendChild(buildCard(v, localFeedback[v.id] || {})));
    updateSummary();
  }

  if (hasHoleSigns && !allHsApproved) {
    const container = document.getElementById('hsRvVariations');
    hsVariations.forEach(v => container.appendChild(buildHsCard(v, localHsFeedback[v.id] || {})));
    updateHsSummary();
  }
}

// Switches which product's panel is visible. A full re-render (rather than
// just toggling `hidden`) is cheap here (at most a couple dozen cards) and
// means the instructions banner/tab active-state stay in sync for free.
window.setActiveTab = function (tab) {
  activeTab = tab;
  renderPage(currentProject);
};

// ── Card builders ─────────────────────────────────────────────────────────────

function buildCard(v, fb) {
  const effectiveStatus = getEffectiveStatus(fb);
  const card = document.createElement('div');
  card.id = 'rvc-' + v.id;

  if (effectiveStatus === 'approved') { collapseCard(card, v); return card; }

  // Lock the card once feedback was previously submitted and is still active
  // (needs_edits, not yet resolved by designer). The customer can't change
  // their request until the designer resolves it.
  const isLocked = submittedFlags.has(v.id) && fb?.status === 'needs_edits' && !fb?.resolved;

  const hasBack = (v.backLogos?.length > 0) || Object.keys(v.backAssignment || {}).length > 0;
  card.className = 'rv-card' + (effectiveStatus === 'needs_edits' ? ' rv-needs-edits' : '') + (isLocked ? ' rv-locked' : '');

  const reApprovalHint = (fb?.status === 'needs_edits' && fb?.resolved)
    ? '<div class="rv-reapproval-hint">The designer has updated this design — please review again.</div>' : '';

  const statusTile = effectiveStatus === 'needs_edits'
    ? '<span class="rv-status-tile needs-edits">Needs edits</span>'
    : '';

  const previewHtml = hasBack
    ? `<div class="rv-dual-preview">
         <div><div class="rv-face-label">Front</div><div class="rv-preview" id="rvp-front-${v.id}"></div></div>
         <div><div class="rv-face-label">Back</div><div class="rv-preview" id="rvp-back-${v.id}"></div></div>
       </div>`
    : `<div class="rv-preview" id="rvp-${v.id}"></div>`;

  const actionsHtml = isLocked
    ? '<div class="rv-locked-msg">Edit request submitted. The designer has been notified and will update this design.</div>'
    : `<div class="rv-actions">
        <button class="rv-btn approve" id="rapprove-${v.id}"><i class="fa-solid fa-check" aria-hidden="true"></i> Approve</button>
        <button class="rv-btn edits${effectiveStatus === 'needs_edits' ? ' active' : ''}" id="redits-${v.id}"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Request edits</button>
      </div>
      <div class="rv-note-wrap${effectiveStatus === 'needs_edits' ? ' visible' : ''}" id="rnw-${v.id}">
        <textarea class="rv-note" id="rnote-${v.id}" placeholder="What needs to change?">${effectiveStatus === 'needs_edits' ? (fb.note || '') : ''}</textarea>
        ${quickPicksHtml('r', v.id)}
      </div>`;

  const lockedNote = (isLocked && fb?.note)
    ? `<div class="rv-locked-note"><span class="rv-locked-note-label">Your note:</span>${esc(fb.note)}</div>`
    : '';

  card.innerHTML = `
    <div class="rv-card-header">
      <div class="rv-vname">${esc(v.name)}</div>
      ${statusTile}
    </div>
    ${reApprovalHint}${previewHtml}
    ${lockedNote}
    ${actionsHtml}`;

  if (hasBack) {
    renderInto(card.querySelector('#rvp-front-' + v.id), v.logos || v.assignment, 'front', false, getVarFlag(v), getVarColors(v), withMasterText(v), getVarGsTagOpts(v), S.imageLayers || []);
    renderInto(card.querySelector('#rvp-back-'  + v.id), v.backLogos || v.backAssignment || [], 'back', false, getVarFlag(v), getVarColors(v), [...(S.textLayers || []), ...(v.backTextLayers || [])], getVarGsTagOpts(v), S.imageLayers || []);
  } else {
    renderInto(card.querySelector('#rvp-' + v.id), v.logos || v.assignment, 'front', false, getVarFlag(v), getVarColors(v), withMasterText(v), getVarGsTagOpts(v), S.imageLayers || []);
  }

  if (!isLocked) {
    card.querySelector('#rapprove-' + v.id).addEventListener('click', () => {
      localFeedback[v.id] = { ...(localFeedback[v.id] || {}), status: 'approved' };
      collapseCard(card, v); updateSummary();
    });
    card.querySelector('#redits-' + v.id).addEventListener('click', () => {
      localFeedback[v.id] = { ...(localFeedback[v.id] || {}), status: 'needs_edits', resolved: false };
      card.querySelector('#redits-' + v.id).classList.add('active');
      card.querySelector('#rapprove-' + v.id).classList.remove('active');
      card.querySelector('#rnw-' + v.id).classList.add('visible');
      card.className = 'rv-card rv-needs-edits';
      card.querySelector('#rnote-' + v.id)?.focus();
      updateSummary();
    });
    card.querySelector('#rnote-' + v.id)?.addEventListener('input', e => {
      if (!localFeedback[v.id]) localFeedback[v.id] = {};
      localFeedback[v.id].note = e.target.value;
    });
    wireFlagQuickPicks(card, v);
  }

  return card;
}

// ── Quick-pick "Request edits" extras ──────────────────────────────────────────
// Optional structured add-ons to the freeform note: a different flag style /
// hole-sign template, different colors, a replacement logo. Stored on
// localFeedback[v.id]/localHsFeedback[v.id] alongside note/status, uploaded
// (logo only) and submitted as part of the same variation_feedback row in
// submitProductReview() below. Entirely optional — none of this blocks submitting
// just a note, same as today.

// Shared shell markup for both flag and hole-sign cards; `prefix` is 'r' or
// 'hs' to keep element ids distinct per product type.
function quickPicksHtml(prefix, id) {
  return `
    <div class="rv-quickpicks" id="${prefix}qp-${id}">
      <div class="rv-qp-row">
        <div class="rv-qp-label">Prefer a different ${prefix === 'r' ? 'flag style' : 'template'}?</div>
        <div class="rv-qp-styles" id="${prefix}qpStyles-${id}"></div>
      </div>
      <div class="rv-qp-row">
        <div class="rv-qp-label">Want different colors?</div>
        <div class="rv-qp-colors" id="${prefix}qpColors-${id}"></div>
      </div>
      <div class="rv-qp-row">
        <div class="rv-qp-label">Need a different logo?</div>
        <div class="rv-qp-logo-list" id="${prefix}qpLogoList-${id}"></div>
      </div>
    </div>`;
}

// Every logo currently placed on a flag variation — front zone(s) plus back
// zone(s) when the variation has a back design — each carrying an `id` local
// to this page (a copy of the placement's own id, 'back-' prefixed for a
// back-face placement so it can't collide with a front one) used only to
// track which one a pending replacement targets.
function flagLogoRefs(v) {
  const refs = [];
  normaliseLogos(v.logos || v.assignment).forEach(item => {
    const entry = findLogo(item.logoId);
    if (entry) refs.push({ id: item.id, src: entry.src });
  });
  normaliseLogos(v.backLogos || v.backAssignment).forEach(item => {
    const entry = findLogo(item.logoId);
    if (entry) refs.push({ id: 'back-' + item.id, src: entry.src });
  });
  // Template-level free images (Step 1's "Images" row, S.imageLayers) — same
  // for every variation, unlike the per-variation placements above, but just
  // as replaceable from the reviewer's point of view. Their own 'fil-'-
  // prefixed ids (see addFlagImageLayer, flags/image-layers.js) already
  // can't collide with a zone placement id or the 'back-' prefix above.
  (S.imageLayers || []).forEach(layer => {
    if (layer.src) refs.push({ id: layer.id, src: layer.src });
  });
  return refs;
}

// Every hole-sign template logo slot that actually has an image in it right
// now (an empty slot has nothing to replace) — 'slot-<index>' as the id
// since slots carry no id of their own, stable for as long as the template's
// slot count/order doesn't change mid-review.
function hsLogoRefs(v) {
  const slots = effectiveHsState(v)?.templateLogos?.slots || [];
  return slots
    .map((slot, i) => (slot?.logoSrc ? { id: 'slot-' + i, src: slot.logoSrc } : null))
    .filter(Boolean);
}

// Renders one row per current logo (`logoRefs`), each with its own "Replace
// logo" button, plus one trailing "Add a logo" row that isn't tied to
// replacing anything — covers both a variation with no logo placed yet (no
// row to attach a replacement to) and a variation that already has one but
// the customer just wants to add another rather than swap it out. Only one
// pending upload is tracked per variation (requestedLogoFile/
// requestedLogoTargetId on the fb object, matching the single
// requested_logo_url/path/target_id columns it's ultimately submitted as) —
// picking a different row's button just moves the pending state to that
// row, same as requestedColors/requestedFlagId already being overwritten
// wholesale on each edit rather than accumulating a history. A pending
// upload with no target (the "Add" row) is told apart from "not chosen yet"
// by requestedLogoFile itself being set — requestedLogoTargetId is only
// ever falsy-but-meaningful once a file exists alongside it.
function renderLogoReplaceRows(listEl, logoRefs, map, variationId) {
  const rerender = () => renderLogoReplaceRows(listEl, logoRefs, map, variationId);
  listEl.innerHTML = '';
  const fb = map[variationId] || {};

  if (!logoRefs.length) {
    const empty = document.createElement('div');
    empty.className = 'rv-qp-empty';
    empty.textContent = 'No logo placed on this design yet.';
    listEl.appendChild(empty);
  }

  logoRefs.forEach(ref => {
    const isPending = !!fb.requestedLogoFile && fb.requestedLogoTargetId === ref.id;
    const row = document.createElement('div');
    row.className = 'rv-qp-logo-item';
    row.innerHTML = `
      <div class="rv-qp-logo-thumb"><img src="${esc(ref.src)}" alt=""></div>
      ${isPending ? `
        <i class="fa-solid fa-right-left rv-qp-swap-icon" aria-hidden="true"></i>
        <div class="rv-qp-logo-thumb rv-qp-logo-new"></div>
        <button type="button" class="rv-qp-logo-remove-btn" title="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      ` : `
        <button type="button" class="rv-qp-logo-replace-btn">Replace logo</button>
        <input type="file" accept="image/*" class="rv-qp-file" hidden>
      `}`;
    listEl.appendChild(row);

    if (isPending) {
      const objUrl = URL.createObjectURL(fb.requestedLogoFile);
      row.querySelector('.rv-qp-logo-new').innerHTML = `<img src="${objUrl}" alt="">`;
      row.querySelector('.rv-qp-logo-remove-btn').addEventListener('click', () => {
        URL.revokeObjectURL(objUrl);
        delete fb.requestedLogoFile;
        delete fb.requestedLogoTargetId;
        rerender();
      });
    } else {
      const fileInput = row.querySelector('.rv-qp-file');
      row.querySelector('.rv-qp-logo-replace-btn').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!map[variationId]) map[variationId] = {};
        map[variationId].requestedLogoFile = file;
        map[variationId].requestedLogoTargetId = ref.id;
        rerender();
      });
    }
  });

  const addPending = !!fb.requestedLogoFile && !fb.requestedLogoTargetId;
  const addRow = document.createElement('div');
  addRow.className = 'rv-qp-logo-item';
  addRow.innerHTML = addPending ? `
    <div class="rv-qp-logo-thumb rv-qp-logo-new"></div>
    <span class="rv-qp-logo-add-label">New logo</span>
    <button type="button" class="rv-qp-logo-remove-btn" title="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
  ` : `
    <button type="button" class="rv-qp-logo-replace-btn"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add a logo</button>
    <input type="file" accept="image/*" class="rv-qp-file" hidden>
  `;
  listEl.appendChild(addRow);

  if (addPending) {
    const objUrl = URL.createObjectURL(fb.requestedLogoFile);
    addRow.querySelector('.rv-qp-logo-new').innerHTML = `<img src="${objUrl}" alt="">`;
    addRow.querySelector('.rv-qp-logo-remove-btn').addEventListener('click', () => {
      URL.revokeObjectURL(objUrl);
      delete fb.requestedLogoFile;
      delete fb.requestedLogoTargetId;
      rerender();
    });
  } else {
    const fileInput = addRow.querySelector('.rv-qp-file');
    addRow.querySelector('.rv-qp-logo-replace-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!map[variationId]) map[variationId] = {};
      map[variationId].requestedLogoFile = file;
      delete map[variationId].requestedLogoTargetId;
      rerender();
    });
  }
}

function wireFlagQuickPicks(card, v) {
  const stylesEl = card.querySelector('#rqpStyles-' + v.id);
  const colorsEl = card.querySelector('#rqpColors-' + v.id);
  const logoListEl = card.querySelector('#rqpLogoList-' + v.id);
  if (!stylesEl || !colorsEl || !logoListEl) return;
  renderLogoReplaceRows(logoListEl, flagLogoRefs(v), localFeedback, v.id);

  const setRequested = (patch) => {
    localFeedback[v.id] = { ...(localFeedback[v.id] || {}), ...patch };
  };

  // A previously chosen "different flag style" (from earlier in this same
  // session — this card is rebuilt from scratch on every renderPage(), but
  // localFeedback[v.id] survives that) still counts as the reviewer's actual
  // current selection, not the variation's own flag — otherwise a later
  // unrelated re-render would silently snap the colors section below back
  // to the ORIGINAL flag's zones even though requestedFlagId still points
  // at the new one.
  const requestedFlagId = localFeedback[v.id]?.requestedFlagId;
  const initialFlag = FLAGS.find(f => f.id === requestedFlagId) || getVarFlag(v);

  FLAGS.forEach(f => {
    const opt = document.createElement('div');
    opt.className = 'rv-qp-style-opt' + (f.id === requestedFlagId ? ' selected' : '');
    opt.dataset.flagId = f.id;
    const thumb = document.createElement('div');
    thumb.className = 'rv-qp-style-thumb';
    opt.appendChild(thumb);
    const label = document.createElement('div');
    label.className = 'rv-qp-style-name';
    label.textContent = f.name;
    opt.appendChild(label);
    renderInto(thumb, [], 'front', false, f, getVarColors(v));
    opt.addEventListener('click', () => {
      stylesEl.querySelectorAll('.rv-qp-style-opt.selected').forEach(el => el.classList.remove('selected'));
      opt.classList.add('selected');
      setRequested({ requestedFlagId: f.id });
      // Different flag styles carry different color zones (e.g. Bristol's
      // primary/secondary/border vs. Plain's primary only) — re-render for
      // the newly picked flag's own zones rather than leaving whatever the
      // previous style's rows happened to be.
      renderColorZoneRows(colorsEl, f, v);
    });
    stylesEl.appendChild(opt);
  });

  renderColorZoneRows(colorsEl, initialFlag, v);
}

// One row per color zone `flag` actually has — called both up front and
// again whenever the reviewer picks a different flag style in the section
// above, since switching styles can change which zones exist at all:
//  - a zone the new flag doesn't have just isn't rendered anymore (and any
//    already-picked value for it is dropped from requestedColors, so a
//    resubmit doesn't carry a color request for a zone that no longer
//    applies), and
//  - a zone that's newly there defaults the same way the main designer's
//    own Step 2 does (see resolveColors, render.js): white for a plain
//    zone, or the secondary/primary color for a border zone — not left
//    blank, so the reviewer can see and adjust it rather than having to
//    notice it's missing.
function renderColorZoneRows(colorsEl, flag, v) {
  colorsEl.innerHTML = '';
  const zones = flag?.colorZones || [];
  const zoneIds = new Set(zones.map(z => z.id));

  const fb = localFeedback[v.id];
  if (fb?.requestedColors) {
    const pruned = Object.fromEntries(Object.entries(fb.requestedColors).filter(([id]) => zoneIds.has(id)));
    fb.requestedColors = Object.keys(pruned).length ? pruned : undefined;
  }

  const resolvedDefaults = resolveColors(getVarColors(v), flag);
  zones.forEach(zone => {
    const row = document.createElement('div');
    row.className = 'rv-qp-color-row';
    const currentHex = localFeedback[v.id]?.requestedColors?.[zone.id] || resolvedDefaults[zone.id] || '#FFFFFF';
    row.innerHTML = `
      <span class="rv-qp-color-label">${esc(zone.label)}</span>
      <input type="color" class="rv-qp-swatch" value="${currentHex}">
      <input type="text" class="rv-qp-hex" value="${currentHex}" maxlength="7">`;
    const swatchEl = row.querySelector('.rv-qp-swatch');
    const hexEl = row.querySelector('.rv-qp-hex');
    const commit = (hex) => {
      const requested = { ...(localFeedback[v.id]?.requestedColors || {}), [zone.id]: hex };
      localFeedback[v.id] = { ...(localFeedback[v.id] || {}), requestedColors: requested };
    };
    swatchEl.addEventListener('input', e => { hexEl.value = e.target.value; commit(e.target.value); });
    hexEl.addEventListener('input', e => {
      const hex = e.target.value.startsWith('#') ? e.target.value : '#' + e.target.value;
      if (/^#[0-9A-Fa-f]{6}$/.test(hex)) { swatchEl.value = hex; commit(hex); }
    });
    colorsEl.appendChild(row);
  });
}

function buildHsCard(v, fb) {
  const effectiveStatus = getEffectiveStatus(fb);
  const card = document.createElement('div');
  card.id = 'hsc-' + v.id;

  if (effectiveStatus === 'approved') { collapseHsCard(card, v); return card; }

  const isLocked = submittedHs.has(v.id) && fb?.status === 'needs_edits' && !fb?.resolved;

  card.className = 'rv-card' + (effectiveStatus === 'needs_edits' ? ' rv-needs-edits' : '') + (isLocked ? ' rv-locked' : '');

  const reApprovalHint = (fb?.status === 'needs_edits' && fb?.resolved)
    ? '<div class="rv-reapproval-hint">The designer has updated this design — please review again.</div>' : '';

  const statusTile = effectiveStatus === 'needs_edits'
    ? '<span class="rv-status-tile needs-edits">Needs edits</span>'
    : '';

  const actionsHtml = isLocked
    ? '<div class="rv-locked-msg">Edit request submitted. The designer has been notified and will update this design.</div>'
    : `<div class="rv-actions">
        <button class="rv-btn approve" id="hsapprove-${v.id}"><i class="fa-solid fa-check" aria-hidden="true"></i> Approve</button>
        <button class="rv-btn edits${effectiveStatus === 'needs_edits' ? ' active' : ''}" id="hsedits-${v.id}"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Request edits</button>
      </div>
      <div class="rv-note-wrap${effectiveStatus === 'needs_edits' ? ' visible' : ''}" id="hsnw-${v.id}">
        <textarea class="rv-note" id="hsnote-${v.id}" placeholder="What needs to change?">${effectiveStatus === 'needs_edits' ? (fb.note || '') : ''}</textarea>
        ${quickPicksHtml('hs', v.id)}
      </div>`;

  const lockedNote = (isLocked && fb?.note)
    ? `<div class="rv-locked-note"><span class="rv-locked-note-label">Your note:</span>${esc(fb.note)}</div>`
    : '';

  card.innerHTML = `
    <div class="rv-card-header">
      <div class="rv-vname">${esc(v.name)}</div>
      ${statusTile}
    </div>
    ${reApprovalHint}
    <div class="rv-preview hs-rv-preview" id="hsrvp-${v.id}"></div>
    ${lockedNote}
    ${actionsHtml}`;

  const effectiveState = effectiveHsState(v);
  if (effectiveState) renderHoleSignInto(card.querySelector('#hsrvp-' + v.id), effectiveState, v);

  if (!isLocked) {
    card.querySelector('#hsapprove-' + v.id).addEventListener('click', () => {
      localHsFeedback[v.id] = { ...(localHsFeedback[v.id] || {}), status: 'approved' };
      collapseHsCard(card, v);
      updateHsSummary();
    });
    card.querySelector('#hsedits-' + v.id).addEventListener('click', () => {
      localHsFeedback[v.id] = { ...(localHsFeedback[v.id] || {}), status: 'needs_edits', resolved: false };
      card.querySelector('#hsedits-' + v.id).classList.add('active');
      card.querySelector('#hsapprove-' + v.id).classList.remove('active');
      card.querySelector('#hsnw-' + v.id).classList.add('visible');
      card.className = 'rv-card rv-needs-edits';
      card.querySelector('#hsnote-' + v.id)?.focus();
      updateHsSummary();
    });
    card.querySelector('#hsnote-' + v.id)?.addEventListener('input', e => {
      if (!localHsFeedback[v.id]) localHsFeedback[v.id] = {};
      localHsFeedback[v.id].note = e.target.value;
    });
    wireHsQuickPicks(card, v);
  }

  return card;
}

function wireHsQuickPicks(card, v) {
  const stylesEl = card.querySelector('#hsqpStyles-' + v.id);
  const colorsEl = card.querySelector('#hsqpColors-' + v.id);
  const logoListEl = card.querySelector('#hsqpLogoList-' + v.id);
  if (!stylesEl || !colorsEl || !logoListEl) return;
  renderLogoReplaceRows(logoListEl, hsLogoRefs(v), localHsFeedback, v.id);

  const setRequested = (patch) => {
    localHsFeedback[v.id] = { ...(localHsFeedback[v.id] || {}), ...patch };
  };

  if (HS_DEFAULT_TEMPLATES.length) {
    const select = document.createElement('select');
    select.className = 'rv-qp-select';
    select.innerHTML = '<option value="">Keep current template</option>' +
      HS_DEFAULT_TEMPLATES.map(t => `<option value="default:${t.id}">${esc(t.name)}</option>`).join('');
    select.addEventListener('change', e => {
      setRequested({ requestedTemplateId: e.target.value || undefined });
    });
    stylesEl.appendChild(select);
  } else {
    stylesEl.innerHTML = '<div class="rv-qp-empty">No alternate templates available yet — describe what you\'d like in the note above.</div>';
  }

  const state = effectiveHsState(v) || {};
  const colorFields = [
    { key: 'background', label: 'Background', hex: state.background?.color },
    { key: 'topText',    label: 'Top text',    hex: state.topText?.color },
    { key: 'bottomText', label: 'Bottom text', hex: state.bottomText?.color },
  ];
  colorFields.forEach(({ key, label, hex: currentHex }) => {
    const hex = currentHex || '#111110';
    const row = document.createElement('div');
    row.className = 'rv-qp-color-row';
    row.innerHTML = `
      <span class="rv-qp-color-label">${esc(label)}</span>
      <input type="color" class="rv-qp-swatch" value="${hex}">
      <input type="text" class="rv-qp-hex" value="${hex}" maxlength="7">`;
    const swatchEl = row.querySelector('.rv-qp-swatch');
    const hexEl = row.querySelector('.rv-qp-hex');
    const commit = (h) => {
      const requested = { ...(localHsFeedback[v.id]?.requestedColors || {}), [key]: h };
      setRequested({ requestedColors: requested });
    };
    swatchEl.addEventListener('input', e => { hexEl.value = e.target.value; commit(e.target.value); });
    hexEl.addEventListener('input', e => {
      const h = e.target.value.startsWith('#') ? e.target.value : '#' + e.target.value;
      if (/^#[0-9A-Fa-f]{6}$/.test(h)) { swatchEl.value = h; commit(h); }
    });
    colorsEl.appendChild(row);
  });
}

// ── Submit ────────────────────────────────────────────────────────────────────

// Builds one variation_feedback row, uploading a pending quick-pick logo
// file first (if any). Quick-pick fields the customer didn't touch are
// written as explicit null — a fresh "Request edits" submission fully
// replaces whatever was requested last time, same semantics note/status
// already have via the same upsert (see submitFeedback, src/supabase.js).
// Shared by both tabs' independent submitProductReview() calls below.
async function buildFeedbackRow(variation_id, fb, reviewerName, reviewerEmail, generalNote, kind) {
  let requested_logo_url = null, requested_logo_path = null;
  if (fb.requestedLogoFile) {
    const uploaded = await uploadFeedbackLogo(projectId, variation_id, fb.requestedLogoFile, reviewClient);
    requested_logo_url = uploaded.url;
    requested_logo_path = uploaded.storagePath;
  }
  return {
    variation_id,
    status: fb.status,
    note: fb.note || '',
    reviewer_name: reviewerName || null,
    reviewer_email: reviewerEmail || null,
    general_note: generalNote || null,
    resolved: false,
    requested_flag_id: kind === 'flags' ? (fb.requestedFlagId || null) : null,
    requested_template_id: kind === 'hole-signs' ? (fb.requestedTemplateId || null) : null,
    requested_colors: (fb.requestedColors && Object.keys(fb.requestedColors).length) ? fb.requestedColors : null,
    requested_logo_url,
    requested_logo_path,
    requested_logo_target_id: fb.requestedLogoFile ? (fb.requestedLogoTargetId || null) : null,
  };
}

// Submits feedback for exactly one product type (`kind`: 'flags' or
// 'hole-signs') — the two tabs are independently submittable, so a reviewer
// can finish flags now and come back for hole signs later without either
// blocking the other. Flags and hole signs each have their own status
// (flag_config.status / hole_sign_config.status), so syncProofStatus()
// below only looks at THIS tab's variations and advances only this
// design's status, not the other tab's.
window.submitProductReview = async function (kind) {
  const isFlags = kind === 'flags';
  const map = isFlags ? localFeedback : localHsFeedback;
  const submittedSet = isFlags ? submittedFlags : submittedHs;
  const btnId = isFlags ? 'rvSubmit' : 'hsRvSubmit';
  const label = isFlags ? 'Submit flag feedback' : 'Submit hole sign feedback';
  const btn = document.getElementById(btnId);
  const reviewerName = document.getElementById('reviewerName')?.value.trim() || previousReviewerName || '';
  const reviewerEmail = document.getElementById('reviewerEmail')?.value.trim() || previousReviewerEmail || '';
  const generalNote = document.getElementById('reviewerGeneralNote')?.value.trim() || previousGeneralNote || '';

  if (!reviewerName) {
    alert('Please enter your full name before submitting.');
    return;
  }
  if (!reviewerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reviewerEmail)) {
    alert('Please enter a valid email address before submitting.');
    return;
  }

  const hasDecisions = Object.values(map).some(fb => fb.status);
  if (!hasDecisions) {
    alert('Please approve or request edits on at least one variation before submitting.');
    return;
  }

  if (btn) { btn.textContent = 'Submitting…'; btn.disabled = true; }

  let items;
  try {
    items = await Promise.all(
      Object.entries(map)
        .filter(([, fb]) => fb.status)
        .map(([variation_id, fb]) => buildFeedbackRow(variation_id, fb, reviewerName, reviewerEmail, generalNote, kind))
    );
  } catch (err) {
    console.error('Uploading requested logo failed:', err);
    if (btn) { btn.innerHTML = `${label} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>`; btn.disabled = false; }
    alert('Something went wrong uploading your logo. Please try again.');
    return;
  }

  try {
    await submitFeedback(projectId, kind, items, reviewClient);
    items.forEach(it => submittedSet.add(it.variation_id));
    if (reviewerName) previousReviewerName = reviewerName;
    if (reviewerEmail) previousReviewerEmail = reviewerEmail;
    if (generalNote) previousGeneralNote = generalNote;

    const outcome = await syncProofStatus(kind, reviewerName, reviewerEmail, generalNote);
    if (outcome === 'partial' || outcome === 'approved') {
      // Stay on the review page rather than taking over the whole screen —
      // an approval only covers THIS tab's design; the reviewer may still
      // have another product type (the other tab) left to review, and a
      // full-page takeover would block them from switching to it. The
      // "sent to print" confirmation shows inline, scoped to this tab, via
      // the instructions banner's activeApproved branch below the tabs.
      renderPage(currentProject);
    } else {
      renderSuccessScreen();
    }
  } catch (err) {
    console.error('Submit failed:', err);
    if (btn) { btn.innerHTML = `${label} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>`; btn.disabled = false; }
    alert('Something went wrong submitting your feedback. Please try again.');
  }
};

// Per-design-type status transition, layered on top of the per-variation
// variation_feedback writes above. Only fires once every variation of THIS
// design (`kind`) has a decision recorded - firing on a partial submission
// would unlock editing before the reviewer finishes the rest. The other
// design type's status is untouched, whatever state it's in. Safe to call
// on a stray double-submit: the RPC's own "wrong source status"
// precondition error is expected once this design has already moved past
// proof_sent, and is swallowed as a no-op rather than surfaced to the
// reviewer.
async function syncProofStatus(kind, reviewerName, reviewerEmail, generalNote) {
  const variations = kind === 'flags' ? S.variations : hsVariations;
  const map = kind === 'flags' ? localFeedback : localHsFeedback;
  const statuses = variations.map(v => map[v.id]?.status).filter(Boolean);
  const allDecided = variations.length > 0 && statuses.length === variations.length;
  if (!allDecided) return 'partial';

  const allApprovedNow = statuses.every(s => s === 'approved');
  const projectUrl = `${window.location.origin}/project?project=${projectId}`;
  try {
    if (allApprovedNow) {
      await clientApproveDesignProof(projectId, kind, reviewClient);
      sendReviewDecision({ decision: 'approved', projectName, projectId, projectUrl, reviewerName: reviewerName || undefined, reviewerEmail: reviewerEmail || undefined, generalNote: generalNote || undefined })
        .catch(err => console.error('sendReviewDecision failed', err));
      return 'approved';
    }
    const note = `${reviewerName ? reviewerName + ': ' : ''}See per-variation feedback for details.`;
    await clientRejectDesignProof(projectId, kind, note, reviewClient);
    sendReviewDecision({ decision: 'changes_requested', projectName, projectId, projectUrl, note, reviewerName: reviewerName || undefined, reviewerEmail: reviewerEmail || undefined, generalNote: generalNote || undefined })
      .catch(err => console.error('sendReviewDecision failed', err));
    return 'rejected';
  } catch (err) {
    const msg = err?.message || '';
    if (msg.includes('cannot approve') || msg.includes('cannot reject')) {
      console.warn('Proof status already transitioned, skipping:', msg);
      return allApprovedNow ? 'approved' : 'rejected';
    }
    console.error('Failed to update proof status:', err);
    throw err;
  }
}

function renderSuccessScreen() {
  root.innerHTML = `
    <div class="rv-root">
      <div class="rv-success">
        <span class="rv-success-icon"><i class="fa-solid fa-check" aria-hidden="true"></i></span>
        <div class="rv-success-title">Feedback submitted</div>
        <div class="rv-success-sub">The design team will review your feedback and be in touch shortly.</div>
      </div>
    </div>`;
}

init();
