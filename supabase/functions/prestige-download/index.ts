import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

import { logEmail } from '../_shared/email-log.ts';
import { wrapEmailHtml, esc } from '../_shared/email-layout.ts';
import { TEST_TO_EMAIL } from '../_shared/test-to.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY');
// Internal heads-up when Prestige finishes downloading, sent to the shared design inbox.
const NOTIFY_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';
// A function on a local Supabase never mails the real inbox.
const IS_LOCAL_SUPABASE = (() => {
  try {
    const u = new URL(SUPABASE_URL);
    return u.protocol !== 'https:' || ['kong', 'localhost', '127.0.0.1', 'host.docker.internal'].includes(u.hostname);
  } catch { return true; }
})();
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'print-sheets';
// Links never expire, so each download gets a fresh, very short-lived signed
// URL minted here per download attempt.
const SIGNED_URL_TTL_SECONDS = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  return res.ok ? await res.json() : null;
}

async function notifyDownloaded(order: any, meta: { project: string; eventName: string | null }) {
  if (!SENDGRID_API_KEY) return;
  const to = IS_LOCAL_SUPABASE ? TEST_TO_EMAIL : NOTIFY_EMAIL;
  const name = meta.eventName || meta.project;
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  const subject = `${IS_LOCAL_SUPABASE ? '[TEST] ' : ''}Prestige downloaded the files for ${name}`;
  const bodyHtml = `<p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 12px;">Prestige finished downloading <strong>${esc(order.filename ?? 'the order zip')}</strong> for <strong>${esc(name)}</strong>.</p>
<p style="font-size:14px;color:#666;margin:0;">${esc(when)} ET</p>`;
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: NOTIFY_EMAIL, name: FROM_NAME },
        custom_args: { kind: 'prestige-downloaded', project_id: order.project_id },
        subject,
        content: [
          { type: 'text/plain', value: `Prestige finished downloading ${order.filename ?? 'the order zip'} for ${name} at ${when} ET.` },
          { type: 'text/html', value: wrapEmailHtml({ title: 'Prestige downloaded the files', bodyHtml }) },
        ],
      }),
    });
    const err = res.ok ? undefined : await res.text();
    if (err) console.error('download notify failed', res.status, err);
    await logEmail({ kind: 'prestige-downloaded', projectId: order.project_id, recipient: to, ok: res.ok, httpStatus: res.status, error: err });
  } catch (e) {
    console.error('download notify threw', e);
  }
}

async function loadOrder(id: string) {
  const rows = await rest(`prestige_orders?id=eq.${id}&select=*&limit=1`);
  return rows?.[0] ?? null;
}

// A link for an order that was actually sent always serves the newest sent order
// for its project, so the original email link keeps working after a resend. A
// prepared-only order (never emailed) stays pinned to itself for inspection.
async function resolveOrder(id: string) {
  const order = await loadOrder(id);
  if (!order?.sent_at) return order;
  const rows = await rest(
    `prestige_orders?project_id=eq.${order.project_id}&sent_at=not.is.null&select=*&order=sent_at.desc&limit=1`,
  );
  return rows?.[0] ?? order;
}

// Header/status info shown on the page, mirroring the project overview.
async function loadProjectInfo(projectId: string) {
  const [proj] = (await rest(
    `projects?id=eq.${projectId}&select=name,customer_info,profiles(first_name,last_name,email,role),order_intakes(contact_email,event_name)&limit=1`,
  )) ?? [];
  const [cfg] = (await rest(
    `flag_config?project_id=eq.${projectId}&select=status,approved_by_name,approved_by_email,approved_at&limit=1`,
  )) ?? [];
  const pr = proj?.profiles;
  const creatorName = [pr?.first_name, pr?.last_name].filter(Boolean).join(' ');
  const staffCreated = pr?.role === 'staff' || pr?.role === 'admin';
  const creator = staffCreated
    ? (creatorName || pr?.email || null)
    : (creatorName || pr?.email || proj?.customer_info?.contact_email || proj?.order_intakes?.[0]?.contact_email || null);
  return {
    project: proj?.name ?? 'Flag Order',
    creator,
    eventName: proj?.customer_info?.event_name || proj?.order_intakes?.[0]?.event_name || null,
    status: cfg?.status ?? null,
    approvedAt: cfg?.approved_at ?? null,
    approvedByName: cfg?.approved_by_name ?? null,
    approvedByEmail: cfg?.approved_by_email ?? null,
  };
}

// Body: { id, download?, event?, stage?, error? }.
//  - neither download nor event -> metadata only (page render, admin inspection)
//    for the resolved (latest sent) order; versionId says which order that is
//  - download:true -> returns a short-lived signed URL for the resolved order and
//    its orderId (nothing is logged yet)
//  - event:'complete' -> the page fetched the whole file; logs a download
//  - event:'error' -> the page failed at `stage`; logs it to prestige_download_errors
//    (events take the exact orderId the page was served, so they are not re-resolved)
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  try {
    const { id, download, event, stage, error } = await req.json();
    if (typeof id !== 'string' || !UUID_RE.test(id)) return json({ error: 'Invalid link' }, 400);
    const isEvent = event === 'complete' || event === 'error';
    const order = isEvent ? await loadOrder(id) : await resolveOrder(id);
    if (!order) return json({ error: 'Not found' }, 404);

    const meta = {
      ...(await loadProjectInfo(order.project_id)),
      // id alone isn't enough: a prepared order is rebuilt in place, so the
      // generation time is part of the version the page compares.
      versionId: `${order.id}@${order.created_at}`,
      orderId: order.id,
      generatedAt: order.created_at,
      filename: order.filename,
      sizeBytes: order.size_bytes,
      variationCount: order.variation_count,
      flagCount: order.flag_count,
      inHandDate: order.in_hand_date,
    };

    if (isEvent) {
      const isError = event === 'error';
      const logRes = await fetch(`${SUPABASE_URL}/rest/v1/${isError ? 'prestige_download_errors' : 'prestige_downloads'}`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(isError
          ? {
              order_id: id,
              stage: String(stage ?? '').slice(0, 20) || null,
              error: String(error ?? '').slice(0, 500) || null,
              user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
            }
          : { order_id: id }),
      });
      if (isError) console.error('prestige download failed', id, stage, error);
      if (!logRes.ok) {
        console.error('download log failed', logRes.status, await logRes.text());
        return json({ error: 'Could not record download' }, 500);
      }
      if (!isError) await notifyDownloaded(order, meta);
      return json({ ok: true });
    }
    if (!download) return json(meta);

    const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${order.storage_path}`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    });
    if (!signRes.ok) {
      console.error('sign failed', signRes.status, await signRes.text());
      return json({ error: 'Could not prepare download' }, 500);
    }
    const { signedURL } = await signRes.json();

    const url = `${SUPABASE_URL}/storage/v1${signedURL}&download=${encodeURIComponent(order.filename)}`;
    return json({ ...meta, url });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
