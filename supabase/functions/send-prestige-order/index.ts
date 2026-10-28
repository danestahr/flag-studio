import { logEmail } from '../_shared/email-log.ts';
import { encode as base64Encode } from 'https://deno.land/std@0.168.0/encoding/base64.ts';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { wrapEmailHtml, ctaButton, linkFallback, esc } from '../_shared/email-layout.ts';

// SENDGRID_API_KEY_2 is the current key; SENDGRID_API_KEY is kept as a fallback
// during rotation and can be removed once SENDGRID_API_KEY_2 is confirmed live everywhere.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY_2') ?? Deno.env.get('SENDGRID_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Sent from the shared design inbox (not an individual's address).
const FROM_EMAIL = 'design@gsds.space';
const FROM_NAME = 'Design Studio';
const TO_EMAIL = 'tom@prestigeflag.com';
const TO_NAME = 'Tom';
// ?testTo= redirects the send for testing; only this address is honored so the
// (unauthenticated) endpoint can't be used to mail arbitrary recipients.
const TEST_TO_EMAIL = 'dane@danestahr.com';
// Fail-safe on top of ?testTo=: a function running against a local Supabase
// (http://kong:8000 / 127.0.0.1 / localhost inside the dev container, never an
// https hosted project) always redirects to the test address, even when the
// client forgot to ask - e.g. the app opened via a LAN IP or tunnel.
const IS_LOCAL_SUPABASE = (() => {
  try {
    const u = new URL(Deno.env.get('SUPABASE_URL') ?? '');
    return u.protocol !== 'https:' || ['kong', 'localhost', '127.0.0.1', 'host.docker.internal'].includes(u.hostname);
  } catch { return true; }
})();

const BUCKET = 'print-sheets';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
};

// Variation + total flag counts from the saved design (qty defaults to 1, same
// as print-export.js). variations is either an array or { items: [...] }.
async function flagCounts(projectId: string): Promise<{ variationCount: number; flagCount: number }> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/flag_config?project_id=eq.${encodeURIComponent(projectId)}&select=variations&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) return { variationCount: 0, flagCount: 0 };
  const [row] = await res.json();
  const raw = row?.variations;
  const items: Array<{ qty?: number }> = Array.isArray(raw) ? raw : (raw?.items ?? []);
  return { variationCount: items.length, flagCount: items.reduce((n, v) => n + (Number(v?.qty) || 1), 0) };
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

// Vendor requires the in-hand date to be 2 business days (Mon-Fri) before the
// event. Mirrors subtractBusinessDays() in src/orderSummaryPdf.js.
function subtractBusinessDays(y: number, m: number, d: number, n: number): Date {
  const dt = new Date(Date.UTC(y, m - 1, d));
  while (n > 0) {
    dt.setUTCDate(dt.getUTCDate() - 1);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) n--;
  }
  return dt;
}

// Event date for the project (staff-corrected customer_info first), or ''.
async function eventDateIso(projectId: string): Promise<string> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=customer_info,order_intakes(event_date)&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) return '';
  const [row] = await res.json();
  const iso = (row?.customer_info?.event_date || row?.order_intakes?.[0]?.event_date || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

// In-hand date (event date - 2 business days) as YYYY-MM-DD, or '' when the
// project has no event date.
function inHandDateIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  return subtractBusinessDays(+m[1], +m[2], +m[3], 2).toISOString().slice(0, 10);
}

