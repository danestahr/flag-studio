-- Pipedrive integration, step 1: schema.
--
-- Studio drives Pipedrive deal stages one-way: when a design's review status changes
-- (see the six RPCs in 20260913000000_per_design_status_workflow.sql), the matching
-- deal moves to a configured stage. Flags and hole signs live in separate Pipedrive
-- pipelines, so each project links to up to two deals (one per design type).
--
--   projects.pipedrive_flags_deal_id / pipedrive_hs_deal_id   staff-linked Pipedrive deal ids
--   pipedrive_stage_map                                        (product_type, studio_status) -> (pipeline, stage)
--
-- product_type uses the same values as admin_actions.product_type: 'flags' | 'hole-signs'.

-- ── Deal links on projects ──────────────────────────────────
alter table "public"."projects"
  add column if not exists "pipedrive_flags_deal_id" bigint,
  add column if not exists "pipedrive_hs_deal_id" bigint;

-- The owner branch of the `projects` update policy lets a customer update their own
-- row, and RLS is row-level, not column-level - without a guard a customer could point
-- their project at any deal id and have Studio move that deal. Same shape as
-- prevent_design_status_self_update(): block the change unless the caller is staff/admin.
-- auth.uid() is null for the service role and for postgres/migrations, which stay allowed
-- (the sync edge function runs as the service role).
create or replace function public.prevent_pipedrive_link_self_update() returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $$
begin
  if (new.pipedrive_flags_deal_id is distinct from old.pipedrive_flags_deal_id
      or new.pipedrive_hs_deal_id is distinct from old.pipedrive_hs_deal_id)
     and auth.uid() is not null
     and not public.is_staff_or_admin() then
    raise exception 'Pipedrive deal links can only be changed by staff' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_pipedrive_link_self_update on public.projects;
create trigger prevent_pipedrive_link_self_update
  before update on public.projects
  for each row execute function public.prevent_pipedrive_link_self_update();

-- Same hole on insert: the owner branch of the `projects` insert policy would otherwise
-- let a customer create a project already linked to an arbitrary deal.
create or replace function public.prevent_pipedrive_link_self_insert() returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $$
begin
  if (new.pipedrive_flags_deal_id is not null or new.pipedrive_hs_deal_id is not null)
     and auth.uid() is not null
     and not public.is_staff_or_admin() then
    raise exception 'Pipedrive deal links can only be set by staff' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_pipedrive_link_self_insert on public.projects;
create trigger prevent_pipedrive_link_self_insert
  before insert on public.projects
  for each row execute function public.prevent_pipedrive_link_self_insert();

-- ── Status -> stage mapping ─────────────────────────────────
-- Pipelines/stages are managed in Pipedrive; this only stores which stage each Studio
-- status maps to. Staff/admin only, no ownership branch (same shape as the print-sheets
-- bucket policies in 20260812030000_print_sheets_storage.sql). The sync edge function
-- reads it with the service role, which bypasses RLS.
create table if not exists "public"."pipedrive_stage_map" (
  "product_type"  text   not null check (product_type in ('flags', 'hole-signs')),
  "studio_status" text   not null check (studio_status in
                    ('draft','submitted','needs_changes','proof_sent','approved','sent_to_print')),
  "pipeline_id"   bigint not null,
  "stage_id"      bigint not null,
  "updated_at"    timestamptz not null default now(),
  primary key ("product_type", "studio_status")
);

alter table "public"."pipedrive_stage_map" enable row level security;

create policy "pipedrive_stage_map select" on "public"."pipedrive_stage_map"
  for select to authenticated
  using (public.is_staff_or_admin());

create policy "pipedrive_stage_map insert" on "public"."pipedrive_stage_map"
  for insert to authenticated
  with check (public.is_staff_or_admin());

create policy "pipedrive_stage_map update" on "public"."pipedrive_stage_map"
  for update to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

create policy "pipedrive_stage_map delete" on "public"."pipedrive_stage_map"
  for delete to authenticated
  using (public.is_staff_or_admin());
