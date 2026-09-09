import './icons.js';
import { supabase, updatePassword } from './supabase.js';
import { injectHeaderCta } from './auth.js';

// No session-aware branching here (unlike the other auth pages) — the only
// session this page ever sees is the transient PASSWORD_RECOVERY one
// exchanged from the recovery-email link below, not a normal signed-in
// state, so there's nothing meaningful to show besides a way back to sign in.
injectHeaderCta('Log in', '/login');

const form        = document.getElementById('resetForm');
const btn         = document.getElementById('resetBtn');
const errEl       = document.getElementById('resetError');
const noteEl      = document.getElementById('resetNotice');
const verifyingEl = document.getElementById('resetVerifying');

// This page only makes sense reached via the recovery-email link, which
// supabase-js exchanges for a session and reports as a PASSWORD_RECOVERY
// auth event. Anyone landing here any other way (typed URL, bookmark, a
// stale/no session) never gets that event, so the form stays hidden and
// they're bounced to request a fresh link instead.
let verified = false;

supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    verified = true;
    verifyingEl.style.display = 'none';
    form.style.display = '';
  }
});

setTimeout(() => {
  if (!verified) {
    window.location.href = '/';
  }
}, 2000);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password        = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  errEl.style.display = 'none';

  if (password !== confirmPassword) {
    errEl.textContent = 'Passwords do not match.';
    errEl.style.display = '';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Updating…';

  try {
    await updatePassword(password);
    form.style.display = 'none';
    noteEl.textContent = 'Your password has been updated.';
    noteEl.style.display = '';
    setTimeout(() => { window.location.href = '/'; }, 1500);
  } catch (err) {
    // Same non-enumerating instinct as the claim flow: don't describe *why*
    // it failed (expired vs. already used vs. no session at all) — just that
    // the link no longer works.
    errEl.textContent = 'This link is invalid or has expired. Request a new one from the sign-in page.';
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = 'Update password';
  }
});
