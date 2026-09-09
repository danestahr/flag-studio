import './icons.js';
import { resetPasswordForEmail, getSession } from './supabase.js';
import { initHeaderForSession, injectHeaderCta } from './auth.js';

const session = await getSession();
if (session) {
  await initHeaderForSession(session);
} else {
  injectHeaderCta('Log in', '/login');
}

const form  = document.getElementById('resetRequestForm');
const btn   = document.getElementById('resetRequestBtn');
const noteEl = document.getElementById('resetRequestNotice');

// Deliberately shows the exact same message whether or not the email has an
// account, and even on unexpected errors — branching copy on "found"/"not
// found" is an account-enumeration leak, and Supabase's own API is already
// designed not to reveal that distinction.
const GENERIC_MESSAGE = "If that email has an account, we've sent a reset link to it.";

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();

  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    await resetPasswordForEmail(email);
  } catch (err) {
    // Swallow the error deliberately — see GENERIC_MESSAGE comment above.
  }

  form.style.display = 'none';
  noteEl.textContent = GENERIC_MESSAGE;
  noteEl.style.display = '';
});
