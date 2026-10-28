import { logEmail } from '../_shared/email-log.ts';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { wrapEmailHtml, esc } from '../_shared/email-layout.ts';

// SendGrid Event Webhook receiver. SendGrid returns 202 the moment it accepts a
// message, so a rejection by the recipient's server (e.g. Prestige's 554 5.7.1
// dns_rbl block) only shows up later as a `bounce`/`dropped` event. This turns
// those events for the Prestige order email into an internal alert, and a
// `delivered` event into a confirmation so we know it actually arrived.
//
// Deploy with --no-verify-jwt (SendGrid can't send a Supabase JWT) and set the
// Event Webhook URL to  <project>/functions/v1/sendgrid-events?token=<SENDGRID_WEBHOOK_TOKEN>
// with Delivered, Deferred, Bounced and Dropped ticked. Auth is that shared token.

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const WEBHOOK_TOKEN = Deno.env.get('SENDGRID_WEBHOOK_TOKEN');
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';
const ALERT_TO = 'design@gsds.space';
const PRESTIGE_KIND = 'prestige-order';
// Problems need action; `delivered` is the success confirmation. `deferred` is
// SendGrid's temporary failure (it keeps retrying), flagged early so a stuck
// send isn't a surprise. processed/open/click are ignored as noise.
const PROBLEM_EVENTS = new Set(['bounce', 'dropped', 'deferred', 'blocked']);
const TRACKED_EVENTS = new Set([...PROBLEM_EVENTS, 'delivered']);

interface SgEvent {
  event?: string;
  email?: string;
  reason?: string;
  status?: string;
  timestamp?: number;
  kind?: string;       // custom_args set in send-prestige-order
  project_id?: string;
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!WEBHOOK_TOKEN || new URL(req.url).searchParams.get('token') !== WEBHOOK_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  let events: SgEvent[];
  try {
    const body = await req.json();
    events = Array.isArray(body) ? body : [];
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const tracked = events.filter(e => e.kind === PRESTIGE_KIND && TRACKED_EVENTS.has(String(e.event)));
  for (const e of tracked) {
    const ok = e.event === 'delivered';
    const reason = String(e.reason ?? '').slice(0, 2000);
    await logEmail({
      kind: `${PRESTIGE_KIND}-${e.event}`, projectId: e.project_id, recipient: String(e.email ?? ''),
      ok, error: ok ? undefined : `${e.status ?? ''} ${reason}`.trim(),
    });

    const when = e.timestamp ? new Date(e.timestamp * 1000).toISOString() : new Date().toISOString();
    const subject = ok
      ? 'Prestige order email delivered'
      : `ACTION NEEDED: Prestige order email was NOT delivered (${e.event})`;
    const html = wrapEmailHtml({
      title: ok ? 'Prestige order delivered' : 'Prestige order not delivered',
      bodyHtml: `<p style="margin:0 0 16px;color:#333;font-size:15px;line-height:1.6;">
      ${ok
        ? `The flag order email was <strong>delivered</strong> to <strong>${esc(String(e.email ?? ''))}</strong>.`
        : `The flag order email to <strong>${esc(String(e.email ?? ''))}</strong> was <strong>${esc(String(e.event))}</strong> and Prestige has not received it. Send it another way (or ask them to allowlist the sender) so the order isn't missed.`}
    </p>
    <p style="margin:0 0 8px;color:#333;font-size:14px;line-height:1.6;">
      <strong>Project:</strong> ${esc(String(e.project_id ?? 'unknown'))}<br>
      <strong>Time:</strong> ${esc(when)}<br>
      <strong>Status:</strong> ${esc(String(e.status ?? ''))}
    </p>
    ${reason ? `<p style="margin:0;padding:12px;background:#f6f6f6;border-radius:6px;color:#555;font-size:13px;line-height:1.5;word-break:break-word;">${esc(reason)}</p>` : ''}`,
    });
    const text = ok
      ? `The Prestige order email was delivered to ${e.email}.\n\nProject: ${e.project_id ?? 'unknown'}\nTime: ${when}`
      : `The Prestige order email to ${e.email} was ${e.event} and was NOT delivered.\n\nProject: ${e.project_id ?? 'unknown'}\nTime: ${when}\nStatus: ${e.status ?? ''}\nReason: ${reason}\n\nSend the order another way or ask them to allowlist the sender.`;

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ALERT_TO }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
      }),
    });
    if (!res.ok) {
      console.error('alert send failed', res.status, await res.text());
      // Non-2xx makes SendGrid retry the batch, so the alert isn't lost.
      return new Response('Alert failed', { status: 500 });
    }
  }
  return new Response('ok', { status: 200 });
});
