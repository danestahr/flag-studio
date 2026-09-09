import './icons.js';
import './order.css'; // .form-field/.btn classes, needed by the event-info step below
import { signIn, getSession, loadLogosForProject, loadFlagConfig } from './supabase.js';
import { initHeaderForSession, injectHeaderCta } from './auth.js';
import { renderSelectedThumb, overlayLogoOnThumb, templateName } from './template-gallery.js';
import { renderEventInfoStep, renderSyncStep } from './gallery-side-panel.js';
import { extractDominantColor } from './color-extract.js';
import { esc } from './dom-utils.js';
import { FLAGS } from './data.js';
import { loadAllFlags } from './svgLoader.js';

const params = new URLSearchParams(window.location.search);
const nextParam = params.get('next');
const galleryType = params.get('type');
const galleryTemplate = params.get('template');
// Present when resuming an Untitled draft from the project list (see
// landing.js's projectCardHtml) - renderEventInfoStep updates this project
// instead of creating a new one.
const galleryProject = params.get('project');
// Hole Signs arrives with just `type` and no `template` (see
// template-gallery.js) - still counts as a gallery selection.
const hasGallerySelection = !!galleryType || !!galleryProject;
// Set once the event-info step renders (showEventInfoStep below) - lets the
// split-right "Change Flag/Hole Sign" link save whatever's currently typed
// before sending the visitor back to the template browser. Stays null while
// the plain sign-in form is showing, since there's no draft yet to save.
let eventInfoHandle = null;

async function handleChangeTemplate(e) {
  e.preventDefault();
  let url = '/?browse=1';
  if (eventInfoHandle) {
    await eventInfoHandle.saveDraft();
    url += `&project=${eventInfoHandle.projectId}`;
  }
  window.location.href = url;
}

// Arriving from the public template gallery (landing.js's onTemplateSelect,
// or forwarded here from signup.js): show the selected template as a
// preview in the split-right column, replacing the static tagline, for the
// whole flow - through sign-in and into the event-info step below. Only
// possible when type/template are known up front - a bare ?project= with
// neither (an unlikely hand-edited URL) skips the preview but still works,
// since renderEventInfoStep derives them from the project itself.
//
// Hole Signs never carries a specific templateId this far (no browse step -
// see template-gallery.js's onSelectType), so it falls back to the Standard
// template purely as placeholder art, so this still reads as a real
// selection instead of a blank panel. Cosmetic only: `galleryTemplate`
// itself stays null, so showEventInfoStep below still leaves the real
// template choice to the hole-sign editor's own onboarding picker
// (hs/design.js) once signed in.
const previewTemplate = galleryTemplate || (galleryType === 'hole-sign' ? 'hole-sign-1' : null);
if (galleryType && previewTemplate) {
  const aspect = galleryType === 'flag' ? '7519/4669' : '6375/5475';
  const rightContent = document.getElementById('splitRightContent');
  rightContent.innerHTML = `
    <div class="split-right-preview">
      <div class="split-right-thumb" id="splitRightThumb" style="aspect-ratio:${aspect}"></div>
      <div class="split-right-name">${esc(templateName(galleryType, previewTemplate))}</div>
      <a href="/?browse=1" class="split-right-change-link" id="changeTemplateLink">${galleryType === 'hole-sign' ? 'Change Project' : 'Change Flag'}</a>
    </div>`;
  document.getElementById('changeTemplateLink').addEventListener('click', handleChangeTemplate);
  // Flag templates render from FLAGS[i].svgContent, populated by
  // loadAllFlags() - the gallery grid (template-gallery.js) always loads
  // this before a card becomes clickable, but a visitor lands here directly
  // (no grid on this page), so it has to happen here too. Hole-sign
  // templates need no equivalent fetch - renderHoleSignInto builds them
  // straight from data already in hole-sign-data.js.
  if (galleryType === 'flag') await loadAllFlags(FLAGS);
  renderSelectedThumb(document.getElementById('splitRightThumb'), galleryType, previewTemplate);

  // Resuming an existing draft (e.g. back via "Change Flag" after an
  // earlier GolfStatus sync) - show whatever was already synced/saved
  // instead of reverting to a plain default-colored preview. Fire-and-forget:
  // a nice-to-have refinement of the preview already rendered above, not
  // worth blocking the rest of page setup on.
  if (galleryType === 'flag' && galleryProject) {
    Promise.all([loadLogosForProject(galleryProject), loadFlagConfig(galleryProject)])
      .then(([logos, flagCfg]) => {
        if (logos?.[0]) overlayLogoOnThumb(document.getElementById('splitRightThumb'), previewTemplate, logos[0].src, flagCfg?.colors || null);
      })
      .catch(err => console.error('Failed to restore synced preview', err));
  }
} else if (!hasGallerySelection) {
  // No template selection to preview - the split-right column would just be
  // showing a static tagline, so skip it and let the sign-in form take the
  // full width instead.
  document.querySelector('.split-right').style.display = 'none';
}

