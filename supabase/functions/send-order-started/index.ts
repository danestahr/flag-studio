import { logEmail } from '../_shared/email-log.ts';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { esc, wrapEmailHtml, ctaButton, linkFallback, PLAIN_TEXT_FOOTER } from '../_shared/email-layout.ts';

// Customer-facing "your order has been started" email, fired once when the
// order form's Step 2 is completed (see order.js saveStartedOrder). Carries the
// resume link so they can finish the order from any device. The sibling
// internal email is send-order-notification with stage: 'started'.
//
// The browser sends only { projectId }. Recipient, name and event come from the
// order_intakes row and the link is built from APP_URL, so an anonymous caller
// can't use this to email an arbitrary address or put an arbitrary link in it.

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL = Deno.env.get('APP_URL')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';
const KIND = 'order-started';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
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

function formatDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function buildHtml(p: { name: string; eventName: string; eventDate: string; resumeUrl: string }): string {
  const body = `<p style="margin:0 0 20px;color:#333;font-size:16px;">Hi ${esc(p.name)},</p>
    <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
      Thanks for starting your order for <strong>${esc(p.eventName)}</strong>${p.eventDate ? ` (${esc(formatDate(p.eventDate))})` : ''}.
      We've saved your event and shipping details, and our team can already see your order.
    </p>
    <p style="margin:0 0 8px;color:#555;font-size:15px;line-height:1.6;">
      You haven't submitted it yet. Pick up where you left off any time, on any device, using the button below. Your changes are saved to the same order.
    </p>
    ${ctaButton(esc(p.resumeUrl), 'Continue Your Order')}
    ${linkFallback(esc(p.resumeUrl))}
    <p style="margin:24px 0 0;color:#888;font-size:13px;line-height:1.6;">
      Keep this email handy. The link is personal to your order, so please don't share it. Questions? Just reply to this email.
    </p>`;
  return wrapEmailHtml({ title: 'Your Order Has Been Started', bodyHtml: body });
}

function buildText(p: { name: string; eventName: string; eventDate: string; resumeUrl: string }): string {
  return [
    `Hi ${p.name},`,
    '',
    `Thanks for starting your order for ${p.eventName}${p.eventDate ? ` (${formatDate(p.eventDate)})` : ''}. We've saved your event and shipping details, and our team can already see your order.`,
    '',
    "You haven't submitted it yet. Pick up where you left off any time, on any device, using the link below. Your changes are saved to the same order.",
    '',
    `Continue your order: ${p.resumeUrl}`,
    '',
    "The link is personal to your order, so please don't share it. Questions? Just reply to this email.",
    '',
    PLAIN_TEXT_FOOTER,
  ].join('\n');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { projectId } = await req.json();
    if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
      return new Response(JSON.stringify({ error: 'Invalid project' }), { status: 400, headers: JSON_HEADERS });
    }

    const [intake] = await rest<{ contact_name: string; contact_email: string; event_name: string; event_date: string; submitted_at: string | null }>(
      `order_intakes?project_id=eq.${projectId}&select=contact_name,contact_email,event_name,event_date,submitted_at&limit=1`,
    );
    // Nothing to resume once it's submitted (or if the intake doesn't exist).
    if (!intake || intake.submitted_at) {
      return new Response(JSON.stringify({ error: 'Invalid project' }), { status: 403, headers: JSON_HEADERS });
    }

    // Send at most once per project, so a replayed call can't spam the customer.
    const already = await rest<{ id: string }>(`email_log?project_id=eq.${projectId}&kind=eq.${KIND}&status=eq.sent&select=id&limit=1`);
    if (already.length) {
      return new Response(JSON.stringify({ ok: true, skipped: 'already-sent' }), { status: 200, headers: JSON_HEADERS });
    }

    const resumeUrl = `${APP_URL.replace(/\/$/, '')}/order?resume=${projectId}`;
    const payload = { name: intake.contact_name, eventName: intake.event_name, eventDate: intake.event_date, resumeUrl };

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: intake.contact_email, name: intake.contact_name }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        tracking_settings: { click_tracking: { enable: false } },
        subject: `Your order has been started — ${intake.event_name}`,
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
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: JSON_HEADERS });
  }
});
