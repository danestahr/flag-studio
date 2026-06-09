import { S } from './state.js';
import { FLAGS } from './data.js';
import { renderInto } from './render.js';
import { loadAllFlags } from './svgLoader.js';
import { getProjectByToken, loadLogosForProject, submitFeedback, getFeedback } from './supabase.js';
import { renderHoleSignInto } from './hole-sign-render.js';

const root = document.getElementById('reviewRoot');
const localFeedback = {};    // flags: { [variation_id]: { status, note, resolved } }
const localHsFeedback = {};  // hole signs: same
const submittedFlags = new Set();   // variation_ids loaded from DB (already submitted)
const submittedHs    = new Set();
let previousReviewerName = '';
let hsState = null;
let hsVariations = [];
let projectId = null;

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function init() {
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) { showError('Invalid review link.'); return; }

  root.innerHTML = '<div class="rv-loading">Loading…</div>';

  try {
    const project = await getProjectByToken(token);
    projectId = project.id;

    // ── Flags ──────────────────────────────────────────────
    const flagCfg = project.flagConfig;
    if (flagCfg) {
      S.flagId = flagCfg.flag_id;
      S.colors = flagCfg.colors || {};
      try { S.library = await loadLogosForProject(project.id); } catch { S.library = []; }
      const varData = flagCfg.variations || [];
      const varItems = Array.isArray(varData) ? varData : (varData.items || []);
      S.logoLayout = Array.isArray(varData) ? 'single' : (varData.layout || 'single');
      S.variations = varItems.map(v => ({ ...v, backAssignment: v.backAssignment || {} }));
      S.sameLogoOnBothSides = !S.variations.some(v => Object.keys(v.backAssignment).length > 0);
      await loadAllFlags(FLAGS);
      const activeFlag = FLAGS.find(f => f.id === S.flagId);
      if (activeFlag?.logoZoneSets && S.logoLayout) {
        activeFlag.logoZones = activeFlag.logoZoneSets[S.logoLayout] || activeFlag.logoZones;
      }
      try {
        (await getFeedback(project.id, 'flags')).forEach(f => {
          localFeedback[f.variation_id] = { status: f.status, note: f.note || '', resolved: f.resolved || false };
          submittedFlags.add(f.variation_id);
          if (!previousReviewerName && f.reviewer_name) previousReviewerName = f.reviewer_name;
        });
      } catch (e) { console.warn('Could not load flag feedback:', e); }
    }

    // ── Hole signs ─────────────────────────────────────────
    const hsCfg = project.holeSignConfig;
    if (hsCfg) {
      hsState = {
        background: hsCfg.colors?.background  || { type: 'color', color: '#1A3A6B' },
        topText:    hsCfg.colors?.topText      || { text: '', font: 'dm-serif', size: 300, color: '#FFFFFF' },
        bottomText: hsCfg.colors?.bottomText   || { text: '', font: 'dm-serif', size: 300, color: '#FFFFFF' },
      };
      hsVariations = hsCfg.variations || [];
      try {
        (await getFeedback(project.id, 'hole-signs')).forEach(f => {
          localHsFeedback[f.variation_id] = { status: f.status, note: f.note || '', resolved: f.resolved || false };
          submittedHs.add(f.variation_id);
          if (!previousReviewerName && f.reviewer_name) previousReviewerName = f.reviewer_name;
        });
      } catch (e) { console.warn('Could not load hole sign feedback:', e); }
    }

    renderPage(project);
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
      <span class="rv-status-badge approved">✓ Approved</span>
    </div>`;
  const thumbEl = card.querySelector('#rvct-' + v.id);
  if (thumbEl) renderInto(thumbEl, v.assignment, 'front');
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

// ── Hole sign card helpers ────────────────────────────────────────────────────

function collapseHsCard(card, v) {
  card.className = 'rv-card rv-approved rv-card-collapsed';
  card.innerHTML = `
    <div class="rv-collapsed-row">
      <div class="hs-rv-thumb" id="hscthumb-${v.id}"></div>
      <div class="rv-vname">${esc(v.name)}</div>
      <span class="rv-status-badge approved">✓ Approved</span>
    </div>`;
  const el = card.querySelector('#hscthumb-' + v.id);
  if (el && hsState) renderHoleSignInto(el, hsState, v);
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
        <div class="rv-instructions${instructionsClass}">${allApproved ? '<span class="rv-instructions-icon">✓</span>' : ''}${instructionsText}</div>
      </div>
      ${nameRow}

      ${hasFlags ? `
        ${hasHoleSigns ? '<div class="rv-section-title">🚩 Tournament Flags</div>' : ''}
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
        ${hasFlags ? '<div class="rv-section-title" style="margin-top:2.5rem">⛳ Hole Signs</div>' : ''}
        <div class="rv-variations" id="hsRvVariations"></div>
      ` : ''}

      ${allLocked ? '' : `
      <div class="rv-submit-row">
        <button class="rv-submit-btn" id="rvSubmit" onclick="submitReview()">Submit feedback →</button>
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

  const hasBack = Object.keys(v.backAssignment || {}).length > 0;
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
        <button class="rv-btn approve" id="rapprove-${v.id}">✓ Approve</button>
        <button class="rv-btn edits${effectiveStatus === 'needs_edits' ? ' active' : ''}" id="redits-${v.id}">✗ Request edits</button>
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
    renderInto(card.querySelector('#rvp-front-' + v.id), v.assignment, 'front');
    renderInto(card.querySelector('#rvp-back-'  + v.id), v.backAssignment || {}, 'back');
  } else {
    renderInto(card.querySelector('#rvp-' + v.id), v.assignment, 'front');
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
        <button class="rv-btn approve" id="hsapprove-${v.id}">✓ Approve</button>
        <button class="rv-btn edits${effectiveStatus === 'needs_edits' ? ' active' : ''}" id="hsedits-${v.id}">✗ Request edits</button>
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

  if (hsState) renderHoleSignInto(card.querySelector('#hsrvp-' + v.id), hsState, v);

  if (!isLocked) {
    card.querySelector('#hsapprove-' + v.id).addEventListener('click', () => {
      localHsFeedback[v.id] = { ...(localHsFeedback[v.id] || {}), status: 'approved' };
      collapseHsCard(card, v);
    });
    card.querySelector('#hsedits-' + v.id).addEventListener('click', () => {
      localHsFeedback[v.id] = { ...(localHsFeedback[v.id] || {}), status: 'needs_edits', resolved: false };
      card.querySelector('#hsedits-' + v.id).classList.add('active');
      card.querySelector('#hsapprove-' + v.id).classList.remove('active');
      card.querySelector('#hsnw-' + v.id).classList.add('visible');
      card.className = 'rv-card rv-needs-edits';
      card.querySelector('#hsnote-' + v.id)?.focus();
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
          <span class="rv-success-icon">✓</span>
          <div class="rv-success-title">Feedback submitted</div>
          <div class="rv-success-sub">The design team will review your feedback and be in touch shortly.</div>
        </div>
      </div>`;
  } catch (err) {
    console.error('Submit failed:', err);
    btn.textContent = 'Submit feedback →';
    btn.disabled = false;
    alert('Something went wrong submitting your feedback. Please try again.');
  }
};

init();