// Rush = sent inside the standard approval window: the event (moved back to the
// preceding Friday if Sat/Sun/Mon) is less than 17 days away. Mirrors
// calcEffectiveDeadline() in src/intake-shared.js. Compared in UTC.
function isRush(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const back = { 6: 1, 0: 2, 1: 3 }[dt.getUTCDay() as 0 | 1 | 6] ?? 0;
  dt.setUTCDate(dt.getUTCDate() - back - 17);
  return new Date().toISOString().slice(0, 10) > dt.toISOString().slice(0, 10);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const url = new URL(req.url);
    const projectId = url.searchParams.get('projectId');
    const projectName = url.searchParams.get('projectName') || 'Flag Order';
    // ?prepare=1: build the order + download page only, no email (admin inspection before sending).
    const prepareOnly = url.searchParams.get('prepare') === '1';
    // SHA-256 hex of the design the zip was built from (see flagDesignHash in src/supabase.js).
    const rawHash = url.searchParams.get('designHash') ?? '';
    const designHash = /^[0-9a-f]{64}$/.test(rawHash) ? rawHash : null;
    const isTest = IS_LOCAL_SUPABASE || url.searchParams.get('testTo')?.toLowerCase() === TEST_TO_EMAIL;
    const toEmail = isTest ? TEST_TO_EMAIL : TO_EMAIL;
    // Multipart (zip + summary PDF to attach) or a raw zip body.
    let zipBuffer: ArrayBuffer;
    let summaryBuffer: ArrayBuffer | null = null;
    if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      const form = await req.formData();
      const zipPart = form.get('zip');
      const summaryPart = form.get('summary');
      zipBuffer = zipPart instanceof File ? await zipPart.arrayBuffer() : new ArrayBuffer(0);
      if (summaryPart instanceof File && summaryPart.size) summaryBuffer = await summaryPart.arrayBuffer();
    } else {
      zipBuffer = await req.arrayBuffer();
    }

    if (!projectId || !zipBuffer.byteLength) {
      return new Response(JSON.stringify({ error: 'Missing zip or projectId' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (!(await projectExists(projectId))) {
      return new Response(JSON.stringify({ error: 'Invalid project' }), {
        status: 403, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Store the zip privately and email a link to the landing page (no attachment).
    const zipMb = zipBuffer.byteLength / 1048576;
    console.log(`prestige zip ${zipMb.toFixed(2)} MB project=${projectId}`);

    const rawName = projectName;
    const safeName = rawName.replace(/[^a-zA-Z0-9_\- ]/g, '_');
    const filename = `${safeName}-flags.zip`;
    const path = `prestige/${projectId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.zip`;
    const storageHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

    const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { ...storageHeaders, 'Content-Type': 'application/zip' },
      body: zipBuffer,
    });
    if (!upRes.ok) {
      const body = await upRes.text();
      console.error('storage upload failed', upRes.status, body);
      return new Response(JSON.stringify({ error: 'Storage upload failed', status: upRes.status, detail: body }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const eventIso = await eventDateIso(projectId);
    const inHandIso = inHandDateIso(eventIso);
    const { variationCount, flagCount } = await flagCounts(projectId);
    const fields = {
      storage_path: path, filename, size_bytes: zipBuffer.byteLength,
      variation_count: variationCount, flag_count: flagCount, in_hand_date: inHandIso || null,
      design_hash: designHash,
    };
    // One order per project, rebuilt in place by Prepare/Update/Publish/Send so
    // the link stays the same forever and always serves the latest files - the
    // same model as the review link. That includes an order that was already
    // emailed: its sent_at is left alone on a prepare-only rebuild (no new email,
    // the download page just shows its "newer version" banner), and a Send
    // re-emails the same link and bumps sent_at.
    const existing = (await (await fetch(
      `${SUPABASE_URL}/rest/v1/prestige_orders?project_id=eq.${projectId}&select=id,storage_path&order=created_at.desc&limit=1`,
      { headers: storageHeaders },
    )).json().catch(() => []))?.[0];
    const orderRes = existing
      ? await fetch(`${SUPABASE_URL}/rest/v1/prestige_orders?id=eq.${existing.id}`, {
          method: 'PATCH',
          headers: { ...storageHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          // created_at doubles as "files generated" and the page's version stamp.
          body: JSON.stringify({ ...fields, created_at: new Date().toISOString() }),
        })
      : await fetch(`${SUPABASE_URL}/rest/v1/prestige_orders`, {
          method: 'POST',
          headers: { ...storageHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ project_id: projectId, ...fields }),
        });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      console.error('prestige_orders write failed', orderRes.status, body);
      return new Response(JSON.stringify({ error: 'Could not record order', detail: body }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    const [{ id: orderId }] = await orderRes.json();
    // The replaced zip is no longer referenced by anything; best-effort cleanup.
    if (existing?.storage_path) {
      await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${existing.storage_path}`, {
        method: 'DELETE', headers: storageHeaders,
      }).catch(err => console.error('old zip cleanup failed', err));
    }

    // Permanent landing page link (no expiry). Origin comes from the client;
    // require https (localhost only for test sends) so the endpoint can't mail
    // an odd link.
    let origin = '';
    try {
      const o = new URL(url.searchParams.get('origin') || '');
      if (o.protocol === 'https:' || (isTest && o.hostname === 'localhost')) origin = o.origin;
    } catch { /* fall through */ }
    if (!origin) {
      return new Response(JSON.stringify({ error: 'Invalid origin' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    const landing = `${origin}/prestige-download?id=${orderId}`;
    if (prepareOnly) {
      return new Response(JSON.stringify({ ok: true, prepared: true, orderId, url: landing }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const name = projectName;
    const dateLabel = inHandIso ? `${inHandIso.slice(5, 7)}/${inHandIso.slice(8, 10)}/${inHandIso.slice(2, 4)}` : '';
    const subject = `${isTest ? '[TEST] ' : ''}${isRush(eventIso) ? 'RUSH - ' : ''}${dateLabel ? dateLabel + ' ' : ''}-Golf Status Order- ${name}`;
    const html = wrapEmailHtml({
      title: name,
      bodyHtml: `<p style="margin:0 0 20px;color:#333;font-size:15px;line-height:1.6;">
      Hey ${TO_NAME},<br><br>
      Here's the flag order for <strong>${name}</strong>. Use the button below to download the files (${zipMb.toFixed(1)} MB zip). It includes everything you should need to know about the order.${summaryBuffer ? ' The Order Summary PDF is attached for quick reference.' : ''}
    </p>
    ${ctaButton(esc(landing), 'View Project', false)}
    ${linkFallback(esc(landing))}
    <p style="margin:24px 0 0;color:#999;font-size:13px;line-height:1.6;">
      Let me know if you have any questions!
    </p>`,
    });

    const text = `Hey ${TO_NAME},\n\nHere's the flag order for ${name}. Use the link below to download the files (${zipMb.toFixed(1)} MB zip). It includes everything you should need to know about the order.${summaryBuffer ? ' The Order Summary PDF is attached for quick reference.' : ''}\n\nDownload files: ${landing}\n\nLet me know if you have any questions!`;

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail, name: TO_NAME }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        tracking_settings: { click_tracking: { enable: false } },
        // Echoed back on Event Webhook events so sendgrid-events can alert on a bounce.
        custom_args: { kind: 'prestige-order', project_id: projectId },
        subject,
        ...(summaryBuffer ? {
          attachments: [{
            content: base64Encode(new Uint8Array(summaryBuffer)),
            filename: 'Order Summary.pdf',
            type: 'application/pdf',
            disposition: 'attachment',
          }],
        } : {}),
        content: [
          { type: 'text/plain', value: text },
          { type: 'text/html', value: html },
        ],
      }),
    });

    if (res.ok) {
      await fetch(`${SUPABASE_URL}/rest/v1/prestige_orders?id=eq.${orderId}`, {
        method: 'PATCH',
        headers: { ...storageHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ sent_at: new Date().toISOString() }),
      }).catch(err => console.error('sent_at update failed', err));
    }
    if (res.ok) await logEmail({ kind: 'prestige-order', projectId: projectId, recipient: toEmail, ok: true, httpStatus: res.status });
    if (!res.ok) {
      const body = await res.text();
      console.error('SendGrid error', res.status, body);
      await logEmail({ kind: 'prestige-order', projectId: projectId, recipient: toEmail, ok: false, httpStatus: res.status, error: body });
      return new Response(JSON.stringify({ error: 'SendGrid failed', status: res.status, detail: body }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
