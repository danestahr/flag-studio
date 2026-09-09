// The "what tournament is this for" step shown once a template's been
// selected in the public gallery (template-gallery.js) and the visitor has
// a session - used by login.html/signup.js's post-auth flow, in the
// split-left column (the thumbnail preview lives separately in split-right,
// see login.js/signup.js). landing.js always routes template selection
// through login.html rather than showing this step inline on index.html, so
// this is the only place it's rendered.
//
// The draft project is created (or, when resuming, loaded) the moment this
// step renders - not deferred until "Continue" - so that a visitor who backs
// out via "View all projects" without finishing still finds it waiting for
// them there as an Untitled draft (landing.js's projectCardHtml routes an
// Untitled project with a recorded intended_type/intended_template straight
// back to this same step instead of project.html's hub - see login.js's
// `project` param).
import { getMyProfile, createProject, updateProject, loadProject, uploadLogo, saveFlagConfig, loadFlagConfig, syncEventInfo } from './supabase.js';
import { renderEventFields, validateEventFields, attachEventFieldListeners, formatDate } from './intake-shared.js';
import { esc, scrollToFirstError } from './dom-utils.js';
import { FLAGS } from './data.js';
import { loadAllFlags } from './svgLoader.js';
import { DEFAULT_COLORS } from './state.js';
import { extractDominantColor } from './color-extract.js';

// Guards the async work below against a second call landing while an
// earlier one is still in flight (e.g. two selections in quick succession) -
// only the most recent call is allowed to render once it resolves.
let _renderToken = 0;

// Shown before renderEventInfoStep below, only for a brand-new event-info
// visit (no project yet — see login.js's showEventInfoStep, which skips
// this step entirely when resuming an existing draft). Lets a customer
// paste their GolfStatus event page URL to prefill the next step's fields
// and the flag's logo instead of typing everything in by hand.
// onDone(syncedInfo) fires with either the synced payload or null (skip, or
// give up after an error) - the caller is responsible for what happens next.
// headingEl is the step-title element living above the card (login.js's
// showEventInfoStep) - set once here rather than re-rendered by render()
// below, since it stays "Sync Event" through both the idle and syncing states.
export function renderSyncStep(container, { onDone, headingEl }) {
  const myToken = ++_renderToken;
  let url = '';
  let syncing = false;
  let errorMsg = '';

  if (headingEl) headingEl.textContent = 'Sync Event';

  function render() {
    if (myToken !== _renderToken) return;
    if (syncing) {
      container.innerHTML = `
        <div class="sync-spinner" aria-hidden="true"></div>
        <p class="sync-step-note" style="text-align:center;margin-top:.75rem">Pulling your event name, date, course, and logo from GolfStatus — this only takes a moment.</p>`;
      return;
    }
    container.innerHTML = `
      <div class="form-field">
        <label class="form-label" for="f-syncUrl">GolfStatus event URL</label>
        <input class="form-input" id="f-syncUrl" type="url" value="${esc(url)}" placeholder="https://events.golfstatus.com/..." autocomplete="off">
        ${errorMsg ? `<div class="form-error">${esc(errorMsg)}</div>` : ''}
      </div>
      <button type="button" class="btn primary" id="syncBtn" style="width:100%;justify-content:center;margin-top:.25rem">Continue</button>
      <p class="login-alt-link login-alt-link-outside" style="margin-top:.85rem"><a href="#" id="skipSyncLink">Fill Out Form Manually</a></p>`;

    const input = document.getElementById('f-syncUrl');
    input.addEventListener('input', e => { url = e.target.value; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); handleSync(); } });
    document.getElementById('syncBtn').addEventListener('click', handleSync);
    document.getElementById('skipSyncLink').addEventListener('click', e => { e.preventDefault(); onDone(null); });
  }

  async function handleSync() {
    if (!url.trim()) { errorMsg = 'Paste your GolfStatus event URL first.'; render(); scrollToFirstError(container); return; }
    errorMsg = '';
    syncing = true;
    render();
    try {
      const result = await syncEventInfo(url.trim());
      if (myToken !== _renderToken) return;
      onDone(result);
    } catch (err) {
      console.error('Event sync failed', err);
      if (myToken !== _renderToken) return;
      syncing = false;
      errorMsg = err.message || "We couldn't sync that event. Check the URL and try again.";
      render();
    }
  }

  render();
}

