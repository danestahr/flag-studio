-- Workstream B: abandoned-draft cleanup.
--
-- A project only ever enters this sweep if it has no linked order_intakes
-- row - a real transaction (submitted via order.html, or later placed from a
-- customer's own dashboard) is never at risk regardless of age or claim
-- status, since order.html always creates the intake row alongside the
-- project. Only pure design exploration that never became an order is in
-- scope. No role exception: a staff/admin account's own untouched drafts age
-- out exactly like a customer's would.
--
-- Two-phase, both driven by the sweep-abandoned-drafts edge function on a
-- pg_cron schedule (see the cron.schedule() calls at the bottom of this
-- file): warn at 53 days of inactivity, delete at 60 (7 days after the
-- warning) if still untouched. Editing the project after a warning clears it
-- automatically - clear_stale_draft_warnings() below implements that.

alter table "public"."projects"
  add column if not exists "draft_warning_sent_at" timestamptz;

-- ── Eligibility + state-transition helpers ─────────────────────────────
-- security definer + restricted to service_role: these run unscoped across
-- every user's projects, which is only ever appropriate for the cron-
-- triggered sweep function (authenticated with the service role key), never
-- for a customer or staff session.

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
  where p.draft_warning_sent_at is not null
    and p.draft_warning_sent_at < now() - (grace_days || ' days')::interval
    and p.updated_at <= p.draft_warning_sent_at
    and not exists (select 1 from public.order_intakes oi where oi.project_id = p.id);
$$;

-- Opening/editing a warned draft naturally cancels the pending removal - no
-- explicit "keep it" action required from the customer.
create or replace function "public"."clear_stale_draft_warnings"()
returns void
language sql
security definer
set search_path = public
as $$
  update public.projects
  set draft_warning_sent_at = null
  where draft_warning_sent_at is not null
    and updated_at > draft_warning_sent_at;
$$;

create or replace function "public"."mark_draft_warned"("target_project_id" uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.projects set draft_warning_sent_at = now() where id = target_project_id;
$$;

revoke all on function "public"."abandoned_draft_candidates"(integer) from public;
revoke all on function "public"."abandoned_draft_delete_candidates"(integer) from public;
revoke all on function "public"."clear_stale_draft_warnings"() from public;
revoke all on function "public"."mark_draft_warned"(uuid) from public;
grant execute on function "public"."abandoned_draft_candidates"(integer) to "service_role";
grant execute on function "public"."abandoned_draft_delete_candidates"(integer) to "service_role";
grant execute on function "public"."clear_stale_draft_warnings"() to "service_role";
grant execute on function "public"."mark_draft_warned"(uuid) to "service_role";

-- ── Daily schedule ──────────────────────────────────────────────────────
-- Requires a Vault secret named 'service_role_key' holding the project's
-- actual service role key - that's a one-time manual step (see the repo's
-- session notes / PR description), not part of this migration, since the
-- key itself must never be pasted into a committed file. Until that secret
-- exists, these jobs run daily but fail closed (401 from the edge function,
-- logged, no data touched) rather than doing anything destructive.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'sweep-abandoned-drafts-warn',
  '0 10 * * *',
  $$
  select net.http_post(
    url := 'https://snyxsulasabbpkmzcqvx.supabase.co/functions/v1/sweep-abandoned-drafts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('phase', 'warn')
  ) as request_id;
  $$
);

select cron.schedule(
  'sweep-abandoned-drafts-delete',
  '30 10 * * *',
  $$
  select net.http_post(
    url := 'https://snyxsulasabbpkmzcqvx.supabase.co/functions/v1/sweep-abandoned-drafts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('phase', 'delete')
  ) as request_id;
  $$
);
