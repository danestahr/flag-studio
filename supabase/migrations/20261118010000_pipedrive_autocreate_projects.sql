-- Pipedrive integration, inbound: auto-create a Studio project when a deal enters the
-- configured "Committed" stage.
--
-- The `pipedrive-webhook` edge function receives Pipedrive's deal-change webhook, re-fetches
-- the deal from the API (the payload is never trusted), and calls
-- pipedrive_autocreate_project(). The project is created ownerless (created_by null) and
-- linked via projects.pipedrive_flags_deal_id; staff see it like any other project.
--
-- Flags only for now: the config table is keyed by product_type so hole signs can be added
-- later without a schema change.

-- ── Trigger stage config ────────────────────────────────────
-- Which stage means "committed" for a product. Same RLS shape as pipedrive_stage_map:
-- staff/admin only, no ownership branch; the edge function reads it with the service role.
create table if not exists "public"."pipedrive_autocreate_config" (
  "product_type" text   primary key check (product_type in ('flags', 'hole-signs')),
  "pipeline_id"  bigint not null,
  "stage_id"     bigint not null,
  "enabled"      boolean not null default true,
  "updated_at"   timestamptz not null default now()
);

alter table "public"."pipedrive_autocreate_config" enable row level security;

create policy "pipedrive_autocreate_config select" on "public"."pipedrive_autocreate_config"
  for select to authenticated using (public.is_staff_or_admin());
create policy "pipedrive_autocreate_config insert" on "public"."pipedrive_autocreate_config"
  for insert to authenticated with check (public.is_staff_or_admin());
create policy "pipedrive_autocreate_config update" on "public"."pipedrive_autocreate_config"
  for update to authenticated using (public.is_staff_or_admin()) with check (public.is_staff_or_admin());
create policy "pipedrive_autocreate_config delete" on "public"."pipedrive_autocreate_config"
  for delete to authenticated using (public.is_staff_or_admin());

-- ── Atomic create-or-return ─────────────────────────────────
-- Pipedrive retries webhooks and can fire several change events per deal, so creation must be
-- idempotent under concurrency. A per-deal advisory lock serializes concurrent calls, and the
-- existing-link check inside it makes the second call return the first call's project.
-- (No unique index: staff may already have linked one deal to more than one project.)
-- Service role only - never callable from a client.
create or replace function public.pipedrive_autocreate_project(
  p_product_type text,
  p_deal_id bigint,
  p_name text,
  p_customer_info jsonb
) returns table (project_id uuid, created boolean)
  language plpgsql
  security definer
  set search_path = public
  as $$
declare
  v_column text;
  v_existing uuid;
  v_new uuid;
begin
  if p_product_type = 'flags' then
    v_column := 'pipedrive_flags_deal_id';
  elsif p_product_type = 'hole-signs' then
    v_column := 'pipedrive_hs_deal_id';
  else
    raise exception 'invalid product type %', p_product_type;
  end if;

  -- Namespace the lock key by column so a flags deal and an hs deal with the same id don't contend.
  perform pg_advisory_xact_lock(hashtextextended(v_column || ':' || p_deal_id::text, 0));

  execute format('select id from public.projects where %I = $1 order by created_at limit 1', v_column)
    into v_existing using p_deal_id;
  if v_existing is not null then
    return query select v_existing, false;
    return;
  end if;

  if p_product_type = 'flags' then
    insert into public.projects (name, customer_info, pipedrive_flags_deal_id)
      values (p_name, p_customer_info, p_deal_id) returning id into v_new;
  else
    insert into public.projects (name, customer_info, pipedrive_hs_deal_id)
      values (p_name, p_customer_info, p_deal_id) returning id into v_new;
  end if;
  return query select v_new, true;
end;
$$;

revoke all on function public.pipedrive_autocreate_project(text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.pipedrive_autocreate_project(text, bigint, text, jsonb) to service_role;
