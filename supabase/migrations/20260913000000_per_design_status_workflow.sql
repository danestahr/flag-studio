-- Splits the review/approval workflow so Flags and Hole Signs progress
-- independently instead of sharing one whole-project `projects.status`.
-- A project ordering both can have flags sitting in `proof_sent` while hole
-- signs is still `draft` - today's single column can't represent that.
--
-- Wires up the dormant `flag_config.status`/`hole_sign_config.status`
-- columns (present since the baseline migration, always 'draft', never read
-- - see CLAUDE.md) as the two independent state machines, replacing
-- `projects.status` as the thing that actually gates editability and drives
-- the six review-workflow RPCs from 20260820120000_project_status_workflow.sql.
--
-- `projects.status`/`share_token`/`proof_shared_at` are left in place but
-- `status` is no longer written to by anything after this migration - the
-- column stays only as unmaintained historical data (not worth a destructive
-- drop). `share_token` stays the single source of truth for the review link:
-- product decision is one shared link with two independently-progressing
-- tabs (review.html already works this way), not a token per design type.
--
-- Backfill first: any project already mid-workflow under the old column
-- (submitted/proof_sent/needs_changes/approved/sent_to_print) gets that
-- status copied onto BOTH config rows that exist, so a project actually
-- under client review doesn't silently unlock for editing the moment RLS
-- below switches to reading the (always-'draft') per-type column instead.
update public.flag_config fc
set status = p.status
from public.projects p
where p.id = fc.project_id and p.status <> 'draft' and fc.status = 'draft';

update public.hole_sign_config hc
set status = p.status
from public.projects p
where p.id = hc.project_id and p.status <> 'draft' and hc.status = 'draft';

