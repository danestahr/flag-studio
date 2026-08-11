import './icons.js';
import { signUp, getSession } from './supabase.js';

// Already signed in → skip to dashboard
const existing = await getSession();
if (existing) {
  window.location.href = '/';
}

const form    = document.getElementById('signupForm');
const btn     = document.getElementById('signupBtn');
const errEl   = document.getElementById('signupError');
const noteEl  = document.getElementById('signupNotice');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const firstName       = document.getElementById('firstName').value.trim();
  const lastName        = document.getElementById('lastName').value.trim();
  const email           = document.getElementById('email').value.trim();
  const password        = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  errEl.style.display  = 'none';
  noteEl.style.display = 'none';

  if (password !== confirmPassword) {
    errEl.textContent = 'Passwords do not match.';
    errEl.style.display = '';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating account…';

  try {
    const { session } = await signUp(email, password, { firstName, lastName });
    if (session) {
      // Email confirmation is off — the account is immediately usable.
      window.location.href = '/';
    } else {
      // Email confirmation is required — no session yet.
      form.style.display = 'none';
      noteEl.textContent = `We've sent a confirmation link to ${email}. Click it to finish creating your account.`;
      noteEl.style.display = '';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Could not create account. Please try again.';
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = 'Create account';
  }
});
