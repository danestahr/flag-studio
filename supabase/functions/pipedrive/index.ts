// Pipedrive integration. Studio drives deal stages one-way; Studio only writes deals
// (pipelines/stages are managed in Pipedrive and merely read here for the mapping UI).
//
// Secrets: PIPEDRIVE_API_TOKEN, PIPEDRIVE_DOMAIN (the "acme" in acme.pipedrive.com).
//
// Actions (POST { action, ... }):
//   list-pipelines  staff   -> { pipelines: [{ id, name, stages: [{ id, name, order }] }] }
//   search-deals    staff   { term, productType } -> (only deals in the pipeline(s) mapped for that product) { deals: [{ id, title, stage_id, status }] }
//   get-deal        staff   { dealId } -> { deal: { id, title, status, stage_id, url } } (404 if gone)
//   list-board      staff   { productType } -> { pipelineId, stages: [{ id, name, order }], deals: [{ id, title, stage_id, org, person, owner, value, currency, url, ... }] }
//                   Open deals in the pipeline mapped for that product, for the read-only board view.
//   link-deal       staff   { projectId, productType, dealId | null } -> stores/clears the link
//   move-deal       staff OR service role   { projectId, productType }
//                   Moves the linked deal to the stage mapped to the design's CURRENT status.
//                   The status is read from the DB here, never taken from the caller, so a
//                   staff-triggered retry is idempotent and a client can't claim a status.
//                   The service-role path is what the admin_actions trigger and the retry cron use
//                   (step 3 / 5); it may pass `logId` (a pipedrive_sync_log row to record the outcome
//                   on). Without one - e.g. a staff "Retry now" - a new log row is created.
//
// Optional secrets for the "Design Studio Project Link" deal field: PIPEDRIVE_PROJECT_LINK_FIELD
// (the custom field's API key - a 40-char hash from Pipedrive Settings > Data fields) and APP_URL.
// When both are set, link-deal writes the project URL to that field and clears it on unlink/relink.
//
// Role is re-derived server-side from the caller's JWT (see send-print-sheet-ready);
// the service-role path is a constant-time match on the project's own service key.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { buildCustomerInfoFromDeal } from '../_shared/pipedrive-deal-info.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PIPEDRIVE_API_TOKEN = Deno.env.get('PIPEDRIVE_API_TOKEN');
// Accept "acme", "acme.pipedrive.com" or "https://acme.pipedrive.com/" - only the subdomain is used.
const PIPEDRIVE_DOMAIN = Deno.env.get('PIPEDRIVE_DOMAIN')
  ?.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.pipedrive\.com$/i, '') || undefined;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ── Auth ────────────────────────────────────────────────────

// The pg_net trigger / retry cron send the Vault `service_role_key`, which is the legacy
// service_role JWT. The function's own SUPABASE_SERVICE_ROLE_KEY env can be a different
// representation of the same key (e.g. an sb_secret_ key), so an exact string match is not
// enough. Fall back to asking GoTrue: the admin users endpoint only answers for a real
// service-role credential, so this is verified, not a trusted claim.
function exactServiceKey(authHeader: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token.length !== SUPABASE_SERVICE_ROLE_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ SUPABASE_SERVICE_ROLE_KEY.charCodeAt(i);
  return diff === 0;
}

async function isServiceRole(authHeader: string): Promise<boolean> {
  if (exactServiceKey(authHeader)) return true;
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1`, {
    headers: { apikey: token, Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

async function getCallerRole(authHeader: string): Promise<string | null> {
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: authHeader },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  if (!user?.id) return null;

  const rows = await rest(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`);
  return rows?.[0]?.role ?? null;
}

