import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { esc, wrapEmailHtml, ctaButton, linkFallback, PLAIN_TEXT_FOOTER } from '../_shared/email-layout.ts';

// SENDGRID_API_KEY_2 is the current key; SENDGRID_API_KEY is kept as a fallback
// during rotation, matching send-proof-ready/send-order-confirmation.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';
const BUCKET = 'print-sheets';
// 7 days, hardcoded - never accepted from the client. The client only ever
// supplies WHAT to send and WHO to send it to; how long the link lives is a
// policy decision that must be enforced in exactly one place.
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Never trust a client-asserted role - resolve it from the caller's own
// token, the same way RLS resolves auth.uid() from the request's JWT.
async function getCallerRole(authHeader: string): Promise<string | null> {
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: authHeader },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;

  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  if (!profileRes.ok) return null;
  const rows = await profileRes.json();
  return rows?.[0]?.role ?? null;
}

async function projectExists(projectId: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=id&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

function buildHtml(p: { recipientName: string; eventName: string; productLabel: string; signedUrl: string }): string {
  const body = `<p style="margin:0 0 20px;color:#333;font-size:16px;">Hi ${esc(p.recipientName)},</p>
      <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
        The print-ready ${esc(p.productLabel)} files for <strong>${esc(p.eventName)}</strong> are ready to download. This link expires in 7 days.
      </p>
      ${ctaButton(esc(p.signedUrl), 'Download Files')}
      ${linkFallback(esc(p.signedUrl))}`;
  return wrapEmailHtml({ title: 'Print-Ready Files Are Ready', bodyHtml: body });
}

function buildText(p: { recipientName: string; eventName: string; productLabel: string; signedUrl: string }): string {
  return [
    `Hi ${p.recipientName},`,
    '',
    `The print-ready ${p.productLabel} files for ${p.eventName} are ready to download. This link expires in 7 days.`,
    '',
    `Download: ${p.signedUrl}`,
    '',
    PLAIN_TEXT_FOOTER,
  ].join('\n');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing auth' }, 401);

    const role = await getCallerRole(authHeader);
    if (role !== 'staff' && role !== 'admin') return json({ error: 'Forbidden' }, 403);

    const payload = await req.json();
    const { projectId, storagePath, recipientEmail, recipientName, eventName, productType } = payload;

    if (!projectId || !(await projectExists(projectId))) return json({ error: 'Invalid project' }, 400);

    // Defense in depth: staff/admin already have blanket visibility, but a
    // tampered/foreign path should never be emailed out under this
    // project's name.
    if (typeof storagePath !== 'string' || !storagePath.startsWith(`${projectId}/`)) {
      return json({ error: 'Invalid storage path' }, 400);
    }
    if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      return json({ error: 'Invalid email' }, 400);
    }
    if (productType !== 'flags' && productType !== 'hole-signs') {
      return json({ error: 'Invalid productType' }, 400);
    }

    const signRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
      },
    );
    if (!signRes.ok) {
      console.error('sign failed', signRes.status, await signRes.text());
      return json({ error: 'Could not sign URL' }, 500);
    }
    const { signedURL } = await signRes.json();
    const fullUrl = `${SUPABASE_URL}/storage/v1${signedURL}`;

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: recipientEmail, name: recipientName || recipientEmail }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        subject: `Print-ready ${productType === 'hole-signs' ? 'hole sign' : 'flag'} files — ${eventName || 'your event'}`,
        content: [
          {
            type: 'text/plain',
            value: buildText({
              recipientName: recipientName || recipientEmail,
              eventName: eventName || 'your event',
              productLabel: productType === 'hole-signs' ? 'hole sign' : 'flag',
              signedUrl: fullUrl,
            }),
          },
          {
            type: 'text/html',
            value: buildHtml({
              recipientName: recipientName || recipientEmail,
              eventName: eventName || 'your event',
              productLabel: productType === 'hole-signs' ? 'hole sign' : 'flag',
              signedUrl: fullUrl,
            }),
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('SendGrid error', res.status, body);
      return json({ error: 'SendGrid request failed', status: res.status, detail: body }, 500);
    }

    return json({ ok: true }, 200);
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
