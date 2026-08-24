-- Wires up the project submission/review/proof/print state machine.
--
-- projects.status has existed since the baseline migration but has never had
-- a CHECK constraint and no code path has ever written anything but 'draft'
-- to it - this migration is the first thing that actually transitions it.
-- Every transition goes through a SECURITY DEFINER RPC that re-implements
-- its own permission and status-precondition checks (raises on a bad
-- precondition rather than relying on RLS to silently no-op an update) -
-- same reasoning as grant_role() vs. a direct `profiles.role` write.
--
-- All six RPCs log to admin_actions, not just the staff/admin-triggered
-- ones: admin_id/admin_email are already nullable columns with an
-- ON DELETE SET NULL fk, so a customer- or share-token-triggered row with
-- both null fits the existing shape without a schema change. This
-- repurposes "admin actions" into "project lifecycle events" - a deliberate
-- choice to get one unified timeline instead of a second, mostly-overlapping
-- audit table.
--
-- Every RPC is SECURITY DEFINER uniformly, even the ones that could in
-- theory run as SECURITY INVOKER against existing policies: the two
-- client_*_proof functions have no auth.uid() at all (anon, share-token
-- gated) and must bypass RLS outright, and mixing security modes across six
-- otherwise-parallel functions would make them harder to reason about
-- together.
--
-- This migration is safe to ship ahead of any UI change: every project in
-- production today is status='draft' (the only value any code path has ever
-- written), and 'draft' is unconditionally editable, so the new locking
-- policies below change zero observed behavior until something actually
-- calls one of these RPCs.

-- ── projects.status constraint ─────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_status_check'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_status_check
      check (status in ('draft','submitted','needs_changes','proof_sent','approved','sent_to_print'));
  end if;
end $$;

-- flag_config.status / hole_sign_config.status intentionally left alone -
-- confirmed unused by any code path, and this workflow is project-level
-- only. Adding a constraint there would be scope creep with no behavior
-- change.

-- ── project_is_editable() ──────────────────────────────────
create or replace function "public"."project_is_editable"("target_project_id" uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects
    where id = target_project_id
      and status in ('draft', 'needs_changes')
  );
$$;

revoke all on function "public"."project_is_editable"(uuid) from public;
grant execute on function "public"."project_is_editable"(uuid) to "authenticated", "anon";

-- ── submit_project_for_review() ────────────────────────────
-- Owner (or staff/admin acting on any project) only. draft/needs_changes -> submitted.
create or replace function "public"."submit_project_for_review"("target_project_id" uuid)
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

  select status into current_status
  from public.projects
  where id = target_project_id
  for update;

  if current_status is null then
    raise exception 'project % not found', target_project_id;
  end if;

  if current_status not in ('draft', 'needs_changes') then
    raise exception 'cannot submit project from status %', current_status;
  end if;

  update public.projects
  set status = 'submitted', updated_at = now()
  where id = target_project_id;

  if caller_is_staff then
    select email into caller_email from public.profiles where id = auth.uid();
  end if;

  insert into public.admin_actions (admin_id, admin_email, project_id, action, note)
  values (
    case when caller_is_staff then auth.uid() else null end,
    caller_email,
    target_project_id,
    'submit_for_review',
    null
  );
end;
$$;

revoke all on function "public"."submit_project_for_review"(uuid) from public;
grant execute on function "public"."submit_project_for_review"(uuid) to "authenticated";

-- ── admin_request_changes() ────────────────────────────────
-- Staff/admin only. submitted -> needs_changes.
create or replace function "public"."admin_request_changes"("target_project_id" uuid, "note" text default null)
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

  select status into current_status
  from public.projects
  where id = target_project_id
  for update;

  if current_status is null then
    raise exception 'project % not found', target_project_id;
  end if;

  if current_status <> 'submitted' then
    raise exception 'cannot request changes from status %', current_status;
  end if;

  update public.projects
  set status = 'needs_changes', updated_at = now()
  where id = target_project_id;

  select email into caller_email from public.profiles where id = auth.uid();

  insert into public.admin_actions (admin_id, admin_email, project_id, action, note)
  values (auth.uid(), caller_email, target_project_id, 'admin_request_changes', note);
