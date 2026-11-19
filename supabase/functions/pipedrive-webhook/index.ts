// Pipedrive deal webhook -> auto-create a Studio project when a deal enters the configured
// "Committed" stage (pipedrive_autocreate_config).
//
// Setup (once): in Pipedrive register a webhook (Tools > Webhooks, or POST /api/v1/webhooks)
//   event: updated.deal   URL: <project>/functions/v1/pipedrive-webhook
//   HTTP auth: username `pipedrive`, password <PIPEDRIVE_WEBHOOK_TOKEN>  (sent as a Basic Authorization header)
// The legacy `?token=` query form is still accepted (and logged) so an existing webhook keeps working
// until it is re-registered; delete that branch afterwards - URLs end up in logs, headers don't.
// Secrets: PIPEDRIVE_API_TOKEN, PIPEDRIVE_DOMAIN (shared with `pipedrive`), PIPEDRIVE_WEBHOOK_TOKEN.
//
// The payload is only used to learn WHICH deal changed. The deal's stage/pipeline/status are
// re-read from the Pipedrive API, so a forged or stale payload can't create anything on its own
// (the token gates who can call at all). Creation is idempotent (pipedrive_autocreate_project),
// so retries and repeat change events on the same deal are harmless. Always answers 200 for
// "nothing to do" outcomes so Pipedrive doesn't retry them; 5xx only for transient failures.
//
// Deliberately does NOT call move-deal: the deal is already in Committed, and a fresh project has
// no design row, so syncing would just push the deal to whatever `not_started` maps to.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { buildCustomerInfoFromDeal, clean, pd } from '../_shared/pipedrive-deal-info.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PIPEDRIVE_API_TOKEN = Deno.env.get('PIPEDRIVE_API_TOKEN');
const PIPEDRIVE_DOMAIN = Deno.env.get('PIPEDRIVE_DOMAIN')
  ?.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.pipedrive\.com$/i, '') || undefined;
const WEBHOOK_TOKEN = Deno.env.get('PIPEDRIVE_WEBHOOK_TOKEN');