// ── Supabase REST (service role) ────────────────────────────

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
  if (!res.ok) throw new HttpError(500, `Database error (${res.status}): ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Pipedrive API (v2) ──────────────────────────────────────

async function pd(path: string, init: RequestInit = {}) {
  if (!PIPEDRIVE_API_TOKEN || !PIPEDRIVE_DOMAIN) {
    throw new HttpError(500, 'Pipedrive is not configured (PIPEDRIVE_API_TOKEN / PIPEDRIVE_DOMAIN)');
  }
  const res = await fetch(`https://${PIPEDRIVE_DOMAIN}.pipedrive.com/api/v2/${path}`, {
    ...init,
    headers: { 'x-api-token': PIPEDRIVE_API_TOKEN, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    // 404 = deal gone from Pipedrive; surface it distinctly so the UI can say so. A deal in
    // Pipedrive's trash answers writes with 403 "Cannot update a deleted deal" - same thing to us.
    const gone = res.status === 404 || (res.status === 403 && /deleted deal/i.test(text));
    throw new HttpError(gone ? 404 : 502, `Pipedrive ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── Helpers ─────────────────────────────────────────────────

type ProductType = 'flags' | 'hole-signs';

function parseProductType(v: unknown): ProductType {
  if (v !== 'flags' && v !== 'hole-signs') throw new HttpError(400, 'Invalid productType');
  return v;
}

function parseUuid(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw new HttpError(400, 'Invalid projectId');
  }
  return v;
}

function parseDealId(v: unknown): number {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, 'Invalid dealId');
  return n;
}

const DEAL_COLUMN: Record<ProductType, string> = {
  flags: 'pipedrive_flags_deal_id',
  'hole-signs': 'pipedrive_hs_deal_id',
};
const STATUS_TABLE: Record<ProductType, string> = {
  flags: 'flag_config',
  'hole-signs': 'hole_sign_config',
};

const PROJECT_LINK_FIELD = Deno.env.get('PIPEDRIVE_PROJECT_LINK_FIELD')?.trim() || undefined;
const APP_URL = Deno.env.get('APP_URL')?.replace(/\/$/, '');

// Write (or clear, with null) the project URL on a deal. Best-effort: the Studio link itself is
// already saved, so a Pipedrive hiccup here is reported as a warning rather than failing the link.
async function setProjectLinkField(dealId: number, projectId: string | null): Promise<string | null> {
  if (!PROJECT_LINK_FIELD || !APP_URL) return null; // feature not configured
  try {
    const value = projectId ? `${APP_URL}/project?project=${projectId}` : null;
    await pd(`deals/${dealId}`, { method: 'PATCH', body: JSON.stringify({ custom_fields: { [PROJECT_LINK_FIELD]: value } }) });
    return null;
  } catch (e) {
    console.error('project link field update failed', dealId, e);
    // A deal already gone from Pipedrive has nothing to clear.
    return e instanceof HttpError && e.status === 404 ? null : 'Linked, but the project link could not be written to the Pipedrive deal.';
  }
}

function dealUrl(id: number) {
  return `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/deal/${id}`;
}

// ── Actions ─────────────────────────────────────────────────

async function listPipelines() {
  const [pipes, stages] = await Promise.all([pd('pipelines?limit=500'), pd('stages?limit=500')]);
  const byPipeline = new Map<number, { id: number; name: string; order: number }[]>();
  for (const s of stages.data ?? []) {
    const list = byPipeline.get(s.pipeline_id) ?? [];
    list.push({ id: s.id, name: s.name, order: s.order_nr });
    byPipeline.set(s.pipeline_id, list);
  }
  return {
    pipelines: (pipes.data ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      stages: (byPipeline.get(p.id) ?? []).sort((a, b) => a.order - b.order),
    })),
  };
}

// Studio only touches deals in the pipeline(s) its status->stage map points at for that product
// (e.g. the Flags pipeline), so search and linking can't reach deals in other pipelines. Derived
// from pipedrive_stage_map rather than a separate setting: the pipeline you map Flags statuses to
// IS the Flags pipeline. Fails closed until the map exists.
async function allowedPipelines(productType: ProductType): Promise<Set<number>> {
  const rows = await rest(`pipedrive_stage_map?product_type=eq.${productType}&select=pipeline_id`);
  const ids = new Set<number>((rows ?? []).map((r: any) => Number(r.pipeline_id)));
  if (!ids.size) {
    const label = productType === 'flags' ? 'Flags' : 'Hole Signs';
    throw new HttpError(409, `Set up the ${label} stage mapping first (Profile > Pipedrive stage mapping) so Studio knows which pipeline to use.`);
  }
  return ids;
}

async function searchDeals(term: unknown, productType: ProductType) {
  if (typeof term !== 'string' || term.trim().length < 2) throw new HttpError(400, 'Search term must be at least 2 characters');
  const allowed = await allowedPipelines(productType);
  const [data, stages] = await Promise.all([
    // Pipedrive's search has no pipeline filter, so over-fetch and filter here.
    pd(`deals/search?term=${encodeURIComponent(term.trim())}&fields=title&limit=100`),
    pd('stages?limit=500'),
  ]);
  const pipelineOfStage = new Map<number, number>((stages.data ?? []).map((st: any) => [Number(st.id), Number(st.pipeline_id)]));
  return {
    deals: (data.data?.items ?? [])
      .filter((i: any) => allowed.has(pipelineOfStage.get(Number(i.item.stage?.id)) ?? -1))
      .slice(0, 20)
      .map((i: any) => ({
        id: i.item.id,
        title: i.item.title,
        stage_id: i.item.stage?.id ?? null,
        status: i.item.status ?? null,
      })),
  };
}

// A deleted deal (Pipedrive keeps it in the trash for a while) still answers GET with 200 and
// status "deleted" - only writes fail. Treat it as gone so it can't be linked or shown as live.
function assertLive(d: any) {
  if (d?.data?.is_deleted || d?.data?.status === 'deleted') throw new HttpError(404, 'Deal was deleted in Pipedrive');
}

async function getDeal(dealIdRaw: unknown) {
  const dealId = parseDealId(dealIdRaw);
  const d = await pd(`deals/${dealId}`);
  assertLive(d);
  return {
    deal: { id: d.data.id, title: d.data.title, status: d.data.status ?? null, stage_id: d.data.stage_id ?? null, url: dealUrl(d.data.id) },
  };
}

// Read-only board: every open deal in the product's pipeline, plus that pipeline's stages in order.
// Uses the v1 pipeline-deals endpoint because it inlines org/person/owner names (v2 only returns ids,
// which would cost one lookup per deal).
async function listBoard(productType: ProductType) {
  const allowed = [...(await allowedPipelines(productType))];
  const pipelineId = allowed[0];
  const [{ pipelines }] = await Promise.all([listPipelines()]);
  const pipeline = pipelines.find((p: any) => Number(p.id) === pipelineId);
  if (!pipeline) throw new HttpError(404, 'Mapped pipeline no longer exists in Pipedrive');

  const deals: any[] = [];
  let start = 0;
  for (let page = 0; page < 20; page++) { // hard cap: 20 x 500 deals
    const res = await fetch(
      `https://${PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1/pipelines/${pipelineId}/deals?limit=500&start=${start}`,
      { headers: { 'x-api-token': PIPEDRIVE_API_TOKEN!, 'Content-Type': 'application/json' } },
    );
    if (!res.ok) throw new HttpError(502, `Pipedrive ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    deals.push(...(body.data ?? []));
    const pg = body.additional_data?.pagination;
    if (!pg?.more_items_in_collection) break;
    start = pg.next_start;
  }

  return {
    pipelineId,
    pipelineName: pipeline.name,
    stages: pipeline.stages,
    deals: deals
      .filter((d) => d.status === 'open' && !d.is_deleted)
      .map((d) => ({
        id: d.id,
        title: d.title,
        stage_id: d.stage_id,
        org: d.org_name ?? d.org_id?.name ?? null,
        person: d.person_name ?? d.person_id?.name ?? null,
        owner: d.owner_name ?? d.user_id?.name ?? null,
        value: d.value ?? 0,
        currency: d.currency ?? null,
        next_activity_date: d.next_activity_date ?? null,
        url: dealUrl(d.id),
      })),
  };
}

// Staff: create the Studio project for a deal (or return the one already linked), prefilled from the
// deal. Same idempotent RPC the webhook uses, so a double-click or a webhook race can't duplicate.
async function createFromDeal(productType: ProductType, dealIdRaw: unknown) {
  const dealId = parseDealId(dealIdRaw);
  let d: any;
  try {
    d = await pd(`deals/${dealId}`);
    assertLive(d);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new HttpError(404, 'Deal not found in Pipedrive');
    throw e;
  }
  if (!(await allowedPipelines(productType)).has(Number(d.data.pipeline_id))) {
    throw new HttpError(403, `That deal isn't in the ${productType === 'flags' ? 'Flags' : 'Hole Signs'} pipeline.`);
  }
  const info = await buildCustomerInfoFromDeal(d.data);
  const rows = await rest('rpc/pipedrive_autocreate_project', {
    method: 'POST',
    body: JSON.stringify({ p_product_type: productType, p_deal_id: dealId, p_name: d.data.title, p_customer_info: info }),
  });
  const row = rows?.[0];
  if (!row?.project_id) throw new HttpError(502, 'Could not create the project');
  const warning = row.created ? await setProjectLinkField(dealId, row.project_id) : null;
  return { ok: true, projectId: row.project_id, created: !!row.created, ...(warning ? { warning } : {}) };
}

async function linkDeal(projectId: string, productType: ProductType, dealIdRaw: unknown) {
  const column = DEAL_COLUMN[productType];
  const projects = await rest(`projects?id=eq.${projectId}&select=${column},customer_info&limit=1`);
  if (!projects?.length) throw new HttpError(400, 'Invalid project');
  const previousDealId: number | null = projects[0][column] ?? null;

  // null clears the link. Otherwise confirm the deal exists in Pipedrive before storing it.
  let deal: { id: number; title: string; url: string } | null = null;
  let liveDeal: any = null;
  let dealId: number | null = null;
  if (dealIdRaw !== null) {
    dealId = parseDealId(dealIdRaw);
    try {
      const d = await pd(`deals/${dealId}`);
      assertLive(d);
      if (!(await allowedPipelines(productType)).has(Number(d.data.pipeline_id))) {
        throw new HttpError(403, `That deal isn't in the ${productType === 'flags' ? 'Flags' : 'Hole Signs'} pipeline.`);
      }
      deal = { id: d.data.id, title: d.data.title, url: dealUrl(d.data.id) };
      liveDeal = d.data;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new HttpError(404, 'Deal not found in Pipedrive');
      throw e;
    }
  }
  // Linking a deal also pulls in event details the project is missing (never overwrites a value
  // staff or the customer already entered). Best-effort: the link itself must still succeed.
  let customerInfo = projects[0].customer_info ?? {};
  const filled: string[] = [];
  if (dealId && liveDeal) {
    try {
      const fromDeal = await buildCustomerInfoFromDeal(liveDeal);
      customerInfo = { ...customerInfo };
      for (const [k, v] of Object.entries(fromDeal)) {
        if (v === null || v === undefined || v === '') continue;
        const cur = customerInfo[k];
        if (cur === undefined || cur === null || cur === '') { customerInfo[k] = v; filled.push(k); }
      }
    } catch (e) { console.error('fill from deal failed', dealId, e); }
  }
  await rest(`projects?id=eq.${projectId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ [column]: dealId, ...(filled.length ? { customer_info: customerInfo } : {}) }),
  });

  // Clear the field on the deal being unlinked / replaced, then set it on the new one.
  let warning: string | null = null;
  if (previousDealId && previousDealId !== dealId) warning = await setProjectLinkField(previousDealId, null);
  if (dealId) warning = (await setProjectLinkField(dealId, projectId)) ?? warning;
  return { ok: true, deal, filled, ...(warning ? { warning } : {}) };
}

// Service-role only (fired by the projects BEFORE DELETE trigger). Skips any deal that another
// project has since been linked to, so deleting an old project can't wipe a live link.
async function clearLinkField(dealIdsRaw: unknown) {
  if (!Array.isArray(dealIdsRaw)) throw new HttpError(400, 'Invalid dealIds');
  const cleared: number[] = [];
  for (const raw of dealIdsRaw.slice(0, 10)) {
    const dealId = parseDealId(raw);
    const inUse = await rest(
      `projects?or=(pipedrive_flags_deal_id.eq.${dealId},pipedrive_hs_deal_id.eq.${dealId})&select=id&limit=1`,
    );
    if (inUse?.length) continue;
    await setProjectLinkField(dealId, null);
    cleared.push(dealId);
  }
  return { ok: true, cleared };
}

// Service-role only, one-off: write the project URL onto every already-linked deal. Batched
// (offset/limit) so a big backlog stays inside the function's time limit; call again with the
// returned `next` until it is null. Idempotent. Returns the failures instead of aborting.
async function backfillLinkField(offsetRaw: unknown, limitRaw: unknown) {
  if (!PROJECT_LINK_FIELD || !APP_URL) throw new HttpError(409, 'PIPEDRIVE_PROJECT_LINK_FIELD / APP_URL not set');
  const offset = Math.max(0, Number(offsetRaw) || 0);
  const limit = Math.min(100, Math.max(1, Number(limitRaw) || 25));
  const rows = await rest(
    `projects?or=(pipedrive_flags_deal_id.not.is.null,pipedrive_hs_deal_id.not.is.null)` +
      `&select=id,pipedrive_flags_deal_id,pipedrive_hs_deal_id&order=created_at.asc,id.asc&offset=${offset}&limit=${limit}`,
  );
  let updated = 0;
  const failed: { projectId: string; dealId: number }[] = [];
  for (const r of rows ?? []) {
    for (const dealId of [r.pipedrive_flags_deal_id, r.pipedrive_hs_deal_id]) {
      if (!dealId) continue;
      if (await setProjectLinkField(Number(dealId), r.id)) failed.push({ projectId: r.id, dealId: Number(dealId) });
      else updated++;
    }
  }
  return { ok: true, updated, failed, next: (rows?.length ?? 0) === limit ? offset + limit : null };
}

async function moveDeal(projectId: string, productType: ProductType) {
  const column = DEAL_COLUMN[productType];
  const projects = await rest(`projects?id=eq.${projectId}&select=${column}&limit=1`);
  if (!projects?.length) throw new HttpError(400, 'Invalid project');
  const dealId = projects[0][column];
  // Not linked is a normal state (staff link deals manually), not an error.
  if (!dealId) return { ok: true, skipped: 'no_deal_linked' };

  const cfg = await rest(`${STATUS_TABLE[productType]}?project_id=eq.${projectId}&select=status&limit=1`);
  // No design row yet = 'not_started' (mappable like any other status; see
  // 20261118000000_pipedrive_not_started_status.sql).
  const status = cfg?.[0]?.status ?? 'not_started';

  const map = await rest(
    `pipedrive_stage_map?product_type=eq.${productType}&studio_status=eq.${status}&select=pipeline_id,stage_id&limit=1`,
  );
  // Statuses without a mapped stage are intentionally left alone (e.g. nobody wants `draft` to move a deal).
  if (!map?.length) return { ok: true, skipped: 'no_stage_mapped', status };

  await pd(`deals/${dealId}`, { method: 'PATCH', body: JSON.stringify({ stage_id: map[0].stage_id }) });
  return { ok: true, moved: true, dealId, status, stageId: map[0].stage_id };
}

// ── Sync log (pipedrive_sync_log) ───────────────────────────
// Records the outcome of every move-deal so failures are visible to staff and the retry cron
// (public.pipedrive_retry_due) knows what to re-dispatch. Logging problems must never mask the
// real result, so every write here is best-effort.

async function logStart(projectId: string, productType: ProductType): Promise<string | null> {
  try {
    const rows = await rest('pipedrive_sync_log', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ project_id: projectId, product_type: productType }),
    });
    return rows?.[0]?.id ?? null;
  } catch (e) {
    console.error('pipedrive_sync_log insert failed', e);
    return null;
  }
}

async function logFinish(
  logId: string,
  projectId: string,
  productType: ProductType,
  patch: { state: 'ok' | 'skipped' | 'failed'; studio_status?: string | null; last_error?: string | null; retryable?: boolean },
) {
  try {
    // project/product in the filter so a mismatched logId can't touch another row.
    await rest(`pipedrive_sync_log?id=eq.${logId}&project_id=eq.${projectId}&product_type=eq.${productType}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error('pipedrive_sync_log update failed', e);
  }
}

async function moveDealLogged(projectId: string, productType: ProductType, logIdIn: string | null) {
  const logId = logIdIn ?? (await logStart(projectId, productType));
  try {
    const result = await moveDeal(projectId, productType);
    if (logId) {
      await logFinish(logId, projectId, productType, {
        state: result.moved ? 'ok' : 'skipped',
        studio_status: (result as any).status ?? null,
        last_error: (result as any).skipped ? String((result as any).skipped) : null,
        retryable: true,
      });
    }
    return result;
  } catch (e) {
    if (logId) {
      const message = e instanceof HttpError ? e.message : 'Internal error';
      await logFinish(logId, projectId, productType, {
        state: 'failed',
        last_error: message.slice(0, 500),
        // 404 = the deal is gone from Pipedrive: retrying can't help, staff must relink.
        retryable: !(e instanceof HttpError && e.status === 404),
      });
    }
    throw e;
  }
}

// ── Entry ───────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing auth' }, 401);

    const service = await isServiceRole(authHeader);
    if (!service) {
      const role = await getCallerRole(authHeader);
      if (role !== 'staff' && role !== 'admin') return json({ error: 'Forbidden' }, 403);
    }

    const body = await req.json();
    switch (body?.action) {
      case 'list-pipelines':
        return json(await listPipelines(), 200);
      case 'search-deals':
        return json(await searchDeals(body.term, parseProductType(body.productType)), 200);
      case 'get-deal':
        return json(await getDeal(body.dealId), 200);
      case 'list-board':
        return json(await listBoard(parseProductType(body.productType)), 200);
      case 'link-deal':
        return json(await linkDeal(parseUuid(body.projectId), parseProductType(body.productType), body.dealId ?? null), 200);
      case 'create-from-deal':
        return json(await createFromDeal(parseProductType(body.productType), body.dealId), 200);
      case 'set-link-field': {
        if (!service) return json({ error: 'Forbidden' }, 403);
        const warning = await setProjectLinkField(parseDealId(body.dealId), parseUuid(body.projectId));
        return json({ ok: true, ...(warning ? { warning } : {}) }, 200);
      }
      case 'clear-link-field':
        if (!service) return json({ error: 'Forbidden' }, 403);
        return json(await clearLinkField(body.dealIds), 200);
      case 'backfill-link-field':
        if (!service) return json({ error: 'Forbidden' }, 403);
        return json(await backfillLinkField(body.offset, body.limit), 200);
      case 'move-deal': {
        // Only the trusted service-role path may name a log row.
        const logId = service && body.logId ? parseUuid(body.logId) : null;
        return json(await moveDealLogged(parseUuid(body.projectId), parseProductType(body.productType), logId), 200);
      }
      default:
        return json({ error: 'Unknown action' }, 400);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('pipedrive function error', e);
    return json({ error: 'Internal error' }, 500);
  }
});
