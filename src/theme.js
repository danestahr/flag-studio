// Light/dark override. With no saved choice the CSS follows the OS
// (prefers-color-scheme); a saved choice sets <html data-theme> which the
// stylesheets' :root blocks key off. The same one-liner also runs inline in
// each page's <head> so the theme is applied before first paint.
const KEY = 'fs-theme';

function saved() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function effectiveTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* storage blocked — session-only */ }
}

const initial = saved();
if (initial === 'light' || initial === 'dark') document.documentElement.dataset.theme = initial;

// Header button: shows the mode you'd switch TO (sun while dark, moon while light).
export function createThemeToggle() {
  const btn = document.createElement('button');
  btn.className = 'theme-toggle-btn';
  btn.type = 'button';
  btn.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,.35);color:rgba(255,255,255,.75);width:30px;height:30px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;padding:0;flex-shrink:0';
  const render = () => {
    const dark = effectiveTheme() === 'dark';
    btn.innerHTML = `<i class="fa-solid ${dark ? 'fa-sun' : 'fa-moon'}" aria-hidden="true"></i>`;
    btn.title = btn.ariaLabel = dark ? 'Switch to light mode' : 'Switch to dark mode';
  };
  btn.addEventListener('click', () => {
    applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
    render();
  });
  render();
  return btn;
}