// Decodes the sync-event-info edge function's base64 logo, uploads it into
// the project's logo library, and seeds a first variation with it already
// placed in the template's logo zone - so the very first preview in
// Variations/Gallery already shows it instead of landing in the library for
// the customer to drag in themselves. A variation's placed-logo shape is
// { id, logoId, x, y, w } with x/y/w as percentages *within the zone's own
// bounding box* (render.js's makeSvg), not the flag canvas - x:50,y:50,w:80
// is exactly the default a fresh manual placement gets, and makeSvg only
// ever renders logoZones[0], so one placement is enough regardless of
// layout. (flag_config.base_assignment, by contrast, only feeds a legacy
// preview swatch in the Design step - it's not what Variations/Gallery/print
// actually render from, so it's deliberately left empty here.)
// Flags only (see plan) - hole signs use a different template-logo model
// this doesn't attempt to touch. Never throws: a failed logo sync shouldn't
// trap the customer on this screen when they still got their name/date/
// course and can add a logo by hand.
async function attachSyncedLogo(projectId, syncedInfo, templateId) {
  try {
    const contentType = syncedInfo.logoContentType || 'image/png';
    const dataUrl = `data:${contentType};base64,${syncedInfo.logoBase64}`;
    const bytes = Uint8Array.from(atob(syncedInfo.logoBase64), c => c.charCodeAt(0));
    const ext = contentType.split('/')[1]?.split('+')[0] || 'png';
    const file = new File([bytes], `tournament-logo.${ext}`, { type: contentType });
    const uploaded = await uploadLogo(projectId, file);

    await loadAllFlags(FLAGS);
    const flag = FLAGS.find(f => f.id === templateId);
    if (!flag?.logoZones?.length) return;

    const placement = { id: 'pl-' + Date.now(), logoId: uploaded.id, x: 50, y: 50, w: 80 };
    // zone-primary always stays white; zone-secondary is a best-effort
    // dominant-color suggestion from the logo itself, falling back to
    // DEFAULT_COLORS' black when the logo has no usable brand color to pull
    // out (e.g. a plain black wordmark).
    const dominant = flag.noColors ? null : await extractDominantColor(dataUrl).catch(() => null);

    await saveFlagConfig(projectId, {
      flagId: templateId,
      colors: dominant ? { 'zone-primary': '#FFFFFF', 'zone-secondary': dominant } : { ...DEFAULT_COLORS },
      baseAssignment: {},
      variations: [{ id: 'v' + Date.now(), name: 'Variation 1', logos: [placement], backLogos: [] }],
      sameLogoOnBothSides: true,
      logoLayout: 'single',
    });
  } catch (err) {
    console.error('Failed to attach synced logo', err);
  }
}

// If the customer picks a different template after a flag_config row
// already exists (e.g. "Change Flag" after syncing, or after starting
// design any other way), the editor's own init prefers the saved
// flagCfg.flag_id over a new ?template= URL param (src/flags/design.js -
// `if (!S.flagId) { ...templateParam... }`) - so without this, the newly
// chosen template would silently be ignored and the editor would reopen on
// whatever template was saved first. Retargets flag_id only; colors/
// variations/logos carry over untouched - a variation's logo placement is
// zone-relative percentages (not tied to a specific template), so it still
// lands correctly on the new template's own zone.
async function retargetFlagTemplate(projectId, newTemplateId) {
  try {
    const flagCfg = await loadFlagConfig(projectId);
    if (!flagCfg || flagCfg.flag_id === newTemplateId) return;
    const varData = flagCfg.variations || {};
    const varItems = Array.isArray(varData) ? varData : (varData.items || []);
    await saveFlagConfig(projectId, {
      flagId: newTemplateId,
      colors: flagCfg.colors || {},
      baseAssignment: flagCfg.base_assignment || {},
      variations: varItems,
      sameLogoOnBothSides: flagCfg.same_logo_on_both_sides ?? true,
      logoLayout: Array.isArray(varData) ? 'single' : (varData.layout || 'single'),
    });
  } catch (err) {
    console.error('Failed to retarget flag template', err);
  }
}

