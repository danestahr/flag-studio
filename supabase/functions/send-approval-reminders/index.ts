import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { logEmail } from '../_shared/email-log.ts';
import { esc, wrapEmailHtml, ctaButton, linkFallback, PLAIN_TEXT_FOOTER } from '../_shared/email-layout.ts';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL = Deno.env.get('APP_URL')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';

// Only pg_cron calls this (daily, service role key) - see
// 20261007010000_approval_deadline_reminders.sql. Which orders are due, and
// the 45/30/14/7/3-day thresholds, are decided in approval_reminder_candidates().

interface Candidate {
  project_id: string;
  event_name: string;
  contact_name: string;
  contact_email: string;
  approval_deadline: string; // YYYY-MM-DD
  days_left: number;
  threshold: number;
  share_token: string | null;
  order_complete: boolean;
  has_logos: boolean;
  proof_sent: boolean;
}

// One primary call to action per email, always a link the customer can open
// without an account. Unfinished order trumps a waiting proof, which trumps
// missing logos. Returns null when there's nothing actionable (the SQL
// candidate filter should already exclude those; this is a safety net so we
// never fall back to a project.html link customers can't access).
function callToAction(c: Candidate): { url: string; label: string; message: string } | null {
  const base = APP_URL.replace(/\/$/, '');
  if (!c.order_complete) {
    return {
      url: `${base}/order?resume=${c.project_id}`,
      label: 'Complete Your Order',
      message: "We don't have your completed order yet. Please finish your order so we can start on your artwork.",
    };
  }
  if (c.proof_sent && c.share_token) {
    return {
      url: `${base}/review?token=${c.share_token}`,
      label: 'Review & Approve Your Proof',
      message: 'Your design proof is ready and waiting for your approval. Please review it and approve or request changes.',
    };
  }
  if (!c.has_logos) {
    return {
      url: `${base}/upload-logos?project=${c.project_id}`,
      label: 'Upload Your Logos',
      message: "We haven't received any logos for your order yet. Please upload them so we can get your design ready.",
    };
  }
  return null;
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function whenPhrase(days: number): string {
  if (days === 0) return 'today';
  return days === 1 ? '1 day away' : `${days} days away`;
}

function buildHtml(c: Candidate, cta: { url: string; label: string; message: string }): string {
  const body = `<p style="margin:0 0 20px;color:#333;font-size:16px;">Hi ${esc(c.contact_name)},</p>
      <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.6;">
        This is a reminder that final artwork approval for <strong>${esc(c.event_name)}</strong> is due by
        <strong>${esc(formatDate(c.approval_deadline))}</strong> &mdash; ${esc(whenPhrase(c.days_left))}.
      </p>
      <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
        ${esc(cta.message)} Approving by this date helps you avoid rush fees.
      </p>
      ${ctaButton(esc(cta.url), cta.label)}
      ${linkFallback(esc(cta.url))}
      <p style="margin:28px 0 0;color:#888;font-size:13px;line-height:1.6;">If you have any questions, just reply to this email.</p>`;
  return wrapEmailHtml({ title: 'Artwork Approval Reminder', bodyHtml: body });
}

function buildText(c: Candidate, cta: { url: string; label: string; message: string }): string {
  return [
    `Hi ${c.contact_name},`,
    '',
    `This is a reminder that final artwork approval for ${c.event_name} is due by ${formatDate(c.approval_deadline)} - ${whenPhrase(c.days_left)}.`,
    '',
    `${cta.message} Approving by this date helps you avoid rush fees.`,
    '',
    `${cta.label}: ${cta.url}`,
    '',
    PLAIN_TEXT_FOOTER,
  ].join('\n');
}

async function sendReminder(c: Candidate): Promise<boolean> {
  const cta = callToAction(c);
  if (!cta) return false;
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: c.contact_email, name: c.contact_name }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      reply_to: { email: FROM_EMAIL, name: FROM_NAME },
      tracking_settings: { click_tracking: { enable: false } },
      subject: `Artwork approval due ${formatDate(c.approval_deadline)} — ${c.event_name}`,
      content: [
        { type: 'text/plain', value: buildText(c, cta) },
        { type: 'text/html', value: buildHtml(c, cta) },
      ],
    }),
  });
  const err = res.ok ? undefined : await res.text();
  await logEmail({
    kind: `approval-reminder-${c.threshold}`,
    projectId: c.project_id,
    recipient: c.contact_email,
    ok: res.ok,
    httpStatus: res.status,
    error: err,
  });
  if (!res.ok) throw new Error(`SendGrid failed: ${res.status} ${err}`);
  return true;
}

serve(async () => {
  try {
    const candidates = await rpc<Candidate[]>('approval_reminder_candidates');
    let sent = 0;
    const errors: string[] = [];
    for (const c of candidates) {
      try {
        if (!(await sendReminder(c))) continue;
        await rpc('mark_approval_reminder_sent', { p_project_id: c.project_id, p_threshold: c.threshold });
        sent++;
      } catch (err) {
        errors.push(`${c.project_id}: ${err}`);
      }
    }
    if (errors.length) console.error('send-approval-reminders errors', errors);
    return new Response(JSON.stringify({ candidates: candidates.length, sent, errors }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
