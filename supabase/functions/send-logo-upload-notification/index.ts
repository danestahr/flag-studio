import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { esc, wrapEmailHtml, ctaButton, linkFallback, PLAIN_TEXT_FOOTER } from '../_shared/email-layout.ts';

// Internal notification (design@gsds.space) fired when a customer uploads
// logos to their project via the public /upload-logos page after their order
// has already been submitted — see send-order-notification for the sibling
// internal notification fired at order-submit time. Kept as its own function
// (rather than folding into send-order-notification) since the trigger point,
// payload shape, and subject line are all different, and a SendGrid failure
// here should never affect the order-time notification path.

// SENDGRID_API_KEY_2 is the current key; SENDGRID_API_KEY is kept as a fallback
// during rotation and can be removed once SENDGRID_API_KEY_2 is confirmed live everywhere.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';
const TO_EMAIL = 'design@gsds.space';
const TO_NAME = 'Dane';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

interface LogoUploadPayload {
  projectId: string;
  eventName?: string;
  logoFileNames: string[];
  projectUrl: string;
}

function buildHtml(p: LogoUploadPayload & { safeProjectUrl: string }): string {
  const body = `<p style="margin:0 0 24px;color:#333;font-size:15px;line-height:1.6;">
      A customer just uploaded ${p.logoFileNames.length} new logo${p.logoFileNames.length === 1 ? '' : 's'} to
      ${p.eventName ? `<strong>${esc(p.eventName)}</strong>` : 'their project'} via the public upload link.
    </p>

    ${ctaButton(esc(p.safeProjectUrl), 'View Project')}
    ${linkFallback(esc(p.safeProjectUrl))}

    <h2 style="margin:28px 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#aaa;">New Logos</h2>
    <ul style="margin:8px 0 0;padding-left:18px;color:#555;font-size:14px;">
      ${p.logoFileNames.map(n => `<li style="padding:2px 0;">${esc(n)}</li>`).join('')}
    </ul>`;

  return wrapEmailHtml({ title: 'New Logos Uploaded', bodyHtml: body });
}

function buildText(p: LogoUploadPayload & { safeProjectUrl: string }): string {
  const lines = [
    `A customer just uploaded ${p.logoFileNames.length} new logo${p.logoFileNames.length === 1 ? '' : 's'} to ${p.eventName || 'their project'} via the public upload link.`,
    '',
    `View project: ${p.safeProjectUrl}`,
    '',
    'NEW LOGOS',
    ...p.logoFileNames.map(n => `- ${n}`),
    '',
    PLAIN_TEXT_FOOTER,
  ];

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
    const payload: LogoUploadPayload = await req.json();

    if (!payload.projectId || !(await projectExists(payload.projectId))) {
      return new Response(JSON.stringify({ error: 'Invalid project' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    if (!Array.isArray(payload.logoFileNames) || !payload.logoFileNames.length) {
      return new Response(JSON.stringify({ error: 'No logo file names provided' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
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
        tracking_settings: { click_tracking: { enable: false } },
        subject: `New logos uploaded — ${payload.eventName || 'project'}`,
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
