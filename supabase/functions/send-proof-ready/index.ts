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

interface ProofPayload {
  contactName: string;
  contactEmail: string;
  eventName: string;
  reviewUrl: string;
}

function buildHtml(p: ProofPayload & { safeUrl: string }): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:32px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
    <div style="background:#1a1a2e;padding:28px 32px;">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:600;">Your Design Proof Is Ready</h1>
      <p style="color:#aaa;margin:6px 0 0;font-size:14px;">Flag Studio</p>
    </div>
    <div style="padding:32px;">
      <p style="margin:0 0 20px;color:#333;font-size:16px;">Hi ${esc(p.contactName)},</p>
      <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
        Your flag design proof for <strong>${esc(p.eventName)}</strong> is ready for your review. Click the button below to view your designs and leave feedback.
      </p>

      <div style="text-align:center;margin:32px 0;">
        <a href="${esc(p.safeUrl)}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
          View Design Proof →
        </a>
      </div>

      <p style="margin:0 0 8px;color:#888;font-size:13px;">Or copy this link:</p>
      <p style="margin:0;font-size:12px;color:#aaa;word-break:break-all;background:#f8f8f8;padding:10px 12px;border-radius:6px;font-family:monospace;">${esc(p.safeUrl)}</p>

      <p style="margin:28px 0 0;color:#888;font-size:13px;line-height:1.6;">
        Once you've reviewed the design, you can approve it or request changes directly on the page. If you have any questions, just reply to this email.
      </p>
    </div>
    <div style="padding:20px 32px;background:#fafafa;border-top:1px solid #f0f0f0;">
      <p style="margin:0;color:#bbb;font-size:12px;">Flag Studio · dane@danestahr.com</p>
    </div>
  </div>
</body>
</html>`;
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
        content: [{ type: 'text/html', value: buildHtml({ ...payload, safeUrl }) }],
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
