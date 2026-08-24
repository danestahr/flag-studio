import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// SENDGRID_API_KEY_2 is the current key; SENDGRID_API_KEY is kept as a fallback
// during rotation, matching send-proof-ready/send-order-confirmation.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL = Deno.env.get('APP_URL')!;
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'GolfStatus Design Studio';

// Warn at 53 days of inactivity, delete 7 days after that if still
// untouched - a 60-day total window. Only pg_cron calls this (see the
// cron.schedule() entries in supabase/migrations), authenticated with the
// service role key, so there's no user-facing auth to check here.
const WARN_AFTER_DAYS = 53;
const DELETE_AFTER_WARN_DAYS = 7;

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

function buildWarningHtml(p: { recipientName: string; projectName: string; projectUrl: string }): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:32px 16px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
    <div style="background:#1a1a2e;padding:28px 32px;">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:600;">Your Draft Is About To Be Removed</h1>
      <p style="color:#aaa;margin:6px 0 0;font-size:14px;">GolfStatus Design Studio</p>
    </div>
    <div style="padding:32px;">
      <p style="margin:0 0 20px;color:#333;font-size:16px;">Hi ${esc(p.recipientName)},</p>
      <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
        Your draft project <strong>${esc(p.projectName)}</strong> hasn't been touched in a while and will be removed in 7 days due to inactivity. Open it to keep it — no action needed if you're still working on it elsewhere.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${esc(p.projectUrl)}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
          Open Draft →
        </a>
      </div>
    </div>
    <div style="padding:20px 32px;background:#fafafa;border-top:1px solid #f0f0f0;">
      <p style="margin:0;color:#bbb;font-size:12px;">GolfStatus Design Studio · designstudio@golfstatus.com<br>8545 S 78th St, Lincoln, NE 68516</p>
    </div>
  </div>
</body>
</html>`;
}

function buildWarningText(p: { recipientName: string; projectName: string; projectUrl: string }): string {
  return [
    `Hi ${p.recipientName},`,
    '',
    `Your draft project "${p.projectName}" hasn't been touched in a while and will be removed in 7 days due to inactivity. Open it to keep it — no action needed if you're still working on it elsewhere.`,
    '',
    `Open it here: ${p.projectUrl}`,
    '',
    'GolfStatus Design Studio',
    'designstudio@golfstatus.com',
    '8545 S 78th St, Lincoln, NE 68516',
  ].join('\n');
}

async function sendWarningEmail(p: { email: string; recipientName: string; projectName: string; projectUrl: string }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: p.email, name: p.recipientName }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      reply_to: { email: FROM_EMAIL, name: FROM_NAME },
      subject: `Your draft "${p.projectName}" will be removed soon`,
      content: [
        { type: 'text/plain', value: buildWarningText(p) },
        { type: 'text/html', value: buildWarningHtml(p) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`SendGrid failed: ${res.status} ${await res.text()}`);
}

async function removeStoragePaths(paths: string[]) {
  if (!paths.length) return;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/flag-logos`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!res.ok) console.error('storage cleanup failed', res.status, await res.text());
}

async function runWarnPhase() {
  await rpc('clear_stale_draft_warnings');
  const candidates = await rpc<{ id: string; name: string; owner_email: string; owner_name: string }[]>(
    'abandoned_draft_candidates', { threshold_days: WARN_AFTER_DAYS }
  );

  let warned = 0;
  const errors: string[] = [];
  for (const c of candidates) {
    try {
      await sendWarningEmail({
        email: c.owner_email,
        recipientName: c.owner_name,
        projectName: c.name || 'Untitled',
        projectUrl: `${APP_URL}/project.html?project=${c.id}`,
      });
      await rpc('mark_draft_warned', { target_project_id: c.id });
      warned++;
    } catch (err) {
      errors.push(`${c.id}: ${err}`);
    }
  }
  return { phase: 'warn', candidates: candidates.length, warned, errors };
}

async function runDeletePhase() {
  const candidates = await rpc<{ id: string }[]>('abandoned_draft_delete_candidates', { grace_days: DELETE_AFTER_WARN_DAYS });

  let deleted = 0;
  const errors: string[] = [];
  for (const c of candidates) {
    try {
      const logoPaths = await rpc<string[]>('delete_project', { target_project_id: c.id });
      await removeStoragePaths(logoPaths);
      deleted++;
    } catch (err) {
      errors.push(`${c.id}: ${err}`);
    }
  }
  return { phase: 'delete', candidates: candidates.length, deleted, errors };
}

serve(async (req) => {
  try {
    const { phase } = await req.json();
    const result = phase === 'delete' ? await runDeletePhase() : await runWarnPhase();
    if (result.errors.length) console.error('sweep-abandoned-drafts errors', result.errors);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
