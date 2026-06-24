import { getSession, signOut } from './supabase.js';

export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/login.html?next=${encodeURIComponent(returnTo)}`;
    await new Promise(() => {}); // halt execution while redirecting
  }
  injectSignOutButton();
  return session;
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