const PRODUCT = 'flags' as const; // flags only for now; config table is keyed for hole-signs later

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Compare SHA-256 digests so the comparison is constant-time and doesn't leak the secret's length.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function authorized(req: Request): Promise<boolean> {
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (basic) {
    try {
      const decoded = atob(basic[1]);
      const pw = decoded.slice(decoded.indexOf(':') + 1);
      if (await safeEqual(pw, WEBHOOK_TOKEN!)) return true;
    } catch { /* malformed header -> fall through to deny */ }
  }
  const q = new URL(req.url).searchParams.get('token');
  if (q && (await safeEqual(q, WEBHOOK_TOKEN!))) {
    console.warn('pipedrive-webhook: authenticated via legacy ?token= query; re-register the webhook with HTTP auth');
    return true;
  }
  return false;
}

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Database error (${res.status}): ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Seed order_intakes (unsubmitted, like the order form's "started" state) and send the customer the
// "order started" email with a Step 2 resume link. Returns a short outcome string for the response/log.
// order_intakes has NOT NULL address columns, so unknown ones are '' (Step 2 makes the customer fill
// them in). Without a contact email there is nobody to email, and without a delivery date nothing to
// resume (event_date is NOT NULL), so those cases are skipped rather than guessed.
async function startOrderForCustomer(projectId: string, info: Record<string, any>): Promise<string> {
  try {
    if (!info.contact_email) return 'skipped_no_contact_email';
    if (!info.event_date) return 'skipped_no_event_date';
    await rest('rpc/save_order_intake', {
      method: 'POST',
      body: JSON.stringify({
        p_project_id: projectId,
        p_finalize: false,
        p_data: {
          event_name: info.event_name ?? '',
          course_name: info.course_name ?? null,
          event_source_url: info.registration_url ?? null,
          event_date: info.event_date,
          contact_name: info.contact_name ?? '',
          contact_email: info.contact_email,
          address_line1: info.address_line1 ?? '',
          address_line2: info.address_line2 ?? null,
          city: info.city ?? '',
          state_province: info.state_province ?? '',
          postal_code: info.postal_code ?? '',
          country: info.country ?? 'US',
        },
      }),
    });
    // Never let a local run mail a real address: the override only honors this one test address.
    const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|kong|host\.docker\.internal)/.test(SUPABASE_URL);
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-order-started`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, step: 2, ...(isLocal ? { testTo: 'dane@danestahr.com' } : {}) }),
    });
    if (!res.ok) { console.error('send-order-started failed', res.status, await res.text()); return `failed_${res.status}`; }
    return 'sent';
  } catch (e) {
    console.error('startOrderForCustomer failed', e);
    return 'failed';
  }
}

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!WEBHOOK_TOKEN || !PIPEDRIVE_API_TOKEN || !PIPEDRIVE_DOMAIN) return json({ error: 'Not configured' }, 500);

  if (!(await authorized(req))) return json({ error: 'Forbidden' }, 403);

  try {
    const body = await req.json();
    const meta = body?.meta ?? {};
    // v2 webhooks: meta.entity = 'deal', meta.action = 'change' | 'create'. v1 used object/event.
    const entity = meta.entity ?? meta.object;
    if (entity !== 'deal') return json({ ok: true, skipped: 'not_a_deal' });

    const dealId = Number(body?.data?.id ?? body?.current?.id ?? meta.entity_id ?? meta.id);
    if (!Number.isSafeInteger(dealId) || dealId <= 0) return json({ ok: true, skipped: 'no_deal_id' });

    const cfgRows = await rest(`pipedrive_autocreate_config?product_type=eq.${PRODUCT}&enabled=eq.true&select=pipeline_id,stage_id&limit=1`);
    if (!cfgRows?.length) return json({ ok: true, skipped: 'autocreate_not_configured' });
    const cfg = cfgRows[0];

    // Source of truth is the API, not the payload.
    const dealRes = await pd(`deals/${dealId}`);
    const deal = dealRes?.data;
    if (!deal || deal.is_deleted || deal.status === 'deleted') return json({ ok: true, skipped: 'deal_gone' });
    if (deal.status !== 'open') return json({ ok: true, skipped: `deal_${deal.status}` });
    if (Number(deal.pipeline_id) !== Number(cfg.pipeline_id) || Number(deal.stage_id) !== Number(cfg.stage_id)) {
      return json({ ok: true, skipped: 'not_in_committed_stage' });
    }

    // Repeat change events on an already-created deal: skip the Pipedrive/GolfStatus lookups.
    const existing = await rest(`projects?pipedrive_flags_deal_id=eq.${dealId}&select=id&limit=1`);
    if (existing?.length) return json({ ok: true, projectId: existing[0].id, created: false });

    const info = await buildCustomerInfoFromDeal(deal);
    const rows = await rest('rpc/pipedrive_autocreate_project', {
      method: 'POST',
      body: JSON.stringify({
        p_product_type: PRODUCT,
        p_deal_id: dealId,
        p_name: (info.event_name as string | null) ?? clean(deal.title),
        p_customer_info: info,
      }),
    });
    const row = rows?.[0];
    // Write the project URL onto the deal's "Design Studio Project Link" field (best-effort; the
    // `pipedrive` function owns that field's config). Only on creation - link-deal does the same.
    if (row?.created) {
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/pipedrive`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set-link-field', dealId, projectId: row.project_id }),
        });
      } catch (e) { console.error('set-link-field failed', e); }
    }
    // First creation only: seed the order intake from what we know, then send the customer the
    // same "your order has been started" email the order form sends, linking to Step 2 so they can
    // confirm shipping and the delivery date. Best-effort - the project already exists either way.
    let email: string = 'not_attempted';
    if (row?.created) email = await startOrderForCustomer(row.project_id, info);
    console.log(`pipedrive-webhook: deal ${dealId} -> project ${row?.project_id} (${row?.created ? 'created' : 'already existed'})`);
    return json({ ok: true, projectId: row?.project_id ?? null, created: !!row?.created, email });
  } catch (e) {
    // 5xx so Pipedrive retries transient failures (API/DB hiccups).
    console.error('pipedrive-webhook error', e);
    return json({ error: 'Internal error' }, 500);
  }
});
