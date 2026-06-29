import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL = 'dane@danestahr.com';
const FROM_NAME = 'GolfStatus Design Studio';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function safeHex(h: unknown): string {
  return /^#[0-9A-Fa-f]{3,6}$/.test(String(h)) ? String(h) : '#cccccc';
}

interface Shipping {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  country: string;
}

interface OrderPayload {
  contactName: string;
  contactEmail: string;
  courseName?: string;
  eventName: string;
  eventDate: string;
  shipping?: Shipping;
  flagStyle: string;
  flagColors: Array<{ name: string; hex: string }>;
  flagSetup?: string;
  flagQty?: number;
  designNotes?: string;
  logoFileNames?: string[];
  projectId: string;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ── Approval deadline ─────────────────────────────────────
// Deadline = 17 days before the event.
// If that date falls on a Saturday, Sunday, or Monday → roll back to the preceding Friday.
function calcApprovalDeadline(eventDateIso: string): { iso: string; display: string } | null {
  if (!eventDateIso) return null;
  const [y, m, d] = eventDateIso.split('-').map(Number);
  const event = new Date(y, m - 1, d);
  const deadline = new Date(event);
  deadline.setDate(deadline.getDate() - 17);

  const dow = deadline.getDay(); // 0=Sun, 1=Mon, 6=Sat
  if (dow === 6) deadline.setDate(deadline.getDate() - 1);      // Sat → Fri
  else if (dow === 0) deadline.setDate(deadline.getDate() - 2); // Sun → Fri
  else if (dow === 1) deadline.setDate(deadline.getDate() - 3); // Mon → Fri

  const iso = deadline.toISOString().slice(0, 10);
  const display = deadline.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return { iso, display };
}

function daysUntil(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function formatShipping(s: Shipping | undefined): string {
  if (!s) return '—';
  return [
    s.addressLine1,
    s.addressLine2 || '',
    [s.city, s.stateProvince, s.postalCode].filter(Boolean).join(', '),
    s.country === 'CA' ? 'Canada' : 'USA',
  ].filter(Boolean).map(esc).join('<br>');
}

function formatSetup(s: string | undefined): string {
  if (s === 'different') return 'Different front &amp; back';
  if (s === 'same') return 'Same front &amp; back';
  return '—';
}

function buildHtml(p: OrderPayload): string {
  const deadline = calcApprovalDeadline(p.eventDate);
  const days = deadline ? daysUntil(deadline.iso) : null;
  const isUrgent = days !== null && days <= 21;

  const deadlineColor = isUrgent ? '#b45309' : '#1A4A2E';
  const deadlineBg    = isUrgent ? '#fffbeb' : '#f0f7f2';
  const deadlineBorder = isUrgent ? '#fcd34d' : '#a7d7b8';

  const row = (label: string, value: string, opts: { vtop?: boolean } = {}) =>
    value
      ? `<tr>
           <td style="padding:9px 0;color:#888;font-size:13px;border-top:1px solid #f0f0f0;white-space:nowrap;${opts.vtop ? 'vertical-align:top;' : ''}">${label}</td>
           <td style="padding:9px 0 9px 20px;font-size:14px;color:#111;border-top:1px solid #f0f0f0;">${value}</td>
         </tr>`
      : '';

  const colorRows = (p.flagColors ?? []).filter(Boolean).map(c =>
    row('', `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${safeHex(c.hex)};vertical-align:middle;margin-right:7px;border:1px solid #ddd;"></span>${esc(c.name)} <span style="color:#aaa;font-size:12px;">${safeHex(c.hex)}</span>`)
  ).join('');

  const logoFiles = (p.logoFileNames ?? []).filter(Boolean);

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:32px 16px;">
<div style="max-width:580px;margin:0 auto;">

  <!-- Header -->
  <div style="background:#1A4A2E;border-radius:12px 12px 0 0;padding:28px 32px;">
    <p style="margin:0 0 4px;color:rgba(255,255,255,.55);font-size:12px;text-transform:uppercase;letter-spacing:.08em;">GolfStatus Design Studio</p>
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:600;">Order Confirmed</h1>
  </div>

  <!-- Body -->
  <div style="background:#fff;padding:32px;">
    <p style="margin:0 0 24px;color:#333;font-size:15px;line-height:1.6;">
      Hi ${esc(p.contactName)}, thanks for submitting your order! We've received everything and will be in touch once your proof is ready for review.
    </p>

    ${deadline ? `
    <!-- Approval Deadline Callout -->
    <div style="border:1.5px solid ${deadlineBorder};background:${deadlineBg};border-radius:8px;padding:18px 20px;margin-bottom:28px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:${deadlineColor};">
        ${isUrgent ? '⚠ ' : ''}Artwork Approval Deadline
      </p>
      <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:${deadlineColor};">${esc(deadline.display)}</p>
      <p style="margin:0;font-size:13px;color:#666;line-height:1.5;">
        Final artwork must be approved by this date to avoid rush fees. This is 17 days before your event${
          esc(deadline.display).includes('Friday') ? ' — adjusted to the preceding Friday because the 17-day mark fell on a weekend or Monday' : ''
        }.
      </p>
    </div>` : ''}

    <!-- Order Summary -->
    <h2 style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#aaa;">Order Summary</h2>

    <table style="width:100%;border-collapse:collapse;margin-top:8px;">

      <tr><td colspan="2" style="padding:6px 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#bbb;">Event</td></tr>
      ${row('Event name', esc(p.eventName))}
      ${p.courseName ? row('Course', esc(p.courseName)) : ''}
      ${row('Date', esc(formatDate(p.eventDate)))}

      <tr><td colspan="2" style="padding:14px 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#bbb;">Contact &amp; Shipping</td></tr>
      ${row('Name', esc(p.contactName))}
      ${row('Email', esc(p.contactEmail))}
      ${row('Ship to', formatShipping(p.shipping), { vtop: true })}

      <tr><td colspan="2" style="padding:14px 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#bbb;">Design</td></tr>
      ${row('Flag style', `<span style="text-transform:capitalize;">${esc(p.flagStyle)}</span>`)}
      ${colorRows}
      ${row('Setup', formatSetup(p.flagSetup))}
      ${p.flagQty ? row('Quantity', `${esc(String(p.flagQty))} flag${p.flagQty === 1 ? '' : 's'}`) : ''}
      ${p.designNotes ? row('Notes', esc(p.designNotes), { vtop: true }) : ''}

      ${logoFiles.length ? `
      <tr><td colspan="2" style="padding:14px 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#bbb;">Logos</td></tr>
      <tr>
        <td colspan="2" style="padding:4px 0;border-top:1px solid #f0f0f0;">
          <ul style="margin:0;padding-left:18px;color:#555;font-size:14px;">
            ${logoFiles.map(n => `<li style="padding:2px 0;">${esc(n)}</li>`).join('')}
          </ul>
        </td>
      </tr>` : ''}
    </table>

    <p style="margin:28px 0 0;color:#999;font-size:13px;line-height:1.6;">
      You'll receive another email when your proof is ready. If you have questions, just reply to this email.
    </p>
  </div>

  <!-- Footer -->
  <div style="padding:16px 32px;background:#f9f9f9;border-radius:0 0 12px 12px;border-top:1px solid #eee;">
    <p style="margin:0;color:#ccc;font-size:12px;">GolfStatus Design Studio &middot; dane@danestahr.com</p>
  </div>

</div>
</body>
</html>`;
}

async function projectExists(projectId: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=id&limit=1`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const payload: OrderPayload = await req.json();

    if (!payload.projectId || !(await projectExists(payload.projectId))) {
      return new Response(JSON.stringify({ error: 'Invalid project' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    if (!payload.contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.contactEmail)) {
      return new Response(JSON.stringify({ error: 'Invalid email' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: payload.contactEmail, name: payload.contactName }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        subject: `Order confirmed — ${payload.eventName}`,
        content: [{ type: 'text/html', value: buildHtml(payload) }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('SendGrid error', res.status, body);
      return new Response(JSON.stringify({ error: 'SendGrid failed', status: res.status }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
