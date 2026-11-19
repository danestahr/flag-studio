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

// Deal custom fields are keyed by an account-specific hash, so resolve them by label at runtime
// (sandbox and prod have different keys). Cached per warm instance; labels are matched
// case-insensitively. "Benefitting" is the label as currently spelled in Pipedrive.
const FIELD_LABELS = {
  tournament_name: ['tournament name'],
  tournament_date: ['tournament date'],
  course_name: ['course name'],
  course_city: ['course city'],
  course_state: ['course state'],
  course_country: ['course country'],
  registration_url: ['registration page url'],
  poc_name: ['name (poc)'],
  poc_email: ['email address'],
  poc_phone: ['phone number'],
  benefiting_org: ['benefitting organization', 'benefiting organization'],
} as const;

let fieldKeyCache: { at: number; byLabel: Map<string, string> } | null = null;
async function fieldKeysByLabel(): Promise<Map<string, string>> {
  if (fieldKeyCache && Date.now() - fieldKeyCache.at < 10 * 60_000) return fieldKeyCache.byLabel;
  const res = await fetch(`https://${PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1/dealFields?limit=500`, {
    headers: { 'x-api-token': PIPEDRIVE_API_TOKEN! },
  });
  if (!res.ok) throw new Error(`Pipedrive dealFields ${res.status}`);
  const byLabel = new Map<string, string>();
  for (const f of (await res.json()).data ?? []) byLabel.set(String(f.name).trim().toLowerCase(), f.key);
  fieldKeyCache = { at: Date.now(), byLabel };
  return byLabel;
}

// The app stores country as 'US' | 'CA' (the Canada lead-time extra keys off 'CA') and state/province
// as a 2-letter code, but Pipedrive text fields are free-form. Normalize; anything unrecognized is
// passed through unchanged so staff can see and fix it.
const REGIONS: Record<string, string> = Object.fromEntries(
  ('AL:Alabama,AK:Alaska,AZ:Arizona,AR:Arkansas,CA:California,CO:Colorado,CT:Connecticut,DE:Delaware,DC:District of Columbia,FL:Florida,GA:Georgia,HI:Hawaii,ID:Idaho,IL:Illinois,IN:Indiana,IA:Iowa,KS:Kansas,KY:Kentucky,LA:Louisiana,ME:Maine,MD:Maryland,MA:Massachusetts,MI:Michigan,MN:Minnesota,MS:Mississippi,MO:Missouri,MT:Montana,NE:Nebraska,NV:Nevada,NH:New Hampshire,NJ:New Jersey,NM:New Mexico,NY:New York,NC:North Carolina,ND:North Dakota,OH:Ohio,OK:Oklahoma,OR:Oregon,PA:Pennsylvania,RI:Rhode Island,SC:South Carolina,SD:South Dakota,TN:Tennessee,TX:Texas,UT:Utah,VT:Vermont,VA:Virginia,WA:Washington,WV:West Virginia,WI:Wisconsin,WY:Wyoming,' +
   'AB:Alberta,BC:British Columbia,MB:Manitoba,NB:New Brunswick,NL:Newfoundland and Labrador,NS:Nova Scotia,NT:Northwest Territories,NU:Nunavut,ON:Ontario,PE:Prince Edward Island,QC:Quebec,SK:Saskatchewan,YT:Yukon')
    .split(',').flatMap((e) => { const [c, n] = e.split(':'); return [[n.toLowerCase(), c], [c.toLowerCase(), c]]; }),
);
const CA_CODES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);

function normCountry(v: string | null, stateCode: string | null): string | null {
  if (v) {
    const k = v.toLowerCase().replace(/[.\s]/g, '');
    if (['us', 'usa', 'unitedstates', 'unitedstatesofamerica'].includes(k)) return 'US';
    if (['ca', 'can', 'canada'].includes(k)) return 'CA';
    return v;
  }
  return stateCode && REGIONS[stateCode.toLowerCase()] ? (CA_CODES.has(stateCode) ? 'CA' : 'US') : null;
}

// Deal fields first (staff fill these in per deal), then the linked person/org as a fallback.
// A missing field just leaves that key null - staff can fill it in on the project page.
async function buildCustomerInfo(deal: any) {
  const keys = await fieldKeysByLabel();
  const custom = deal.custom_fields ?? {};
  const field = (name: keyof typeof FIELD_LABELS): unknown => {
    for (const label of FIELD_LABELS[name]) {
      const k = keys.get(label);
      const v = k ? (custom[k] ?? deal[k]) : undefined;
      if (v !== undefined && v !== null && v !== '') return typeof v === 'object' ? (v as any).value ?? null : v;
    }
    return null;
  };

  let person: any = null;
  let org: any = null;
  const needPerson = !field('poc_name') || !field('poc_email') || !field('poc_phone');
  if (needPerson && deal.person_id) { try { person = (await pd(`persons/${deal.person_id}`))?.data ?? null; } catch (e) { console.error('person fetch failed', e); } }
  if (!field('benefiting_org') && deal.org_id) { try { org = (await pd(`organizations/${deal.org_id}`))?.data ?? null; } catch (e) { console.error('org fetch failed', e); } }

  const rawState = clean(field('course_state'), 60);
  const stateCode = rawState ? REGIONS[rawState.toLowerCase()] ?? rawState : null;
  const date = clean(field('tournament_date'), 10);
  const url = clean(field('registration_url'), 500);
  return {
    event_name: clean(field('tournament_name')) ?? clean(deal.title),
    event_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    course_name: clean(field('course_name')),
    city: clean(field('course_city')),
    state_province: stateCode,
    country: normCountry(clean(field('course_country'), 60), stateCode),
    registration_url: url && /^https?:\/\//i.test(url) ? url : null,
    contact_name: clean(field('poc_name')) ?? clean(person?.name),
    contact_email: cleanEmail(field('poc_email')) ?? cleanEmail(primary(person?.emails)),
    contact_phone: clean(String(field('poc_phone') ?? ''), 40) ?? clean(primary(person?.phones), 40),
    benefiting_org: clean(field('benefiting_org')) ?? clean(org?.name),
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
