import { getSession, signOut, supabase, claimMyProjects, getMyRole } from './supabase.js';

export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/login.html?next=${encodeURIComponent(returnTo)}`;
    await new Promise(() => {}); // halt execution while redirecting
  }
  injectHeaderActions(session);
  watchForSignOut();
  // Best-effort: attach any anonymously-submitted orders under this account's
  // own email. Never blocks page load on failure - this is a background
  // reconciliation, not a critical path.
  claimMyProjects().catch((err) => console.error('claimMyProjects failed', err));
  return session;
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
      window.location.href = '/login.html';
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
  avatar.href = '/profile.html';
  avatar.title = 'Your profile';
  avatar.textContent = (session.user.email || '?').slice(0, 2).toUpperCase();
  wrap.appendChild(avatar);

  const btn = document.createElement('button');
  btn.className = 'sign-out-btn';
  btn.textContent = 'Sign out';
  btn.addEventListener('click', async () => {
    await signOut();
    window.location.href = '/login.html';
  });
  wrap.appendChild(btn);

  header.appendChild(wrap);
}
