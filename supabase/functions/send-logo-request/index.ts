import { logEmail } from '../_shared/email-log.ts';
import { testRedirect } from '../_shared/test-to.ts';
import { isStaffOrAdminCaller } from '../_shared/caller-role.ts';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { esc, wrapEmailHtml, ctaButton, linkFallback, PLAIN_TEXT_FOOTER } from '../_shared/email-layout.ts';

// Staff-triggered "please upload your logos" email, sent to the customer once their order is
// submitted. Links to the public /upload-logos page (the same link the order confirmation and the
// approval reminders carry). Staff/admin only: the role is re-derived from the caller's JWT, the
// recipient comes from the order_intakes row, and the link is built from APP_URL - the browser
// supplies only { projectId }. Staff may request more than once (no once-only guard); each send is
// recorded in email_log (kind 'logo-request').

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL = Deno.env.get('APP_URL')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';
const KIND = 'logo-request';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
};
const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rest<T>(path: string): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`REST ${path} failed: ${res.status}`);
  return res.json();
}

type P = { name: string; eventName: string; uploadUrl: string };

function buildHtml(p: P): string {
  const body = `<p style="margin:0 0 20px;color:#333;font-size:16px;">Hi ${esc(p.name)},</p>
    <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
      Thanks for placing your order for <strong>${esc(p.eventName)}</strong>. To get your design started, we need your logos.
    </p>
    <p style="margin:0 0 8px;color:#555;font-size:15px;line-height:1.6;">
      Please upload your sponsor and event logos using the button below. Vector files (EPS, AI, SVG or PDF) work best, but PNG and JPG are fine too. You can come back to the same link to add more at any time.
    </p>
    ${ctaButton(esc(p.uploadUrl), 'Upload Your Logos')}
    ${linkFallback(esc(p.uploadUrl))}
    <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.6;">
      The link is personal to your order, so please don't share it. Questions? Just reply to this email.
    </p>`;
  return wrapEmailHtml({ title: 'Please Upload Your Logos', bodyHtml: body });
}

function buildText(p: P): string {
  return [
    `Hi ${p.name},`,
    '',
    `Thanks for placing your order for ${p.eventName}. To get your design started, we need your logos.`,
    '',
    'Please upload your sponsor and event logos using the link below. Vector files (EPS, AI, SVG or PDF) work best, but PNG and JPG are fine too. You can come back to the same link to add more at any time.',
    '',
    `Upload your logos: ${p.uploadUrl}`,
    '',
    "The link is personal to your order, so please don't share it. Questions? Just reply to this email.",
    '',
    PLAIN_TEXT_FOOTER,
  ].join('\n');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    if (!(await isStaffOrAdminCaller(req.headers.get('Authorization')))) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: JSON_HEADERS });
    }
    const { projectId, testTo } = await req.json();
    if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
      return new Response(JSON.stringify({ error: 'Invalid project' }), { status: 400, headers: JSON_HEADERS });
    }

    const [intake] = await rest<{ contact_name: string; contact_email: string; event_name: string; submitted_at: string | null }>(
      `order_intakes?project_id=eq.${projectId}&select=contact_name,contact_email,event_name,submitted_at&limit=1`,
    );
    if (!intake?.contact_email) {
      return new Response(JSON.stringify({ error: 'No contact email on this order' }), { status: 400, headers: JSON_HEADERS });
    }
    if (!intake.submitted_at) {
      return new Response(JSON.stringify({ error: "The order hasn't been submitted yet" }), { status: 409, headers: JSON_HEADERS });
    }

    const uploadUrl = `${APP_URL.replace(/\/$/, '')}/upload-logos?project=${projectId}`;
    const payload: P = { name: intake.contact_name, eventName: intake.event_name, uploadUrl };
    const target = testRedirect(testTo, intake.contact_email);

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: target.to, name: intake.contact_name }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        tracking_settings: { click_tracking: { enable: false } },
        subject: `${target.prefix}Please upload your logos — ${intake.event_name}`,
        content: [
          { type: 'text/plain', value: buildText(payload) },
          { type: 'text/html', value: buildHtml(payload) },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('SendGrid error', res.status, body);
      await logEmail({ kind: KIND, projectId, recipient: intake.contact_email, ok: false, httpStatus: res.status, error: body });
      return new Response(JSON.stringify({ error: 'SendGrid failed', status: res.status }), { status: 500, headers: JSON_HEADERS });
    }

    await logEmail({ kind: KIND, projectId, recipient: intake.contact_email, ok: true, httpStatus: res.status });
    return new Response(JSON.stringify({ ok: true, recipient: target.to }), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: JSON_HEADERS });
  }
});
