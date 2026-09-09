-- Guard the abandoned-draft sweep against the new customer-facing submit flow.
--
-- abandoned_draft_candidates()/abandoned_draft_delete_candidates() (see
-- 20260812020000_abandoned_draft_sweep.sql) treat "no linked order_intakes
-- row" as the sole signal that a project is disposable - correct only while
-- order.html was the sole path to a real order, since it always wrote an
-- order_intakes row alongside the project. The new browse -> design -> submit
-- flow (project_status_workflow) never writes order_intakes, so without this
-- guard a submitted/proof_sent/approved project with no order_intakes row
-- would be indistinguishable from an abandoned draft and get swept after 60
-- days of inactivity - e.g. an approved project waiting on a slow print
-- vendor. status is now a meaningful, always-populated signal: only true
-- drafts (never submitted) should ever be sweep-eligible.

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
    and p.status = 'draft'
    and p.draft_warning_sent_at is null
    and p.updated_at < now() - (threshold_days || ' days')::interval
    and not exists (select 1 from public.order_intakes oi where oi.project_id = p.id);
$$;

create or replace function "public"."abandoned_draft_delete_candidates"("grace_days" integer)
returns table("id" uuid)
language sql
security definer
set search_path = public
as $$
  select p.id
  from public.projects p
  where p.status = 'draft'
    and p.draft_warning_sent_at is not null
    and p.draft_warning_sent_at < now() - (grace_days || ' days')::interval
    and p.updated_at <= p.draft_warning_sent_at
    and not exists (select 1 from public.order_intakes oi where oi.project_id = p.id);
$$;
