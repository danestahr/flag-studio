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

// Everything copied out of Pipedrive is untrusted text: strip control chars (also blocks header/
// newline tricks in email subjects), collapse whitespace, cap length.
function clean(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const out = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return out || null;
}

// contact_email is later mailed by the approval-reminder cron, so only store something that looks
// like a single plain address.
function cleanEmail(v: unknown): string | null {
  const e = clean(v, 254);
  return e && /^[^\s@<>",;:()\[\]\\]+@[^\s@<>",;:()\[\]\\]+\.[^\s@<>",;:()\[\]\\]+$/.test(e) ? e.toLowerCase() : null;
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

async function pd(path: string) {
  const res = await fetch(`https://${PIPEDRIVE_DOMAIN}.pipedrive.com/api/v2/${path}`, {
    headers: { 'x-api-token': PIPEDRIVE_API_TOKEN!, 'Content-Type': 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Pipedrive ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const primary = (list: any[] | undefined): string | null =>
  list?.find((x) => x?.primary)?.value || list?.[0]?.value || null;

// Pull contact details for the deal's person/org. Best-effort: a missing person or org just
// leaves those fields null - staff can fill them in on the project page.
async function buildCustomerInfo(deal: any) {
  let person: any = null;
  let org: any = null;
  try { if (deal.person_id) person = (await pd(`persons/${deal.person_id}`))?.data ?? null; } catch (e) { console.error('person fetch failed', e); }
  try { if (deal.org_id) org = (await pd(`organizations/${deal.org_id}`))?.data ?? null; } catch (e) { console.error('org fetch failed', e); }

  return {
    event_name: clean(deal.title),
    course_name: clean(org?.name),
    contact_name: clean(person?.name),
    contact_email: cleanEmail(primary(person?.emails)),
    contact_phone: clean(primary(person?.phones), 40),
    pipedrive_deal_id: deal.id,
  };
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

    const info = await buildCustomerInfo(deal);
    const rows = await rest('rpc/pipedrive_autocreate_project', {
      method: 'POST',
      body: JSON.stringify({
        p_product_type: PRODUCT,
        p_deal_id: dealId,
        p_name: clean(deal.title),
        p_customer_info: info,
      }),
    });
    const row = rows?.[0];
    console.log(`pipedrive-webhook: deal ${dealId} -> project ${row?.project_id} (${row?.created ? 'created' : 'already existed'})`);
    return json({ ok: true, projectId: row?.project_id ?? null, created: !!row?.created });
  } catch (e) {
    // 5xx so Pipedrive retries transient failures (API/DB hiccups).
    console.error('pipedrive-webhook error', e);
    return json({ error: 'Internal error' }, 500);
  }
});