-- ── status CHECK constraints (mirrors projects_status_check) ─
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'flag_config_status_check' and conrelid = 'public.flag_config'::regclass
  ) then
    alter table public.flag_config
      add constraint flag_config_status_check
      check (status in ('draft','submitted','needs_changes','proof_sent','approved','sent_to_print'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'hole_sign_config_status_check' and conrelid = 'public.hole_sign_config'::regclass
  ) then
    alter table public.hole_sign_config
      add constraint hole_sign_config_status_check
      check (status in ('draft','submitted','needs_changes','proof_sent','approved','sent_to_print'));
  end if;
end $$;

-- admin_actions gets a nullable product_type so the timeline (and
-- loadLatestChangeNote's "why was I kicked back" lookup) can tell a Flags
-- action apart from a Hole Signs one - additive, same reasoning as
-- admin_id/admin_email already being nullable.
alter table public.admin_actions
  add column if not exists product_type text;

-- ── design_is_editable() ───────────────────────────────────
-- Per-design-type replacement for project_is_editable() below.
create or replace function public.design_is_editable(target_project_id uuid, target_product_type text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case target_product_type
    when 'flags' then exists (
      select 1 from public.flag_config
      where project_id = target_project_id and status in ('draft', 'needs_changes')
    )
    when 'hole-signs' then exists (
      select 1 from public.hole_sign_config
      where project_id = target_project_id and status in ('draft', 'needs_changes')
    )
    else false
  end;
$$;

revoke all on function public.design_is_editable(uuid, text) from public;
grant execute on function public.design_is_editable(uuid, text) to authenticated, anon;

-- ── prevent_design_status_self_update() ────────────────────
-- design_is_editable()'s subquery re-reads flag_config/hole_sign_config by
-- project_id, so within the same UPDATE statement it can only ever see this
-- row's pre-update status - identical for both the update policy's USING
-- and WITH CHECK. That means WITH CHECK can't actually constrain what NEW
-- status a raw client update sets; it only re-confirms the OLD status was
-- editable. Same problem `prevent_role_self_update()` solves for
-- profiles.role (20260810000000_baseline.sql) - a trigger that blocks any
-- change to `status` unless the security-definer RPC above set the
-- session-local flag right before its own update, so raw client updates
-- (which never set the flag) can't move status at all, only the six RPCs
-- (which own their own transition/permission checks) can.
create or replace function public.prevent_design_status_self_update() returns trigger
  language plpgsql
  as $$
begin
  if new.status is distinct from old.status
     and coalesce(current_setting('app.allow_design_status_change', true), 'false') <> 'true' then
    raise exception 'status cannot be changed directly; use the review-workflow RPCs';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_flag_config_status_self_update on public.flag_config;
create trigger prevent_flag_config_status_self_update
  before update on public.flag_config
  for each row execute function public.prevent_design_status_self_update();

drop trigger if exists prevent_hole_sign_config_status_self_update on public.hole_sign_config;
create trigger prevent_hole_sign_config_status_self_update
  before update on public.hole_sign_config
  for each row execute function public.prevent_design_status_self_update();

-- ── project_has_unlocked_design() ──────────────────────────
-- Covers the two RLS spots that aren't per-design-type: the `projects` row
-- itself (name, customer_info - not design content) and `project_logos`
-- (one shared pool of uploads across both design types - see CLAUDE.md,
-- there's no product_type column to gate per type). Conservative OR: if
-- EITHER existing design is locked, block new logo uploads/deletes rather
-- than risk a new upload being mistaken for content belonging to the design
-- currently under review. A design type with no config row yet doesn't
-- count against this - nothing to lock before it exists.
create or replace function public.project_has_unlocked_design(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.flag_config
    where project_id = target_project_id and status not in ('draft', 'needs_changes')
    union all
    select 1 from public.hole_sign_config
    where project_id = target_project_id and status not in ('draft', 'needs_changes')
  );
$$;

revoke all on function public.project_has_unlocked_design(uuid) from public;
grant execute on function public.project_has_unlocked_design(uuid) to authenticated, anon;

-- ── submit_design_for_review() ─────────────────────────────
-- Owner (or staff/admin acting on any project) only. draft/needs_changes -> submitted.
create or replace function public.submit_design_for_review(target_project_id uuid, target_product_type text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  caller_is_staff boolean;
  caller_email text;
begin
  caller_is_staff := public.is_staff_or_admin();

  if not (public.owns_project(target_project_id) or caller_is_staff) then
    raise exception 'project % not found or not permitted', target_project_id;
  end if;

  if target_product_type = 'flags' then
    select status into current_status from public.flag_config where project_id = target_project_id for update;
  elsif target_product_type = 'hole-signs' then
    select status into current_status from public.hole_sign_config where project_id = target_project_id for update;
  else
    raise exception 'invalid product_type %', target_product_type;
  end if;

  if current_status is null then
    raise exception 'no % design found for project %', target_product_type, target_project_id;
  end if;

  if current_status not in ('draft', 'needs_changes') then
    raise exception 'cannot submit % design from status %', target_product_type, current_status;
  end if;

  perform set_config('app.allow_design_status_change', 'true', true);

  if target_product_type = 'flags' then
    update public.flag_config set status = 'submitted', updated_at = now() where project_id = target_project_id;
  else
    update public.hole_sign_config set status = 'submitted', updated_at = now() where project_id = target_project_id;
  end if;

  if caller_is_staff then
    select email into caller_email from public.profiles where id = auth.uid();
  end if;

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (
    case when caller_is_staff then auth.uid() else null end,
    caller_email,
    target_project_id,
    target_product_type,
    'submit_for_review',
    null
  );
end;
$$;

revoke all on function public.submit_design_for_review(uuid, text) from public;
grant execute on function public.submit_design_for_review(uuid, text) to authenticated;

-- ── admin_request_design_changes() ─────────────────────────
-- Staff/admin only. submitted -> needs_changes.
create or replace function public.admin_request_design_changes(target_project_id uuid, target_product_type text, note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  caller_email text;
begin
  if not public.is_staff_or_admin() then
    raise exception 'only staff or admin can request changes';
  end if;

  if target_product_type = 'flags' then
    select status into current_status from public.flag_config where project_id = target_project_id for update;
  elsif target_product_type = 'hole-signs' then
    select status into current_status from public.hole_sign_config where project_id = target_project_id for update;
  else
    raise exception 'invalid product_type %', target_product_type;
  end if;

  if current_status is null then
    raise exception 'no % design found for project %', target_product_type, target_project_id;
  end if;

  if current_status <> 'submitted' then
    raise exception 'cannot request changes on % design from status %', target_product_type, current_status;
  end if;

  perform set_config('app.allow_design_status_change', 'true', true);

  if target_product_type = 'flags' then
    update public.flag_config set status = 'needs_changes', updated_at = now() where project_id = target_project_id;
  else
    update public.hole_sign_config set status = 'needs_changes', updated_at = now() where project_id = target_project_id;
  end if;

  select email into caller_email from public.profiles where id = auth.uid();

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (auth.uid(), caller_email, target_project_id, target_product_type, 'admin_request_changes', note);
end;
$$;

revoke all on function public.admin_request_design_changes(uuid, text, text) from public;
grant execute on function public.admin_request_design_changes(uuid, text, text) to authenticated;

-- ── admin_send_design_proof() ──────────────────────────────
-- Staff/admin only. submitted/needs_changes/proof_sent -> proof_sent (the
-- last one covers a resend/reshare while still pending, same as the old
-- admin_send_proof grew to accept - see 20260912000000/20260912010000).
-- share_token/proof_shared_at stay project-level (one shared review link).
create or replace function public.admin_send_design_proof(target_project_id uuid, target_product_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  existing_token text;
  caller_email text;
  final_token text;
begin
  if not public.is_staff_or_admin() then
    raise exception 'only staff or admin can send a proof';
  end if;

  if target_product_type = 'flags' then
    select status into current_status from public.flag_config where project_id = target_project_id for update;
  elsif target_product_type = 'hole-signs' then
    select status into current_status from public.hole_sign_config where project_id = target_project_id for update;
  else
    raise exception 'invalid product_type %', target_product_type;
  end if;

  if current_status is null then
    raise exception 'no % design found for project %', target_product_type, target_project_id;
  end if;

  if current_status not in ('submitted', 'needs_changes', 'proof_sent') then
    raise exception 'cannot send proof for % design from status %', target_product_type, current_status;
  end if;

  select share_token into existing_token from public.projects where id = target_project_id for update;
  final_token := coalesce(existing_token, gen_random_uuid()::text);

  update public.projects
  set share_token = final_token, proof_shared_at = now()
  where id = target_project_id;

  perform set_config('app.allow_design_status_change', 'true', true);

  if target_product_type = 'flags' then
    update public.flag_config set status = 'proof_sent', updated_at = now() where project_id = target_project_id;
  else
    update public.hole_sign_config set status = 'proof_sent', updated_at = now() where project_id = target_project_id;
  end if;

  select email into caller_email from public.profiles where id = auth.uid();

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (auth.uid(), caller_email, target_project_id, target_product_type, 'admin_send_proof', null);

  return final_token;
end;
$$;

revoke all on function public.admin_send_design_proof(uuid, text) from public;
grant execute on function public.admin_send_design_proof(uuid, text) to authenticated;

-- ── client_approve_design_proof() ──────────────────────────
-- Anonymous, share-token-gated. proof_sent -> approved.
create or replace function public.client_approve_design_proof(target_project_id uuid, target_product_type text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
begin
  if not public.has_matching_share_token(target_project_id) then
    raise exception 'invalid or missing share token';
  end if;

  if target_product_type = 'flags' then
    select status into current_status from public.flag_config where project_id = target_project_id for update;
  elsif target_product_type = 'hole-signs' then
    select status into current_status from public.hole_sign_config where project_id = target_project_id for update;
  else
    raise exception 'invalid product_type %', target_product_type;
  end if;

  if current_status is null then
    raise exception 'no % design found for project %', target_product_type, target_project_id;
  end if;

  if current_status <> 'proof_sent' then
    raise exception 'cannot approve % design from status %', target_product_type, current_status;
  end if;

  perform set_config('app.allow_design_status_change', 'true', true);

  if target_product_type = 'flags' then
    update public.flag_config set status = 'approved', updated_at = now() where project_id = target_project_id;
  else
    update public.hole_sign_config set status = 'approved', updated_at = now() where project_id = target_project_id;
  end if;

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (null, null, target_project_id, target_product_type, 'client_approve_proof', null);
end;
$$;

revoke all on function public.client_approve_design_proof(uuid, text) from public;
grant execute on function public.client_approve_design_proof(uuid, text) to anon, authenticated;

-- ── client_reject_design_proof() ───────────────────────────
-- Anonymous, share-token-gated. proof_sent -> needs_changes.
create or replace function public.client_reject_design_proof(target_project_id uuid, target_product_type text, note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
begin
  if not public.has_matching_share_token(target_project_id) then
    raise exception 'invalid or missing share token';
  end if;

  if target_product_type = 'flags' then
    select status into current_status from public.flag_config where project_id = target_project_id for update;
  elsif target_product_type = 'hole-signs' then
    select status into current_status from public.hole_sign_config where project_id = target_project_id for update;
  else
    raise exception 'invalid product_type %', target_product_type;
  end if;

  if current_status is null then
    raise exception 'no % design found for project %', target_product_type, target_project_id;
  end if;

  if current_status <> 'proof_sent' then
    raise exception 'cannot reject % design from status %', target_product_type, current_status;
  end if;

  perform set_config('app.allow_design_status_change', 'true', true);

  if target_product_type = 'flags' then
    update public.flag_config set status = 'needs_changes', updated_at = now() where project_id = target_project_id;
  else
    update public.hole_sign_config set status = 'needs_changes', updated_at = now() where project_id = target_project_id;
  end if;

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (null, null, target_project_id, target_product_type, 'client_reject_proof', note);
end;
$$;

revoke all on function public.client_reject_design_proof(uuid, text, text) from public;
grant execute on function public.client_reject_design_proof(uuid, text, text) to anon, authenticated;

-- ── admin_mark_design_sent_to_print() ──────────────────────
-- Staff/admin only, terminal transition. approved -> sent_to_print.
create or replace function public.admin_mark_design_sent_to_print(
  target_project_id uuid,
  target_product_type text,
  storage_path text default null,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  caller_email text;
  combined_note text;
begin
  if not public.is_staff_or_admin() then
    raise exception 'only staff or admin can mark a design sent to print';
  end if;

  if target_product_type = 'flags' then
    select status into current_status from public.flag_config where project_id = target_project_id for update;
  elsif target_product_type = 'hole-signs' then
    select status into current_status from public.hole_sign_config where project_id = target_project_id for update;
  else
    raise exception 'invalid product_type %', target_product_type;
  end if;

  if current_status is null then
    raise exception 'no % design found for project %', target_product_type, target_project_id;
  end if;

  if current_status <> 'approved' then
    raise exception 'cannot mark % design sent to print from status %', target_product_type, current_status;
  end if;

  perform set_config('app.allow_design_status_change', 'true', true);

  if target_product_type = 'flags' then
    update public.flag_config set status = 'sent_to_print', updated_at = now() where project_id = target_project_id;
  else
    update public.hole_sign_config set status = 'sent_to_print', updated_at = now() where project_id = target_project_id;
  end if;

  select email into caller_email from public.profiles where id = auth.uid();

  combined_note := note;
  if storage_path is not null then
    combined_note := case
      when combined_note is not null then combined_note || ' — print-sheets object: ' || storage_path
      else 'print-sheets object: ' || storage_path
    end;
  end if;

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (auth.uid(), caller_email, target_project_id, target_product_type, 'sent_to_print', combined_note);
end;
$$;

revoke all on function public.admin_mark_design_sent_to_print(uuid, text, text, text) from public;
grant execute on function public.admin_mark_design_sent_to_print(uuid, text, text, text) to authenticated;

-- ── drop the old whole-project RPCs ────────────────────────
-- Fully replaced by the per-design-type RPCs above; every call site is
-- updated in the same change (src/supabase.js, project.js, review.js).
-- submit_project_for_review had zero UI callers even before this - the
-- others were live, hence the backfill above before anything could unlock.
drop function if exists public.submit_project_for_review(uuid);
drop function if exists public.admin_request_changes(uuid, text);
drop function if exists public.admin_send_proof(uuid);
drop function if exists public.client_approve_proof(uuid);
drop function if exists public.client_reject_proof(uuid, text);
drop function if exists public.admin_mark_sent_to_print(uuid, text, text);

-- ── RLS: switch from projects.status to the per-design columns ─
drop policy "projects update" on public.projects;
create policy "projects update" on public.projects
  for update to authenticated
  using ((created_by = auth.uid() and public.project_has_unlocked_design(id)) or public.is_staff_or_admin())
  with check ((created_by = auth.uid() and public.project_has_unlocked_design(id)) or public.is_staff_or_admin());

drop policy "flag_config update" on public.flag_config;
create policy "flag_config update" on public.flag_config
  for update to authenticated
  using ((public.owns_project(project_id) and public.design_is_editable(project_id, 'flags')) or public.is_staff_or_admin())
  with check ((public.owns_project(project_id) and public.design_is_editable(project_id, 'flags')) or public.is_staff_or_admin());

drop policy "hole_sign_config update" on public.hole_sign_config;
create policy "hole_sign_config update" on public.hole_sign_config
  for update to authenticated
  using ((public.owns_project(project_id) and public.design_is_editable(project_id, 'hole-signs')) or public.is_staff_or_admin())
  with check ((public.owns_project(project_id) and public.design_is_editable(project_id, 'hole-signs')) or public.is_staff_or_admin());

drop policy "project_logos insert" on public.project_logos;
create policy "project_logos insert" on public.project_logos
  for insert to authenticated, anon
  with check (
    public.project_is_ownerless(project_id)
    or (public.owns_project(project_id) and public.project_has_unlocked_design(project_id))
    or public.is_staff_or_admin()
  );

drop policy "project_logos delete" on public.project_logos;
create policy "project_logos delete" on public.project_logos
  for delete to authenticated
  using ((public.owns_project(project_id) and public.project_has_unlocked_design(project_id)) or public.is_staff_or_admin());

-- Now that every policy above reads design_is_editable()/
-- project_has_unlocked_design() instead, nothing depends on this anymore.
drop function if exists public.project_is_editable(uuid);
