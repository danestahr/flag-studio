// Shared by `pipedrive` (link-deal / create-from-deal) and `pipedrive-webhook`: turn a Pipedrive deal
// into a project's customer_info. Deal custom fields are resolved by label, GolfStatus (via
// sync-event-info) wins where it returns a value, and event_date is the delivery date.
// Needs PIPEDRIVE_API_TOKEN, PIPEDRIVE_DOMAIN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in the env.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PIPEDRIVE_API_TOKEN = Deno.env.get('PIPEDRIVE_API_TOKEN');
const PIPEDRIVE_DOMAIN = Deno.env.get('PIPEDRIVE_DOMAIN')
  ?.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.pipedrive\.com$/i, '') || undefined;

// Everything copied out of Pipedrive is untrusted text: strip control chars (also blocks header/
// newline tricks in email subjects), collapse whitespace, cap length.
export function clean(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const out = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return out || null;
}

// contact_email is later mailed by the approval-reminder cron, so only store something that looks
// like a single plain address.
export function cleanEmail(v: unknown): string | null {
  const e = clean(v, 254);
  return e && /^[^\s@<>",;:()\[\]\\]+@[^\s@<>",;:()\[\]\\]+\.[^\s@<>",;:()\[\]\\]+$/.test(e) ? e.toLowerCase() : null;
}

export async function pd(path: string) {
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

// Mon-Fri only (no holidays), n business days before the date. Port of subtractBusinessDays() in
// src/intake-shared.js - keep in sync. order.js stores the customer's *delivery* date as event_date,
// defaulting it to two business days before the synced event date; do the same here so
// auto-created projects match what the order form would have produced.
function subtractBusinessDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  while (n > 0) {
    dt.setUTCDate(dt.getUTCDate() - 1);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) n--;
  }
  return dt.toISOString().slice(0, 10);
}

// GolfStatus is the source of truth for event details (name, date, course, shipping address) when
// the deal carries an event-page URL: reuse the same `sync-event-info` function the customer flow
// calls. Best-effort - any failure just leaves the Pipedrive-field values in place. The tournament
// logo it returns is intentionally ignored here (the customer flow uploads/places it client-side).
async function syncEventInfo(url: string | null): Promise<Record<string, string> | null> {
  if (!url) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/sync-event-info`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) { console.warn(`sync-event-info ${res.status} for ${url}`); return null; }
    const e = await res.json();
    const state = clean(e.courseState, 60);
    return Object.fromEntries(Object.entries({
      event_name: clean(e.eventName),
      event_date: typeof e.eventDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.eventDate) ? e.eventDate : null,
      course_name: clean(e.courseName),
      address_line1: clean(e.courseAddressLine1),
      address_line2: clean(e.courseAddressLine2),
      city: clean(e.courseCity),
      state_province: state ? REGIONS[state.toLowerCase()] ?? state : null,
      postal_code: clean(e.coursePostalCode, 20),
      country: clean(e.courseCountry, 2),
    }).filter(([, v]) => v));
  } catch (e) {
    console.error('sync-event-info failed', e);
    return null;
  }
}

// The full pipeline: deal -> customer_info (best-effort GolfStatus sync, delivery-date shift).
export async function buildCustomerInfoFromDeal(deal: any): Promise<Record<string, unknown>> {
  const info: Record<string, any> = await buildCustomerInfo(deal);
  const synced = await syncEventInfo(info.registration_url);
  if (synced) Object.assign(info, synced);
  // event_date is the delivery date (see subtractBusinessDays); keep the event's own date alongside.
  if (info.event_date) {
    info.tournament_date = info.event_date;
    info.event_date = subtractBusinessDays(info.event_date, 2);
  }
  return info;
}
