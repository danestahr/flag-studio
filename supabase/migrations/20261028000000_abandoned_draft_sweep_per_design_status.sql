-- Point the abandoned-draft sweep at the per-design status columns.
--
-- 20260821000000_abandoned_draft_sweep_status_guard.sql guarded the sweep with
-- `projects.status = 'draft'` so submitted/proof_sent/approved projects with no
-- order_intakes row weren't mistaken for abandoned drafts. As of
-- 20260913000000_per_design_status_workflow.sql nothing writes
-- `projects.status` any more - the real state lives on flag_config.status and
-- hole_sign_config.status - so every project created through the browse ->
-- design -> submit flow still reads 'draft' there and would be swept after the
-- inactivity window even if its design is under review, approved, or sent to
-- print.
--
-- A project is now sweep-eligible only if no existing flag_config or
-- hole_sign_config row has left 'draft' (a missing row counts as draft).

create or replace function "public"."abandoned_draft_candidates"("threshold_days" integer)
returns table("id" uuid, "name" text, "owner_email" text, "owner_name" text)
language sql
security definer
set search_path = public
as $$
  select p.id, p.name, pr.email,
    coalesce(nullif(trim(both ' ' from concat(pr.first_name, ' ', pr.last_name)), ''), pr.email)
  from public.projects p
  join public.profiles pr on pr.id = p.created_by
  where p.created_by is not null
    and p.draft_warning_sent_at is null
    and p.updated_at < now() - (threshold_days || ' days')::interval
    and not exists (select 1 from public.order_intakes oi where oi.project_id = p.id)
    and not exists (select 1 from public.flag_config fc where fc.project_id = p.id and fc.status <> 'draft')
    and not exists (select 1 from public.hole_sign_config hc where hc.project_id = p.id and hc.status <> 'draft');
$$;

create or replace function "public"."abandoned_draft_delete_candidates"("grace_days" integer)
returns table("id" uuid)
language sql
security definer
set search_path = public
as $$
  select p.id
  from public.projects p
  where p.draft_warning_sent_at is not null
    and p.draft_warning_sent_at < now() - (grace_days || ' days')::interval
    and p.updated_at <= p.draft_warning_sent_at
    and not exists (select 1 from public.order_intakes oi where oi.project_id = p.id)
    and not exists (select 1 from public.flag_config fc where fc.project_id = p.id and fc.status <> 'draft')
    and not exists (select 1 from public.hole_sign_config hc where hc.project_id = p.id and hc.status <> 'draft');
$$;
