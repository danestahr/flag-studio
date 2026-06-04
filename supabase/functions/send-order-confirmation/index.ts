import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL = 'dane@danestahr.com';
const FROM_NAME = 'Flag Studio';

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

function formatShipping(s: Shipping | undefined): string {
  if (!s) return '';
  const lines = [
    s.addressLine1,
    s.addressLine2 || '',
    [s.city, s.stateProvince, s.postalCode].filter(Boolean).join(', '),
    s.country === 'CA' ? 'Canada' : 'USA',
  ].filter(Boolean);
  return lines.map(esc).join('<br>');
}

function formatSetup(s: string | undefined): string {
  if (s === 'different') return 'Different front &amp; back';
  if (s === 'same') return 'Same front &amp; back';
  return '';
}

function buildHtml(p: OrderPayload): string {
  const row = (label: string, value: string, opts: { mono?: boolean; vtop?: boolean } = {}) =>
    `<tr><td style="padding:8px 0;color:#666;border-top:1px solid #f0f0f0;${opts.vtop ? 'vertical-align:top;' : ''}">${label}</td><td style="padding:8px 0 8px 16px;border-top:1px solid #f0f0f0;${opts.mono ? "font-family:'SF Mono',Menlo,monospace;font-size:13px;" : ''}">${value}</td></tr>`;

  const colorRows = p.flagColors.map(c =>
    row('Color', `<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${safeHex(c.hex)};vertical-align:middle;margin-right:6px;border:1px solid #ddd;"></span>${esc(c.name)} (${safeHex(c.hex)})`)
  ).join('');

  const shippingHtml = p.shipping
    ? row('Ship to', formatShipping(p.shipping), { vtop: true })
    : '';

  const setupHtml = p.flagSetup
    ? row('Setup', formatSetup(p.flagSetup))
    : '';

  const qtyHtml = p.flagQty
    ? row('Quantity', `${esc(String(p.flagQty))} flag${p.flagQty === 1 ? '' : 's'}`)
    : '';

  const logoFiles = (p.logoFileNames ?? []).filter(Boolean);
  const logosHtml = logoFiles.length
    ? row(
        'Logos',
        '<ul style="margin:0;padding-left:18px;color:#555;">' +
          logoFiles.map(n => `<li style="padding:2px 0;">${esc(n)}</li>`).join('') +
        '</ul>',
        { vtop: true },
      )
    : '';

  const notesHtml = p.designNotes
    ? row('Notes', esc(p.designNotes), { vtop: true })
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:32px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
    <div style="background:#1a1a2e;padding:28px 32px;">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:600;">Order Received</h1>
      <p style="color:#aaa;margin:6px 0 0;font-size:14px;">Flag Studio</p>
    </div>
    <div style="padding:32px;">
      <p style="margin:0 0 20px;color:#333;font-size:16px;">Hi ${esc(p.contactName)},</p>
      <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
        Thanks for submitting your flag order! We've received everything and will be in touch once your design is ready for review.
      </p>

      <h2 style="margin:0 0 16px;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#999;">Order Summary</h2>
      <table style="width:100%;border-collapse:collapse;font-size:15px;">
        ${row('Event', esc(p.eventName))}
        ${row('Date', esc(formatDate(p.eventDate)))}
        ${shippingHtml}
        ${row('Flag Style', `<span style="text-transform:capitalize;">${esc(p.flagStyle)}</span>`)}
        ${colorRows}
        ${setupHtml}
        ${qtyHtml}
        ${logosHtml}
        ${notesHtml}
      </table>

      <p style="margin:28px 0 0;color:#888;font-size:13px;line-height:1.6;">
        You'll receive another email when your design proof is ready. If you have any questions, just reply to this email.
      </p>
    </div>
    <div style="padding:20px 32px;background:#fafafa;border-top:1px solid #f0f0f0;">
      <p style="margin:0;color:#bbb;font-size:12px;">Flag Studio · dane@danestahr.com</p>
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  try {
    const payload: OrderPayload = await req.json();

    // Verify the project actually exists before sending any email
    if (!payload.projectId || !(await projectExists(payload.projectId))) {
      return new Response(JSON.stringify({ error: 'Invalid project' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // Basic email format check
    if (!payload.contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.contactEmail)) {
      return new Response(JSON.stringify({ error: 'Invalid email' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: payload.contactEmail, name: payload.contactName }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        subject: `Your flag order is confirmed — ${payload.eventName}`,
        content: [{ type: 'text/html', value: buildHtml(payload) }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('SendGrid error', res.status, body);
      return new Response(JSON.stringify({ error: 'SendGrid request failed', status: res.status }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
