// Shared HTML chrome for every transactional email this project sends via
// SendGrid (send-order-confirmation, send-order-notification, send-proof-ready,
// send-print-sheet-ready, send-prestige-order, send-review-decision). Keeps the
// header/footer/button/footer-text in exactly one place so a branding tweak
// doesn't require editing every function.
//
// Not used by supabase/templates/*.html — those are Supabase Auth's own
// dashboard-pasted templates (a separate rendering system, see the comment at
// the top of each of those files) but are styled to match this same layout.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function wrapEmailHtml(opts: { title: string; bodyHtml: string }): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:32px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
    <div style="background:#1a1a2e;padding:28px 32px;">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:600;">${opts.title}</h1>
      <p style="color:#aaa;margin:6px 0 0;font-size:14px;">GolfStatus Design Studio</p>
    </div>
    <div style="padding:32px;">
      ${opts.bodyHtml}
    </div>
    <div style="padding:20px 32px;background:#fafafa;border-top:1px solid #f0f0f0;">
      <p style="margin:0;color:#bbb;font-size:12px;">GolfStatus Design Studio &middot; design@gsds.space<br>8545 S 78th St, Lincoln, NE 68516</p>
    </div>
  </div>
</body>
</html>`;
}

export function ctaButton(href: string, label: string): string {
  return `<div style="text-align:center;margin:32px 0;">
        <a href="${href}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
          ${label} &rarr;
        </a>
      </div>`;
}

export function linkFallback(url: string): string {
  return `<p style="margin:0 0 8px;color:#888;font-size:13px;">Or copy this link:</p>
      <p style="margin:0;font-size:12px;color:#aaa;word-break:break-all;background:#f8f8f8;padding:10px 12px;border-radius:6px;font-family:monospace;">${url}</p>`;
}

export const PLAIN_TEXT_FOOTER = [
  'GolfStatus Design Studio',
  'design@gsds.space',
  '8545 S 78th St, Lincoln, NE 68516',
].join('\n');