end;
$$;

revoke all on function "public"."admin_request_changes"(uuid, text) from public;
grant execute on function "public"."admin_request_changes"(uuid, text) to "authenticated";

-- ── admin_send_proof() ──────────────────────────────────────
-- Staff/admin only. submitted -> proof_sent. Mints share_token if the
-- project doesn't already have one, in the same update as the status flip,
-- and returns it so the caller can build reviewUrl without a second round
-- trip. Client sequencing: call this RPC first, then call the
-- send-proof-ready edge function - the RPC is the only thing that can fail
-- on a real precondition, the email is a best-effort notification that can
-- be safely retried independently against the already-known token.
create or replace function "public"."admin_send_proof"("target_project_id" uuid)
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

  select status, share_token into current_status, existing_token
  from public.projects
  where id = target_project_id
  for update;

  if current_status is null then
    raise exception 'project % not found', target_project_id;
  end if;

  if current_status <> 'submitted' then
    raise exception 'cannot send proof from status %', current_status;
  end if;

  final_token := coalesce(existing_token, gen_random_uuid()::text);

  update public.projects
  set status = 'proof_sent', share_token = final_token, updated_at = now()
  where id = target_project_id;

  select email into caller_email from public.profiles where id = auth.uid();

  insert into public.admin_actions (admin_id, admin_email, project_id, action, note)
  values (auth.uid(), caller_email, target_project_id, 'admin_send_proof', null);

  return final_token;
end;
$$;

revoke all on function "public"."admin_send_proof"(uuid) from public;
grant execute on function "public"."admin_send_proof"(uuid) to "authenticated";

-- ── client_approve_proof() ──────────────────────────────────
-- Anonymous, share-token-gated (review.html, no Supabase Auth session).
-- proof_sent -> approved.
create or replace function "public"."client_approve_proof"("target_project_id" uuid)
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

  select status into current_status
  from public.projects
  where id = target_project_id
  for update;

  if current_status is null then
    raise exception 'project % not found', target_project_id;
  end if;

  if current_status <> 'proof_sent' then
    raise exception 'cannot approve proof from status %', current_status;
  end if;

  update public.projects
  set status = 'approved', updated_at = now()
  where id = target_project_id;

  insert into public.admin_actions (admin_id, admin_email, project_id, action, note)
  values (null, null, target_project_id, 'client_approve_proof', null);
end;
$$;

revoke all on function "public"."client_approve_proof"(uuid) from public;
grant execute on function "public"."client_approve_proof"(uuid) to "anon", "authenticated";

-- ── client_reject_proof() ───────────────────────────────────
-- Anonymous, share-token-gated. proof_sent -> needs_changes. Optional note,
-- stored in admin_actions.note with a null actor - the substantive
-- per-design feedback still lives in variation_feedback; this note is just
-- "what's wrong overall", surfaced in the same admin_actions timeline as
-- everything else.
create or replace function "public"."client_reject_proof"("target_project_id" uuid, "note" text default null)
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

  select status into current_status
  from public.projects
  where id = target_project_id
  for update;

  if current_status is null then
    raise exception 'project % not found', target_project_id;
  end if;

  if current_status <> 'proof_sent' then
    raise exception 'cannot reject proof from status %', current_status;
  end if;

  update public.projects
  set status = 'needs_changes', updated_at = now()
  where id = target_project_id;

  insert into public.admin_actions (admin_id, admin_email, project_id, action, note)
  values (null, null, target_project_id, 'client_reject_proof', note);
end;
$$;

revoke all on function "public"."client_reject_proof"(uuid, text) from public;
grant execute on function "public"."client_reject_proof"(uuid, text) to "anon", "authenticated";

