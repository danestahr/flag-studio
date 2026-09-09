import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { esc, wrapEmailHtml, ctaButton, linkFallback, PLAIN_TEXT_FOOTER } from '../_shared/email-layout.ts';

// SENDGRID_API_KEY_2 is the current key; SENDGRID_API_KEY is kept as a fallback
// during rotation and can be removed once SENDGRID_API_KEY_2 is confirmed live everywhere.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

interface ProofPayload {
  contactName: string;
  contactEmail: string;
  eventName: string;
  reviewUrl: string;
}

function buildHtml(p: ProofPayload & { safeUrl: string }): string {
  const body = `<p style="margin:0 0 20px;color:#333;font-size:16px;">Hi ${esc(p.contactName)},</p>
      <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
        Your flag design proof for <strong>${esc(p.eventName)}</strong> is ready for your review. Click the button below to view your designs and leave feedback.
      </p>
      ${ctaButton(esc(p.safeUrl), 'View Design Proof')}
      ${linkFallback(esc(p.safeUrl))}
      <p style="margin:28px 0 0;color:#888;font-size:13px;line-height:1.6;">
        Once you've reviewed the design, you can approve it or request changes directly on the page. If you have any questions, just reply to this email.
      </p>`;
  return wrapEmailHtml({ title: 'Your Design Proof Is Ready', bodyHtml: body });
}

function buildText(p: ProofPayload & { safeUrl: string }): string {
  return [
    `Hi ${p.contactName},`,
    '',
    `Your flag design proof for ${p.eventName} is ready for your review.`,
    '',
    `View it here: ${p.safeUrl}`,
    '',
    `Once you've reviewed the design, you can approve it or request changes directly on the page. If you have any questions, just reply to this email.`,
    '',
    PLAIN_TEXT_FOOTER,
  ].join('\n');
}

async function tokenExists(token: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/projects?share_token=eq.${encodeURIComponent(token)}&select=id&limit=1`, {
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
    const payload: ProofPayload = await req.json();

    // reviewUrl must be https and contain a valid share token
    let safeUrl: string;
    try {
      const u = new URL(payload.reviewUrl);
      const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalhost)) {
        throw new Error('not https');
      }
      const token = u.searchParams.get('token');
      if (!token || !(await tokenExists(token))) {
        return new Response(JSON.stringify({ error: 'Invalid review link' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      safeUrl = u.toString();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid review URL' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
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
        subject: `Your flag design proof is ready — ${payload.eventName}`,
        content: [
          { type: 'text/plain', value: buildText({ ...payload, safeUrl }) },
          { type: 'text/html', value: buildHtml({ ...payload, safeUrl }) },
        ],
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
