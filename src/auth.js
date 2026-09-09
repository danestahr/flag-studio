import { getSession, signOut, supabase, claimMyProjects, getMyRole } from './supabase.js';

export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/login?next=${encodeURIComponent(returnTo)}`;
    await new Promise(() => {}); // halt execution while redirecting
  }
  await initHeaderForSession(session);
  return session;
}

// The session-established side effects requireAuth() runs after confirming
// a session exists - split out so a page that supports BOTH an anonymous and
// an authenticated view (landing.js's public template gallery) can run these
// only in the authenticated branch, without duplicating requireAuth()'s
// redirect-when-absent logic.
export async function initHeaderForSession(session) {
  injectHeaderActions(session);
  watchForSignOut();
  // Best-effort: attach any anonymously-submitted orders under this account's
  // own email. Never blocks page load on failure - this is a background
  // reconciliation, not a critical path.
  claimMyProjects().catch((err) => console.error('claimMyProjects failed', err));
}

// Anonymous-visitor equivalent of injectHeaderActions() below - a single CTA
// anchor instead of the avatar/sign-out group, since there's no session to
// act on. Callers pick their own label/destination for "the other action" a
// visitor on that particular page might want (e.g. "Sign in" from the public
// gallery, "Get Started" from the sign-in form itself).
export function injectHeaderCta(label, href) {
  const header = document.querySelector('header');
  if (!header || header.querySelector('.header-actions')) return;

  const wrap = document.createElement('div');
  wrap.className = 'header-actions';

  const cta = document.createElement('a');
  cta.className = 'header-cta-btn';
  cta.href = href;
  cta.textContent = label;
  wrap.appendChild(cta);

  header.appendChild(wrap);
}

// UI-convenience gate only - the real boundary is DB-level (RLS / this
// project's storage policies), never this check alone. Callers use it to
// hide/show privileged actions (e.g. emailing a print-ready file link), not
// to decide whether an operation is actually allowed.
export async function isStaffOrAdmin(session) {
  if (!session) return false;
  try {
    const role = await getMyRole(session.user.id);
    return role === 'staff' || role === 'admin';
  } catch {
    return false;
  }
}

// Opt-in, only reached via requireAuth() — order.js/review.js never call
// requireAuth() and so never attach this, since both must keep working with
// no session at all. Catches this tab getting signed out from elsewhere: a
// sign-out in another tab (supabase-js broadcasts auth state across tabs), or
// this session getting revoked by a password reset's signOut({scope:'others'})
// on another device.
function watchForSignOut() {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      window.location.href = '/login';
    }
  });
}

// Header only ever had the logo/back-link group as its one child (CSS pushes
// it left, everything else right via justify-content:space-between) — a
// second bare child would land mid-header instead of alongside it, so both
// the avatar link and sign-out button share one wrapper.
function injectHeaderActions(session) {
  const header = document.querySelector('header');
  if (!header || header.querySelector('.header-actions')) return;

  const wrap = document.createElement('div');
  wrap.className = 'header-actions';
  wrap.style.cssText = 'display:flex;align-items:center;gap:14px';

  const avatar = document.createElement('a');
  avatar.className = 'account-avatar';
  avatar.href = '/profile';
  avatar.title = 'Your profile';
  avatar.textContent = (session.user.email || '?').slice(0, 2).toUpperCase();
  wrap.appendChild(avatar);

  const btn = document.createElement('button');
  btn.className = 'sign-out-btn';
  btn.textContent = 'Sign out';
  btn.addEventListener('click', async () => {
    await signOut();
    window.location.href = '/login';
  });
  wrap.appendChild(btn);

  header.appendChild(wrap);
}
