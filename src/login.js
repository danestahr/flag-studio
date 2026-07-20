import './icons.js';
import { signIn, getSession } from './supabase.js';

// Already signed in → skip to dashboard
const existing = await getSession();
if (existing) {
  const next = new URLSearchParams(window.location.search).get('next') || '/';
  window.location.href = next;
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
    await signIn(email, password);
    const next = new URLSearchParams(window.location.search).get('next') || '/';
    window.location.href = next;
  } catch (err) {
    errEl.textContent = err.message || 'Sign in failed. Check your email and password.';
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});