-- ── admin_mark_sent_to_print() ──────────────────────────────
-- Staff/admin only, terminal transition. approved -> sent_to_print. Optional
-- storage_path folded into the logged note for a richer audit trail without
-- adding a new column.
create or replace function "public"."admin_mark_sent_to_print"(
  "target_project_id" uuid,
  "storage_path" text default null,
  "note" text default null
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
    raise exception 'only staff or admin can mark a project sent to print';
  end if;

  select status into current_status
  from public.projects
  where id = target_project_id
  for update;

  if current_status is null then
    raise exception 'project % not found', target_project_id;
  end if;

  if current_status <> 'approved' then
    raise exception 'cannot mark sent to print from status %', current_status;
  end if;

  update public.projects
  set status = 'sent_to_print', updated_at = now()
  where id = target_project_id;

  select email into caller_email from public.profiles where id = auth.uid();

  combined_note := note;
  if storage_path is not null then
    combined_note := case
      when combined_note is not null then combined_note || ' — print-sheets object: ' || storage_path
      else 'print-sheets object: ' || storage_path
    end;
  end if;

  insert into public.admin_actions (admin_id, admin_email, project_id, action, note)
  values (auth.uid(), caller_email, target_project_id, 'sent_to_print', combined_note);
end;
$$;

revoke all on function "public"."admin_mark_sent_to_print"(uuid, text, text) from public;
grant execute on function "public"."admin_mark_sent_to_print"(uuid, text, text) to "authenticated";

-- ── admin_actions: let owners read their own project's timeline ─────
-- Needed so the customer-facing status panel can show *why* they were
-- kicked back. Additive - RLS ORs multiple permissive policies together for
-- the same command, so the existing staff/admin-only select policy is left
-- as-is and this is a second, independent grant of the same access.
create policy "owners can read own project admin_actions" on "public"."admin_actions"
  for select to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- ── RLS: lock owner edits while a project isn't editable ────
-- Staff/admin edits are never gated by status (CLAUDE.md: "Decided - staff
-- editing a submitted/approved project does NOT auto-flip its status" -
-- consistent with staff also never being blocked from making that edit in
-- the first place). Only the owns_project()/created_by branch gets the
-- extra project_is_editable() condition; the is_staff_or_admin() OR-branch
-- is untouched on every policy below.

drop policy "projects update" on "public"."projects";
create policy "projects update" on "public"."projects"
  for update to "authenticated"
  using ((created_by = auth.uid() and public.project_is_editable(id)) or public.is_staff_or_admin())
  with check ((created_by = auth.uid() and public.project_is_editable(id)) or public.is_staff_or_admin());

drop policy "flag_config update" on "public"."flag_config";
create policy "flag_config update" on "public"."flag_config"
  for update to "authenticated"
  using ((public.owns_project(project_id) and public.project_is_editable(project_id)) or public.is_staff_or_admin())
  with check ((public.owns_project(project_id) and public.project_is_editable(project_id)) or public.is_staff_or_admin());

drop policy "hole_sign_config update" on "public"."hole_sign_config";
create policy "hole_sign_config update" on "public"."hole_sign_config"
  for update to "authenticated"
  using ((public.owns_project(project_id) and public.project_is_editable(project_id)) or public.is_staff_or_admin())
  with check ((public.owns_project(project_id) and public.project_is_editable(project_id)) or public.is_staff_or_admin());

-- project_logos has no update policy today (rows are create/delete only,
-- confirmed via grep - no client code ever updates a logo row) - lock
-- insert (new upload) and delete (remove) instead. The project_is_ownerless
-- branch (order.html's pre-account anon upload) is left untouched: an
-- ownerless project can never reach a submitted+ status in the first place,
-- since submit_project_for_review() requires owns_project() (false for an
-- anon caller, auth.uid() is null) or is_staff_or_admin().
drop policy "project_logos insert" on "public"."project_logos";
create policy "project_logos insert" on "public"."project_logos"
  for insert to "authenticated", "anon"
  with check (
    public.project_is_ownerless(project_id)
    or (public.owns_project(project_id) and public.project_is_editable(project_id))
    or public.is_staff_or_admin()
  );

drop policy "project_logos delete" on "public"."project_logos";
create policy "project_logos delete" on "public"."project_logos"
  for delete to "authenticated"
  using ((public.owns_project(project_id) and public.project_is_editable(project_id)) or public.is_staff_or_admin());

-- order_intakes intentionally NOT touched - no update policy exists for it
-- either, and no client code updates it after the initial insert, so
-- there's nothing to lock.