export async function renderEventInfoStep(container, { type, templateId, session, projectId, syncedInfo = null, headingEl }) {
  const myToken = ++_renderToken;
  if (headingEl) headingEl.textContent = 'Event Details';
  container.innerHTML = '<div class="tg-side-heading">Loading…</div>';

  let existingInfo = {};
  let isFreshProject = false;
  try {
    if (projectId) {
      // Resuming an Untitled draft - pull its recorded type/template back out
      // in case the caller didn't already have them (e.g. a bookmarked URL).
      const project = await loadProject(projectId);
      existingInfo = project.customer_info || {};
      type = type || existingInfo.intended_type;
      templateId = templateId || existingInfo.intended_template;
    } else {
      isFreshProject = true;
      projectId = await createProject('', { intended_type: type, intended_template: templateId });
    }
  } catch (err) {
    console.error('Failed to prepare draft project', err);
    if (myToken === _renderToken) {
      container.innerHTML = '<div class="tg-side-heading">Something went wrong loading your project. Please refresh and try again.</div>';
    }
    return;
  }
  if (myToken !== _renderToken) return; // superseded by a later call

  // Fire the relevant flag_config work in the background now that
  // projectId (and, on resume, templateId) are known, so the form below can
  // render immediately - handleContinue awaits whichever one fired before
  // navigating into the editor so the write is guaranteed to land first.
  let pendingFlagWork = null;
  if (isFreshProject && type === 'flag' && syncedInfo?.logoBase64) {
    pendingFlagWork = attachSyncedLogo(projectId, syncedInfo, templateId);
  } else if (!isFreshProject && type === 'flag' && templateId) {
    pendingFlagWork = retargetFlagTemplate(projectId, templateId);
  }

  let contactName = '';
  try {
    const profile = await getMyProfile(session.user.id);
    contactName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ');
  } catch { /* contact prefill is a nicety, not required */ }
  if (myToken !== _renderToken) return;

  const state = {
    eventName: existingInfo.event_name || syncedInfo?.eventName || '',
    courseName: existingInfo.course_name || syncedInfo?.courseName || '',
    eventDate: existingInfo.event_date || syncedInfo?.eventDate || '',
  };
  let errors = {};
  let submitting = false;

  // Contact name/email/shipping address aren't editable on this step (see
  // the customer/shipping form later in the funnel, intake-shared.js's
  // renderContactShippingFields, whose field-name convention this mirrors
  // exactly - see flags/gallery.js's submitContact init) - just seed them
  // once (contact from the logged-in account, address from the synced
  // event's round 1 course, when available) so that later step doesn't
  // start blank. Never overwrites a value already saved (e.g. one the
  // customer already edited there).
  function buildCustomerInfo() {
    return {
      ...existingInfo,
      intended_type: type,
      intended_template: templateId,
      event_name: state.eventName,
      course_name: state.courseName || null,
      event_date: state.eventDate,
      contact_name: existingInfo.contact_name || contactName || null,
      contact_email: existingInfo.contact_email || session.user.email || null,
      address_line1: existingInfo.address_line1 || syncedInfo?.courseAddressLine1 || null,
      address_line2: existingInfo.address_line2 || syncedInfo?.courseAddressLine2 || null,
      city: existingInfo.city || syncedInfo?.courseCity || null,
      state_province: existingInfo.state_province || syncedInfo?.courseState || null,
      postal_code: existingInfo.postal_code || syncedInfo?.coursePostalCode || null,
      country: existingInfo.country || syncedInfo?.courseCountry || null,
    };
  }

  function render() {
    if (myToken !== _renderToken) return;
    container.innerHTML = `
      ${renderEventFields(state, errors)}
      <button type="button" class="btn primary" id="tgEventInfoContinueBtn" style="width:100%;justify-content:center;margin-top:.25rem"${submitting ? ' disabled' : ''}>${submitting ? 'Creating…' : 'Customize Design'}</button>`;
    attachEventFieldListeners(container, state);
    document.getElementById('tgEventInfoContinueBtn').addEventListener('click', handleContinue);
  }

  async function handleContinue() {
    errors = validateEventFields(state);
    if (Object.keys(errors).length) { render(); scrollToFirstError(container); return; }
    errors = {};
    submitting = true;
    render();

    try {
      const projectName = state.eventName + ' — ' + formatDate(state.eventDate);
      await updateProject(projectId, { name: projectName, customer_info: buildCustomerInfo() });
      if (pendingFlagWork) await pendingFlagWork;
      const dest = type === 'hole-sign' ? '/hole-signs' : '/flags';
      const destParams = { project: projectId };
      if (templateId) destParams.template = templateId;
      window.location.href = `${dest}?${new URLSearchParams(destParams)}`;
    } catch (err) {
      console.error('Failed to save event info', err);
      submitting = false;
      render();
      alert('We couldn’t save your project. Please try again.');
    }
  }

  render();

  // Lets a caller persist whatever's currently typed before navigating away
  // mid-step (login.js's "Change Flag/Hole Sign" link in the split-right
  // column) - without this, switching templates before hitting Continue
  // would silently drop already-entered event details instead of resuming
  // with them.
  return {
    projectId,
    saveDraft: async () => {
      try {
        await updateProject(projectId, { customer_info: buildCustomerInfo() });
      } catch (err) {
        console.error('Failed to save draft event info', err);
      }
    },
  };
}
