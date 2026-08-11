import { getSession, signOut, supabase, claimMyProjects } from './supabase.js';

export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/login.html?next=${encodeURIComponent(returnTo)}`;
    await new Promise(() => {}); // halt execution while redirecting
  }
  injectSignOutButton();
  watchForSignOut();
  // Best-effort: attach any anonymously-submitted orders under this account's
  // own email. Never blocks page load on failure - this is a background
  // reconciliation, not a critical path.
  claimMyProjects().catch((err) => console.error('claimMyProjects failed', err));
  return session;
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

function injectSignOutButton() {
  const header = document.querySelector('header');
  if (!header || header.querySelector('.sign-out-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'sign-out-btn';
  btn.textContent = 'Sign out';
  btn.addEventListener('click', async () => {
    await signOut();
    window.location.href = '/login.html';
  });
  header.appendChild(btn);
}