async function finishEventInfoStep(session, syncedInfo) {
  // Fire-and-forget: updates the split-right preview to show the synced
  // logo (and a suggested color scheme extracted from it) right away,
  // without delaying the event-info form below from rendering. Primary
  // always stays white; only secondary is the logo's most common color.
  if (syncedInfo?.logoBase64 && galleryType === 'flag') {
    const dataUrl = `data:${syncedInfo.logoContentType || 'image/png'};base64,${syncedInfo.logoBase64}`;
    extractDominantColor(dataUrl)
      .then(color => overlayLogoOnThumb(
        document.getElementById('splitRightThumb'), galleryTemplate, dataUrl,
        color ? { 'zone-primary': '#FFFFFF', 'zone-secondary': color } : null,
      ))
      .catch(err => console.error('Failed to preview synced logo', err));
  }
  eventInfoHandle = await renderEventInfoStep(document.getElementById('eventInfoCard'), { type: galleryType, templateId: galleryTemplate, session, projectId: galleryProject, syncedInfo, headingEl: document.getElementById('sideStepHeading') });
}

// Placed to the left of the header's profile avatar (injected by
// auth.js's injectHeaderActions into `.header-actions`, which by then
// already exists) rather than below the event-info/sync card, since this
// screen is the one place in the app the header's normal nav is otherwise
// empty. Scoped to login.js's own header rather than a shared auth.js
// change - the rest of the app doesn't need it in the header.
function injectViewProjectsLink() {
  const wrap = document.querySelector('header .header-actions');
  if (!wrap || wrap.querySelector('.header-view-projects-link')) return;
  const link = document.createElement('a');
  link.className = 'header-view-projects-link';
  link.href = '/';
  link.textContent = 'View Projects';
  wrap.insertBefore(link, wrap.firstChild);
}

async function showEventInfoStep(session) {
  injectViewProjectsLink();
  const left = document.getElementById('splitLeftContent');
  // The step title (e.g. "Sync Event"/"Event Details") lives above the
  // card rather than inside it, as its own page-level heading.
  left.innerHTML = '<div class="side-step-heading" id="sideStepHeading"></div><div class="login-card" id="eventInfoCard"></div>';
  const card = document.getElementById('eventInfoCard');
  const headingEl = document.getElementById('sideStepHeading');
  if (galleryProject) {
    // Resuming an existing Untitled draft - already got past sync-or-skip
    // once, so don't ask again.
    eventInfoHandle = await renderEventInfoStep(card, { type: galleryType, templateId: galleryTemplate, session, projectId: galleryProject, headingEl });
  } else {
    renderSyncStep(card, { headingEl, onDone: (syncedInfo) => finishEventInfoStep(session, syncedInfo) });
  }
}

// Already signed in → skip straight past the login form. With a gallery
// selection, that means the event-info step (right here, not a redirect);
// otherwise the normal next-destination redirect. Either way, the login
// form below is never shown, so its listener setup is skipped too -
// showEventInfoStep() already replaced #splitLeftContent's DOM, and the
// redirect branch is leaving the page entirely.
const existing = await getSession();
if (existing) {
  await initHeaderForSession(existing);
} else if (!hasGallerySelection) {
  // With a gallery selection, this header CTA would hard-code '/signup'
  // with no type/template/project - losing the selection the alt-link below
  // the form correctly forwards (see the signupLink.href fixup further
  // down). Simplest fix: don't show it at all on this arrival.
  injectHeaderCta('Get Started', '/signup');
}

if (existing) {
  if (hasGallerySelection) {
    await showEventInfoStep(existing);
  } else {
    window.location.href = nextParam || '/';
  }
}

if (!existing) {
  // Forward `next` through to signup.html so a visitor bounced here with a
  // pending destination (e.g. from a locked page's requireAuth() redirect)
  // doesn't lose it by switching to "Sign up" instead of signing in.
  if (nextParam) {
    const signupLink = document.querySelector('.login-alt-link-outside a[href="/signup"]');
    if (signupLink) signupLink.href = `/signup?next=${encodeURIComponent(nextParam)}`;
  }
  // Same idea for a gallery selection - signup.js forwards back to this page
  // afterward (see signup.js), where the already-signed-in branch above
  // picks up the event-info step.
  if (hasGallerySelection) {
    const signupLink = document.querySelector('.login-alt-link-outside a[href="/signup"]');
    const fwd = new URLSearchParams();
    if (galleryType) fwd.set('type', galleryType);
    if (galleryTemplate) fwd.set('template', galleryTemplate);
    if (galleryProject) fwd.set('project', galleryProject);
    if (signupLink) signupLink.href = `/signup?${fwd}`;
  }

  const form  = document.getElementById('loginForm');
  const btn   = document.getElementById('loginBtn');
  const errEl = document.getElementById('loginError');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const { session } = await signIn(email, password);
      if (hasGallerySelection) {
        await showEventInfoStep(session);
      } else {
        window.location.href = nextParam || '/';
      }
    } catch (err) {
      errEl.textContent = err.message || 'Sign in failed. Check your email and password.';
      errEl.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}
