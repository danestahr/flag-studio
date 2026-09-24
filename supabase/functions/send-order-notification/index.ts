import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { esc, wrapEmailHtml, ctaButton, linkFallback, PLAIN_TEXT_FOOTER } from '../_shared/email-layout.ts';

// Internal notification (dane@danestahr.com) fired when a customer submits an
// order via /orders — see send-review-decision for the sibling internal
// notification fired on client proof decisions. Deliberately a separate
// function from send-order-confirmation (which emails the customer) rather
// than folding this into it, so a SendGrid failure on one side never blocks
// the other and each has its own independent recipient/subject/content.

// SENDGRID_API_KEY_2 is the current key; SENDGRID_API_KEY is kept as a fallback
// during rotation and can be removed once SENDGRID_API_KEY_2 is confirmed live everywhere.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';
const TO_EMAIL = 'dane@danestahr.com';
const TO_NAME = 'Dane';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

function safeHex(h: unknown): string {
  return /^#[0-9A-Fa-f]{3,6}$/.test(String(h)) ? String(h) : '#cccccc';
}

// Customer-entered (the GolfStatus event URL pasted into the sync pre-step) —
// only allow it into an href if it actually parses as http(s), same reasoning
// as safeHex above.
function safeUrl(u: unknown): string | null {
  const s = String(u ?? '').trim();
  if (!s) return null;
  try {
    const parsed = new URL(s);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

interface Shipping {
  attn?: string;
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
  eventUrl?: string;
  shipping?: Shipping;
  flagStyle: string;
  flagStyleName?: string;
  flagPreviewUrl?: string;
  flagColors: Array<{ name: string; hex: string; label?: string; zone?: string }>;
  flagSetup?: string;
  flagQty?: number;
  designNotes?: string;
  frontDesignNotes?: string;
  backDesignNotes?: string;
  logoFileNames?: string[];
  projectId: string;
  projectUrl: string;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatShipping(s: Shipping | undefined): string {
  if (!s) return '—';
  return [
    s.attn ? `ATTN: ${s.attn}` : '',
    s.addressLine1,
    s.addressLine2 || '',
    [s.city, s.stateProvince, s.postalCode].filter(Boolean).join(', '),
    s.country === 'CA' ? 'Canada' : 'USA',
  ].filter(Boolean).map(esc).join('<br>');
}

function formatSetup(s: string | undefined): string {
  if (s === 'different') return 'Different Front &amp; Back';
  if (s === 'same') return 'Same Front &amp; Back';
  return '—';
}

function buildHtml(p: OrderPayload & { safeProjectUrl: string }): string {
  const row = (label: string, value: string, opts: { vtop?: boolean } = {}) =>
    value
      ? `<tr>
           <td style="padding:9px 0;color:#888;font-size:13px;border-top:1px solid #f0f0f0;white-space:nowrap;${opts.vtop ? 'vertical-align:top;' : ''}">${label}</td>
           <td style="padding:9px 0 9px 20px;font-size:14px;color:#111;border-top:1px solid #f0f0f0;">${value}</td>
         </tr>`
      : '';

  const colorRows = (p.flagColors ?? []).filter(Boolean).filter(c => c.zone !== 'zone-border').map(c =>
    row(c.label ? esc(c.label) : '', `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${safeHex(c.hex)};vertical-align:middle;margin-right:7px;border:1px solid #ddd;"></span>${esc(c.name)} <span style="color:#aaa;font-size:12px;">${safeHex(c.hex)}</span>`)
  ).join('');

  const logoFiles = (p.logoFileNames ?? []).filter(Boolean);
  const previewUrl = safeUrl(p.flagPreviewUrl);

  const body = `<p style="margin:0 0 24px;color:#333;font-size:15px;line-height:1.6;">
      A new order was just submitted by <strong>${esc(p.contactName)}</strong> for <strong>${esc(p.eventName)}</strong>.
    </p>

    ${ctaButton(esc(p.safeProjectUrl), 'View Project')}
    ${linkFallback(esc(p.safeProjectUrl))}

    <!-- Order Summary -->
    <h2 style="margin:28px 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#aaa;">Order Summary</h2>

    <table style="width:100%;border-collapse:collapse;margin-top:8px;">

      <tr><td colspan="2" style="padding:6px 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#bbb;">Event Details</td></tr>
      ${row('Event Name', esc(p.eventName))}
      ${p.courseName ? row('Course Name', esc(p.courseName)) : ''}
      ${row('Event Date', esc(formatDate(p.eventDate)))}
      ${(() => {
        const url = safeUrl(p.eventUrl);
        return url ? row('Event URL', `<a href="${esc(url)}" style="color:#1a1a2e;">${esc(url)}</a>`) : '';
      })()}

      <tr><td colspan="2" style="padding:14px 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#bbb;">Contact &amp; Shipping</td></tr>
      ${row('Full Name', esc(p.contactName))}
      ${row('Email', esc(p.contactEmail))}
      ${row('Address', formatShipping(p.shipping), { vtop: true })}

      <tr><td colspan="2" style="padding:14px 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#bbb;">Flag &amp; Colors</td></tr>
      ${previewUrl ? `
      <tr>
        <td colspan="2" style="padding:10px 0 0;border-top:1px solid #f0f0f0;">
          <img src="${esc(previewUrl)}" alt="${esc(p.flagStyleName || p.flagStyle)}" style="display:block;width:100%;max-width:100%;height:auto;border-radius:8px;border:1px solid #eee;">
        </td>
      </tr>` : ''}
      ${colorRows}
      ${row('Flag', esc(p.flagStyleName || p.flagStyle))}
      ${p.flagQty ? row('Quantity', `${esc(String(p.flagQty))} Flag${p.flagQty === 1 ? '' : 's'}`) : ''}
      ${row('Flag Setup', formatSetup(p.flagSetup))}
      ${p.designNotes ? row('Flag Design', esc(p.designNotes), { vtop: true }) : ''}
      ${p.frontDesignNotes ? row('Flag Design - Front', esc(p.frontDesignNotes), { vtop: true }) : ''}
      ${p.backDesignNotes ? row('Flag Design - Back', esc(p.backDesignNotes), { vtop: true }) : ''}

      ${logoFiles.length ? `
      <tr><td colspan="2" style="padding:14px 0 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#bbb;">Logos</td></tr>
      <tr>
        <td colspan="2" style="padding:4px 0;border-top:1px solid #f0f0f0;">
          <ul style="margin:0;padding-left:18px;color:#555;font-size:14px;">
            ${logoFiles.map(n => `<li style="padding:2px 0;">${esc(n)}</li>`).join('')}
          </ul>
        </td>
      </tr>` : ''}
    </table>`;

  return wrapEmailHtml({ title: 'New Order Submitted', bodyHtml: body });
}

function buildText(p: OrderPayload & { safeProjectUrl: string }): string {
  const lines = [
    `A new order was just submitted by ${p.contactName} for ${p.eventName}.`,
    '',
    `View project: ${p.safeProjectUrl}`,
    '',
    'ORDER SUMMARY', '',
  ];

  lines.push('EVENT DETAILS');
  lines.push(`Event Name: ${p.eventName}`);
  if (p.courseName) lines.push(`Course Name: ${p.courseName}`);
  lines.push(`Event Date: ${formatDate(p.eventDate)}`);
  if (safeUrl(p.eventUrl)) lines.push(`Event URL: ${p.eventUrl!.trim()}`);
  lines.push('');

  lines.push('CONTACT & SHIPPING');
  lines.push(`Full Name: ${p.contactName}`, `Email: ${p.contactEmail}`);
  if (p.shipping) {
    const s = p.shipping;
    const addrLines = [s.attn ? `ATTN: ${s.attn}` : '', s.addressLine1, s.addressLine2, [s.city, s.stateProvince, s.postalCode].filter(Boolean).join(', '), s.country === 'CA' ? 'Canada' : 'USA']
      .filter(Boolean);
    lines.push('Address:', ...addrLines.map(l => `  ${l}`));
  }
  lines.push('');

  lines.push('FLAG & COLORS');
  const textColors = (p.flagColors ?? []).filter(c => c.zone !== 'zone-border');
  if (textColors.length) lines.push(`Colors: ${textColors.map(c => c.label ? `${c.label}: ${c.name}` : c.name).join(', ')}`);
  lines.push(`Flag: ${p.flagStyleName || p.flagStyle}`);
  if (p.flagQty) lines.push(`Quantity: ${p.flagQty} Flag${p.flagQty === 1 ? '' : 's'}`);
  if (p.flagSetup) lines.push(`Flag Setup: ${p.flagSetup === 'different' ? 'Different Front & Back' : 'Same Front & Back'}`);
  if (p.designNotes) lines.push(`Flag Design: ${p.designNotes}`);
  if (p.frontDesignNotes) lines.push(`Flag Design - Front: ${p.frontDesignNotes}`);
  if (p.backDesignNotes) lines.push(`Flag Design - Back: ${p.backDesignNotes}`);
  if (p.logoFileNames?.length) lines.push('', 'LOGOS', ...p.logoFileNames.map(n => `- ${n}`));

  lines.push('', PLAIN_TEXT_FOOTER);

  return lines.join('\n');
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

    let safeProjectUrl: string;
    try {
      const u = new URL(payload.projectUrl);
      const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalhost)) {
        throw new Error('not https');
      }
      safeProjectUrl = u.toString();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid project URL' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: TO_EMAIL, name: TO_NAME }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        subject: `New order submitted — ${payload.eventName}`,
        content: [
          { type: 'text/plain', value: buildText({ ...payload, safeProjectUrl }) },
          { type: 'text/html', value: buildHtml({ ...payload, safeProjectUrl }) },
        ],
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
