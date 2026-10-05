import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { encode as encodeBase64 } from 'https://deno.land/std@0.168.0/encoding/base64.ts';

// Public, unauthenticated GolfStatus API that events.golfstatus.com's own
// frontend calls client-side — no API key, confirmed by inspecting that
// site's network requests. We only ever build this URL ourselves from a
// slug we extract; the customer-supplied URL itself is never fetched, so a
// pasted URL can't be used to make this function request an arbitrary host.
//
// GolfStatus runs the same site/API pair across three environments — prod
// (.com), training (.training), and dev (.dev) — so a pasted events.golfstatus.<env>
// link is served from the matching api.golfstatus.<env>, not always prod.
const GOLFSTATUS_EVENT_HOSTS = new Set(['events.golfstatus.com', 'events.golfstatus.training', 'events.golfstatus.dev']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Outreach emails (e.g. Pipedrive) wrap the event link in a click-tracker like
// https://<id>.pipedrive.email/c/...?redirectUrl=https%3A%2F%2Fevents.golfstatus.com%2Fevent%2F<slug>&hash=...
// so customers paste the wrapper, not the event URL. Look through the query
// params of a non-GolfStatus URL for one whose value is itself an allowlisted
// event URL. Safe because we never fetch the pasted URL — only the extracted slug.
function unwrapTrackedUrl(parsed: URL, depth = 0): URL | null {
  if (GOLFSTATUS_EVENT_HOSTS.has(parsed.hostname)) return parsed;
  if (depth >= 2) return null;
  for (const value of parsed.searchParams.values()) {
    let inner: URL;
    try {
      inner = new URL(value);
    } catch {
      continue;
    }
    if (inner.protocol !== 'https:' && inner.protocol !== 'http:') continue;
    const found = unwrapTrackedUrl(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractSlug(rawUrl: string): { slug: string; apiBase: string } | null {
  let outer: URL;
  try {
    outer = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const parsed = unwrapTrackedUrl(outer);
  if (!parsed) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  // pathname segments stay percent-encoded (e.g. a space in the event name
  // survives as "%20") — decode before treating it as the raw slug, or the
  // encodeURIComponent() below double-encodes it and the API 404s.
  const rawSlug = segments[segments.length - 1];
  if (!rawSlug) return null;
  const slug = decodeURIComponent(rawSlug);
  // "events.golfstatus.<env>" -> "api.golfstatus.<env>" — same environment's API, not always prod.
  const env = parsed.hostname.slice('events.golfstatus.'.length);
  return { slug, apiBase: `https://api.golfstatus.${env}/v2/tournaments` };
}

function formatEventDate(startAt: unknown): string | null {
  if (typeof startAt !== 'string' || !startAt) return null;
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

interface JsonApiResource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { type: string; id: string } | { type: string; id: string }[] }>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

// A multi-round event can play different rounds at different facilities, so
// "the course" for shipping/display purposes is specifically round 1's
// facility (found via its `number` attribute), not just facilities.data[0] -
// that relationship array isn't guaranteed ordered by round, and for a
// single-round event it's the same facility anyway.
function findRound1Facility(included: JsonApiResource[]): JsonApiResource | null {
  const rounds = included.filter(r => r.type === 'tournament-rounds');
  if (!rounds.length) return null;
  const round1 = rounds.slice().sort((a, b) => {
    const an = Number(a.attributes?.number), bn = Number(b.attributes?.number);
    return (Number.isFinite(an) ? an : Infinity) - (Number.isFinite(bn) ? bn : Infinity);
  })[0];
  const facRef = round1.relationships?.facility?.data;
  if (!facRef || Array.isArray(facRef)) return null;
  return included.find(r => r.type === facRef.type && r.id === facRef.id) || null;
}

function normalizeCountry(country: unknown): string | null {
  if (typeof country !== 'string') return null;
  const c = country.trim().toLowerCase();
  if (['usa', 'us', 'united states', 'united states of america'].includes(c)) return 'US';
  if (['canada', 'ca'].includes(c)) return 'CA';
  return null;
}

async function fetchLogo(logoUrl: unknown): Promise<{ logoBase64: string; logoContentType: string } | null> {
  if (typeof logoUrl !== 'string' || !logoUrl) return null;
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/png';
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { logoBase64: encodeBase64(bytes), logoContentType: contentType };
  } catch (err) {
    console.error('Failed to fetch tournament logo', err);
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { url } = await req.json();
    if (typeof url !== 'string' || !url) {
      return json({ error: 'Missing event URL' }, 400);
    }

    const extracted = extractSlug(url);
    if (!extracted) {
      return json({ error: "That doesn't look like a GolfStatus event URL (expected an events.golfstatus.com link)." }, 400);
    }
    const { slug, apiBase } = extracted;

    const apiRes = await fetch(`${apiBase}/${encodeURIComponent(slug)}`);
    if (!apiRes.ok) {
      return json({ error: "We couldn't find that event. Check the URL and try again." }, 400);
    }
    const body = await apiRes.json();
    const data = body?.data;
    if (!data?.attributes) {
      return json({ error: "We couldn't find that event. Check the URL and try again." }, 400);
    }

    const included: JsonApiResource[] = Array.isArray(body.included) ? body.included : [];
    const eventName = typeof data.attributes.name === 'string' ? data.attributes.name.trim() : null;
    const eventDate = formatEventDate(data.attributes['start-at']);
    const facility = findRound1Facility(included);
    const facAttrs = facility?.attributes || {};
    const logo = await fetchLogo(data.attributes.logo);

    return json({
      eventName,
      courseName: str(facAttrs.name),
      eventDate,
      courseAddressLine1: str(facAttrs.address),
      courseAddressLine2: str(facAttrs.address2),
      courseCity: str(facAttrs.city),
      courseState: str(facAttrs.state),
      coursePostalCode: str(facAttrs.postal),
      courseCountry: normalizeCountry(facAttrs.country),
      logoBase64: logo?.logoBase64 ?? null,
      logoContentType: logo?.logoContentType ?? null,
    });
  } catch (err) {
    console.error(err);
    return json({ error: String(err) }, 500);
  }
});
