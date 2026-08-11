import './icons.js';
import { updatePassword } from './supabase.js';

const form    = document.getElementById('resetForm');
const btn     = document.getElementById('resetBtn');
const errEl   = document.getElementById('resetError');
const noteEl  = document.getElementById('resetNotice');

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
