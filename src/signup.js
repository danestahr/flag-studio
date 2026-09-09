import './icons.js';
import { signUp, getSession } from './supabase.js';
import { injectHeaderCta } from './auth.js';
import { renderSelectedThumb, templateName } from './template-gallery.js';
import { esc } from './dom-utils.js';
import { FLAGS } from './data.js';
import { loadAllFlags } from './svgLoader.js';

const params = new URLSearchParams(window.location.search);
const nextParam = params.get('next');
const galleryType = params.get('type');
const galleryTemplate = params.get('template');
// Present when resuming an Untitled draft (see login.js) - forwarded through
// so bouncing to "Sign in" instead doesn't lose it.
const galleryProject = params.get('project');
// Hole Signs arrives with just `type` and no `template` (see
// template-gallery.js) - still counts as a gallery selection.
const hasGallerySelection = !!galleryType || !!galleryProject;

// Arriving from the public template gallery: show the selected template as
// a preview in the split-right column, mirroring login.js - same markup/
// classes, same flag-SVG-loading requirement (see loadAllFlags below).
//
// Hole Signs never carries a specific templateId this far (no browse step -
// see template-gallery.js's onSelectType), so it falls back to the Standard
// template purely as placeholder art - cosmetic only, postAuthDest below
// still forwards the real (absent) galleryTemplate, leaving the actual
// choice to the hole-sign editor's own onboarding picker after auth.
const previewTemplate = galleryTemplate || (galleryType === 'hole-sign' ? 'hole-sign-1' : null);
if (galleryType && previewTemplate) {
  const aspect = galleryType === 'flag' ? '7519/4669' : '6375/5475';
  const rightContent = document.getElementById('splitRightContent');
  // No draft project exists yet on this page (it's only created once signed
  // in, on the event-info step - see gallery-side-panel.js), so there's
  // nothing to save here; the link just forwards galleryProject when a
  // signed-out visitor got here from an Untitled-draft resume link.
  const changeHref = `/?browse=1${galleryProject ? `&project=${galleryProject}` : ''}`;
  rightContent.innerHTML = `
    <div class="split-right-preview">
      <div class="split-right-thumb" id="splitRightThumb" style="aspect-ratio:${aspect}"></div>
      <div class="split-right-name">${esc(templateName(galleryType, previewTemplate))}</div>
      <a href="${esc(changeHref)}" class="split-right-change-link">${galleryType === 'hole-sign' ? 'Change Project' : 'Change Flag'}</a>
    </div>`;
  if (galleryType === 'flag') await loadAllFlags(FLAGS);
  renderSelectedThumb(document.getElementById('splitRightThumb'), galleryType, previewTemplate);
} else if (!hasGallerySelection) {
  // No template selection to preview - the split-right column would just be
  // showing a static tagline, so skip it and let the sign-up form take the
  // full width instead.
  document.querySelector('.split-right').style.display = 'none';
}

// A gallery selection (arrived here via login.html's "Create account" link)
// always routes back through login.html rather than straight to `/` -
// login.js's already-signed-in branch is what actually shows the event-info
// step, using the same selection preview it already renders in split-right.
function postAuthDest() {
  if (hasGallerySelection) {
    const fwd = new URLSearchParams();
    if (galleryType) fwd.set('type', galleryType);
    if (galleryTemplate) fwd.set('template', galleryTemplate);
    if (galleryProject) fwd.set('project', galleryProject);
    return `/login?${fwd}`;
  }
  return nextParam || '/';
}

// Already signed in → skip to dashboard
const existing = await getSession();
if (existing) {
  window.location.href = postAuthDest();
} else {
  injectHeaderCta('Sign In', '/login');
}

// Forward `next`/the gallery selection through to login.html, mirroring
// login.js's forward to here.
if (nextParam) {
  const loginLink = document.querySelector('.login-alt-link a[href="/login"]');
  if (loginLink) loginLink.href = `/login?next=${encodeURIComponent(nextParam)}`;
}
if (hasGallerySelection) {
  const loginLink = document.querySelector('.login-alt-link a[href="/login"]');
  const fwd = new URLSearchParams();
  if (galleryType) fwd.set('type', galleryType);
  if (galleryTemplate) fwd.set('template', galleryTemplate);
  if (galleryProject) fwd.set('project', galleryProject);
  if (loginLink) loginLink.href = `/login?${fwd}`;
}

const form      = document.getElementById('signupForm');
const btn       = document.getElementById('signupBtn');
const errEl     = document.getElementById('signupError');
const noteEl    = document.getElementById('signupNotice');
const headingEl = document.getElementById('signupHeading');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const firstName = document.getElementById('firstName').value.trim();
  const lastName  = document.getElementById('lastName').value.trim();
  const email     = document.getElementById('email').value.trim();
  const password  = document.getElementById('password').value;

  errEl.style.display  = 'none';
  noteEl.style.display = 'none';

  btn.disabled = true;
  btn.textContent = 'Creating account…';

  try {
    const { session } = await signUp(email, password, { firstName, lastName });
    if (session) {
      // Email confirmation is off — the account is immediately usable.
      window.location.href = postAuthDest();
    } else {
      // Email confirmation is required — no session yet.
      form.style.display = 'none';
      headingEl.textContent = 'Check your inbox';
      noteEl.textContent = `We've sent a confirmation email to ${email}. Open it and click the link inside to confirm your address and finish creating your account.`;
      noteEl.style.display = '';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Could not create account. Please try again.';
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = 'Create account';
  }
});
