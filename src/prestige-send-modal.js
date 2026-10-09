// In-page replacement for window.confirm() on every "send to Prestige" action.
// Self-contained (inline styles, built on demand) because the pages that send
// to Prestige don't all load the same modal CSS. Resolves true on Send, false
// on Cancel / Esc / backdrop click.
export function confirmPrestigeSend() {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px';
    backdrop.innerHTML = `
      <div role="dialog" aria-modal="true" style="background:var(--white,#fff);color:var(--black,#111);border-radius:12px;padding:2rem;width:100%;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,.18)">
        <div style="font-family:'DM Serif Display',serif;font-size:22px;margin-bottom:.75rem">Ready to Print?</div>
        <div style="font-size:13px;color:var(--gray-500);margin-bottom:20px">Send print files and order summary to Prestige Flag.</div>
        <div style="display:flex;justify-content:flex-end;gap:.75rem">
          <button type="button" class="btn" data-act="cancel">Cancel</button>
          <button type="button" class="btn primary" data-act="send">Send</button>
        </div>
      </div>`;

    const done = ok => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(ok);
    };
    const onKey = e => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) done(false); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener('click', () => done(false));
    backdrop.querySelector('[data-act="send"]').addEventListener('click', () => done(true));
    document.body.appendChild(backdrop);
    backdrop.querySelector('[data-act="send"]').focus();
  });
}
