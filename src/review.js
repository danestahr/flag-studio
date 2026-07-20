import './icons.js';
import { S } from './state.js';
import { FLAGS } from './data.js';
import { getFlag, renderInto, preloadLogoAspects } from './render.js';
import { loadAllFlags } from './svgLoader.js';
import { getProjectByToken, loadLogosForProject, submitFeedback, getFeedback, supabase } from './supabase.js';
import { renderHoleSignInto } from './hole-sign-render.js';
import { esc } from './dom-utils.js';

const root = document.getElementById('reviewRoot');
const localFeedback = {};    // flags: { [variation_id]: { status, note, resolved } }
const localHsFeedback = {};  // hole signs: same
const submittedFlags = new Set();   // variation_ids loaded from DB (already submitted)
const submittedHs    = new Set();
let previousReviewerName = '';
let hsState = null;
let hsVariations = [];
let projectId = null;
let reviewToken = null;
let configChannel = null;

// Loads the flag design (template, colors, variations, logo library) from a
// freshly-fetched project record into `S`. Shared by the initial load and the
// realtime refresh so the designer's edits don't require the customer to
// reload the page to see them.
async function loadFlagsInto(project) {
  const flagCfg = project.flagConfig;
  if (!flagCfg) { S.variations = []; return; }
  S.flagId = flagCfg.flag_id;
  S.colors = flagCfg.colors || {};
  try { S.library = await loadLogosForProject(project.id); } catch { S.library = []; }
  await preloadLogoAspects(S.library);
  const varData = flagCfg.variations || [];
  const varItems = Array.isArray(varData) ? varData : (varData.items || []);
  S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
  S.gsTag = Array.isArray(varData) ? false : (varData.gsTag ?? false);
  S.gsTagMode = Array.isArray(varData) ? 'auto' : (varData.gsTagMode ?? 'auto');
  S.variations = varItems.map(v => ({ ...v }));
  S.sameLogoOnBothSides = !S.variations.some(v => (v.backLogos?.length || Object.keys(v.backAssignment || {}).length) > 0);
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
    const project = await getProjectByToken(reviewToken);
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
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) { showError('Invalid review link.'); return; }
  reviewToken = token;

  root.innerHTML = '<div class="rv-loading">Loading…</div>';

  try {
    const project = await getProjectByToken(token);
    projectId = project.id;

    // ── Flags ──────────────────────────────────────────────
    await loadFlagsInto(project);
    if (project.flagConfig) {
      try {
        (await getFeedback(project.id, 'flags')).forEach(f => {
          localFeedback[f.variation_id] = { status: f.status, note: f.note || '', resolved: f.resolved || false };
          submittedFlags.add(f.variation_id);
          if (!previousReviewerName && f.reviewer_name) previousReviewerName = f.reviewer_name;
        });
      } catch (e) { console.warn('Could not load flag feedback:', e); }
    }

    // ── Hole signs ─────────────────────────────────────────
    loadHsInto(project);
    if (project.holeSignConfig) {
      try {
        (await getFeedback(project.id, 'hole-signs')).forEach(f => {
          localHsFeedback[f.variation_id] = { status: f.status, note: f.note || '', resolved: f.resolved || false };
          submittedHs.add(f.variation_id);
          if (!previousReviewerName && f.reviewer_name) previousReviewerName = f.reviewer_name;
        });
      } catch (e) { console.warn('Could not load hole sign feedback:', e); }
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
    </div>`;
  const thumbEl = card.querySelector('#rvct-' + v.id);
  if (thumbEl) renderInto(thumbEl, v.logos || v.assignment, 'front', false, getVarFlag(v), getVarColors(v), v.textLayers || [], getVarGsTagOpts(v));
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
  } else if (v?.templateId) {
    out.templateStyle = v.templateId;
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
    </div>`;
  const el = card.querySelector('#hscthumb-' + v.id);
  const state = effectiveHsState(v);
  if (el && state) renderHoleSignInto(el, state, v);
}

// ── Page render ───────────────────────────────────────────────────────────────

function renderPage(project) {
  const hasFlags    = S.variations.length > 0;
  const hasHoleSigns = hsVariations.length > 0;
  const flagName = S.flagId ? S.flagId.charAt(0).toUpperCase() + S.flagId.slice(1) : '';
  const n = S.variations.length;

  const meta = [
    hasFlags     ? `${flagName} flags · ${n} variation${n !== 1 ? 's' : ''}` : '',
    hasHoleSigns ? `${hsVariations.length} hole sign${hsVariations.length !== 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ');

  // Everything is locked when every variation has been submitted with feedback
  // that is still active (approved, or needs_edits and not yet resolved).
  // In that state the reviewer has nothing left to submit until the designer
  // responds, so we surface a "waiting" view rather than the editing UI.
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

  // All approved is a strict subset of allLocked — every variation has status='approved'.
  const allFlagsApproved = !hasFlags || S.variations.every(v => localFeedback[v.id]?.status === 'approved');
  const allHsApproved    = !hasHoleSigns || hsVariations.every(v => localHsFeedback[v.id]?.status === 'approved');
  const allApproved = allLocked && allFlagsApproved && allHsApproved;

  const instructionsText = allApproved
    ? 'All designs approved. The designer will be in touch to finalize the order.'
    : allLocked
      ? 'Feedback has been received. The designer will notify you once changes are made.'
      : 'Review each variation below. Mark it as approved or request changes — add a note to explain what needs adjusting.';

  const instructionsClass = allApproved
    ? ' rv-instructions-approved'
    : allLocked
      ? ' rv-instructions-locked'
      : '';

  const nameRow = allLocked
    ? (previousReviewerName
        ? `<div class="rv-name-row">
             <div class="rv-field-label">Your name</div>
             <div class="rv-name-readonly">${esc(previousReviewerName)}</div>
           </div>`
        : '')
    : `<div class="rv-name-row">
         <div class="rv-field-label">Your name (optional)</div>
         <input class="rv-name-input" id="reviewerName" type="text" placeholder="e.g. Sarah Johnson" value="${esc(previousReviewerName)}">
       </div>`;

  root.innerHTML = `
    <div class="rv-root">
      <div class="rv-hero">
        <div class="rv-project">${esc(project.name) || 'Review'}</div>
        <div class="rv-meta">${meta}</div>
        <div class="rv-instructions${instructionsClass}">${allApproved ? '<span class="rv-instructions-icon"><i class="fa-solid fa-check" aria-hidden="true"></i></span>' : ''}${instructionsText}</div>
      </div>
      ${nameRow}

      ${hasFlags ? `
        ${hasHoleSigns ? '<div class="rv-section-title"><i class="fa-solid fa-flag" aria-hidden="true"></i> Tournament Flags</div>' : ''}
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
      ` : ''}

      ${hasHoleSigns ? `
        ${hasFlags ? '<div class="rv-section-title" style="margin-top:2.5rem"><i class="fa-solid fa-signs-post" aria-hidden="true"></i> Hole Signs</div>' : ''}
        <div class="rv-summary" id="hsRvSummary">
          <div class="rv-summary-left">
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
      ` : ''}

      ${allLocked ? '' : `
      <div class="rv-submit-row">
        <button class="rv-submit-btn" id="rvSubmit" onclick="submitReview()">Submit feedback <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
      </div>`}
    </div>`;

  if (hasFlags) {
    const container = document.getElementById('rvVariations');
    S.variations.forEach(v => container.appendChild(buildCard(v, localFeedback[v.id] || {})));
    updateSummary();
  }

  if (hasHoleSigns) {
    const container = document.getElementById('hsRvVariations');
    hsVariations.forEach(v => container.appendChild(buildHsCard(v, localHsFeedback[v.id] || {})));
    updateHsSummary();
  }
}

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
    renderInto(card.querySelector('#rvp-front-' + v.id), v.logos || v.assignment, 'front', false, getVarFlag(v), getVarColors(v), v.textLayers || [], getVarGsTagOpts(v));
    renderInto(card.querySelector('#rvp-back-'  + v.id), v.backLogos || v.backAssignment || [], 'back', false, getVarFlag(v), getVarColors(v), v.backTextLayers || [], getVarGsTagOpts(v));
  } else {
    renderInto(card.querySelector('#rvp-' + v.id), v.logos || v.assignment, 'front', false, getVarFlag(v), getVarColors(v), v.textLayers || [], getVarGsTagOpts(v));
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
  }

  return card;
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
  }

  return card;
}

// ── Submit ────────────────────────────────────────────────────────────────────

window.submitReview = async function () {
  const btn = document.getElementById('rvSubmit');
  const reviewerName = document.getElementById('reviewerName')?.value.trim() || '';

  const toItems = (map) => Object.entries(map)
    .filter(([, fb]) => fb.status)
    .map(([variation_id, fb]) => ({ variation_id, status: fb.status, note: fb.note || '', reviewer_name: reviewerName || null, resolved: false }));

  const flagItems = toItems(localFeedback);
  const hsItems   = toItems(localHsFeedback);

  if (!flagItems.length && !hsItems.length) {
    alert('Please approve or request edits on at least one variation before submitting.');
    return;
  }

  btn.textContent = 'Submitting…';
  btn.disabled = true;

  try {
    if (flagItems.length) await submitFeedback(projectId, 'flags', flagItems);
    if (hsItems.length)   await submitFeedback(projectId, 'hole-signs', hsItems);

    root.innerHTML = `
      <div class="rv-root">
        <div class="rv-success">
          <span class="rv-success-icon"><i class="fa-solid fa-check" aria-hidden="true"></i></span>
          <div class="rv-success-title">Feedback submitted</div>
          <div class="rv-success-sub">The design team will review your feedback and be in touch shortly.</div>
        </div>
      </div>`;
  } catch (err) {
    console.error('Submit failed:', err);
    btn.innerHTML = 'Submit feedback <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>';
    btn.disabled = false;
    alert('Something went wrong submitting your feedback. Please try again.');
  }
};

init();
