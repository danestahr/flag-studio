import './landing.css';
import './icons.js';
import { requireAuth } from './auth.js';
import { getMyProfile, updateMyProfile, updateMyEmail, updatePassword } from './supabase.js';

const session = await requireAuth();
const userId = session.user.id;

const avatarEl   = document.getElementById('profileAvatar');
const firstEl    = document.getElementById('firstName');
const lastEl     = document.getElementById('lastName');
const emailEl    = document.getElementById('email');
const passwordEl = document.getElementById('password');
const form       = document.getElementById('profileForm');
const btn        = document.getElementById('profileSaveBtn');
const errEl      = document.getElementById('profileError');
const noticeEl   = document.getElementById('profileNotice');

function updateAvatar() {
  const initials = ((firstEl.value[0] || '') + (lastEl.value[0] || '')).toUpperCase() || (session.user.email || '?')[0].toUpperCase();
  avatarEl.textContent = initials;
}

const profile = await getMyProfile(userId);
firstEl.value = profile.first_name || '';
lastEl.value = profile.last_name || '';
emailEl.value = session.user.email || '';
updateAvatar();

firstEl.addEventListener('input', updateAvatar);
lastEl.addEventListener('input', updateAvatar);

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  errEl.style.display = 'none';
  noticeEl.style.display = 'none';

  const firstName = firstEl.value.trim();
  const lastName = lastEl.value.trim();
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  const emailChanged = email !== (session.user.email || '');

  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await updateMyProfile(userId, { firstName, lastName });
    if (emailChanged) await updateMyEmail(email);
    if (password) await updatePassword(password);

    const notices = [];
    if (emailChanged) notices.push(`We've sent a confirmation link to ${email} — your email won't change until you click it.`);
    if (password) notices.push('Your password has been updated, and any other signed-in sessions were signed out.');
    noticeEl.textContent = notices.length ? notices.join(' ') : 'Your profile has been updated.';
    noticeEl.style.display = '';
    passwordEl.value = '';
  } catch (err) {
    errEl.textContent = err.message || 'Could not save your changes. Please try again.';
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
});
