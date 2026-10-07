-- Store the artwork approval deadline on the order, and send automated
-- reminder emails as it approaches (45/30/14/7/3 days out).
--
-- The deadline rule mirrors calcApprovalDeadline() in src/order.js: event date
-- minus 17 days, then pulled back to the preceding Friday if that lands on a
-- Sat (-1), Sun (-2) or Mon (-3). It's computed by a trigger so it stays
-- correct no matter who writes event_date (customer RPC, staff edit, backfill).
-- Keep the two implementations in sync.

alter table "public"."order_intakes"
  add column if not exists "approval_deadline" date;

create or replace function "public"."compute_approval_deadline"("p_event_date" date)
returns date
language sql
immutable
as $$
  select case when p_event_date is null then null else
    (p_event_date - 17) - case extract(dow from (p_event_date - 17))::int
      when 6 then 1
      when 0 then 2
      when 1 then 3
      else 0
    end
  end;
$$;

create or replace function "public"."order_intakes_set_approval_deadline"()
returns trigger
language plpgsql
as $$
begin
  new.approval_deadline := public.compute_approval_deadline(new.event_date);
  return new;
end;
$$;

drop trigger if exists "order_intakes_approval_deadline" on "public"."order_intakes";
create trigger "order_intakes_approval_deadline"
  before insert or update of event_date on "public"."order_intakes"
  for each row execute function "public"."order_intakes_set_approval_deadline"();

update "public"."order_intakes"
  set approval_deadline = public.compute_approval_deadline(event_date)
  where approval_deadline is distinct from public.compute_approval_deadline(event_date);

-- ── Reminder tracking ───────────────────────────────────────
-- One row per (project, threshold) so a reminder is never sent twice, even if
-- the cron runs more than once a day or the deadline later moves.
create table if not exists "public"."approval_reminders_sent" (
  "project_id" uuid not null references public.projects(id) on delete cascade,
  "days_before" integer not null,
  "sent_at" timestamptz not null default now(),
  primary key ("project_id", "days_before")
);
alter table "public"."approval_reminders_sent" enable row level security;
create policy "staff and admin can read approval_reminders_sent"
  on "public"."approval_reminders_sent" for select
  using (public.is_staff_or_admin());

-- Orders due a reminder today. Eligible when the deadline hasn't passed and
-- the customer still has something to do: the order form isn't finished
-- (submitted_at is null), or a design is in draft / needs_changes (submit it)
-- or proof_sent (approve it). 'submitted' (waiting on staff), 'approved' and
-- 'sent_to_print' don't count.
-- The threshold is the smallest of 45/30/14/7/3 that is >= days left, so an
-- order placed 10 days out gets the 14-day reminder once, not a burst of all
-- the larger ones; thresholds already sent are skipped.
-- order_complete / has_logos / proof_sent let the edge function choose the
-- email's call to action (order form > logo upload > proof review).
drop function if exists "public"."approval_reminder_candidates"();
create function "public"."approval_reminder_candidates"()
returns table(
  "project_id" uuid, "event_name" text, "contact_name" text, "contact_email" text,
  "approval_deadline" date, "days_left" integer, "threshold" integer, "share_token" text,
  "order_complete" boolean, "has_logos" boolean, "proof_sent" boolean
)
language sql
security definer
set search_path = public
as $$
  with due as (
    select oi.project_id, oi.event_name, oi.contact_name, oi.contact_email,
           oi.approval_deadline, p.share_token,
           (oi.submitted_at is not null) as order_complete,
           exists (select 1 from public.project_logos pl where pl.project_id = oi.project_id) as has_logos,
           (exists (select 1 from public.flag_config fc where fc.project_id = oi.project_id and fc.status = 'proof_sent')
            or exists (select 1 from public.hole_sign_config hc where hc.project_id = oi.project_id and hc.status = 'proof_sent')) as proof_sent,
           (oi.approval_deadline - current_date) as days_left,
           (select min(t) from unnest(array[3,7,14,30,45]) t
             where t >= (oi.approval_deadline - current_date)) as threshold
    from public.order_intakes oi
    join public.projects p on p.id = oi.project_id
    where oi.approval_deadline is not null
      and oi.approval_deadline >= current_date
      and nullif(oi.contact_email, '') is not null
      and (
        oi.submitted_at is null
        or exists (select 1 from public.flag_config fc
                   where fc.project_id = oi.project_id and fc.status in ('draft','needs_changes','proof_sent'))
        or exists (select 1 from public.hole_sign_config hc
                   where hc.project_id = oi.project_id and hc.status in ('draft','needs_changes','proof_sent'))
      )
  )
  select d.project_id, d.event_name, d.contact_name, d.contact_email,
         d.approval_deadline, d.days_left::int, d.threshold, d.share_token,
         d.order_complete, d.has_logos, d.proof_sent
  from due d
  where d.threshold is not null
    and not exists (select 1 from public.approval_reminders_sent s
                    where s.project_id = d.project_id and s.days_before = d.threshold);
$$;

create or replace function "public"."mark_approval_reminder_sent"("p_project_id" uuid, "p_threshold" integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.approval_reminders_sent (project_id, days_before)
  values (p_project_id, p_threshold)
  on conflict do nothing;
$$;

revoke all on function "public"."approval_reminder_candidates"() from public;
revoke all on function "public"."mark_approval_reminder_sent"(uuid, integer) from public;
grant execute on function "public"."approval_reminder_candidates"() to "service_role";
grant execute on function "public"."mark_approval_reminder_sent"(uuid, integer) to "service_role";

-- ── Daily schedule (same Vault-secret setup as sweep-abandoned-drafts) ──
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('send-approval-reminders') where exists (select 1 from cron.job where jobname = 'send-approval-reminders');
select cron.schedule(
  'send-approval-reminders',
  '0 14 * * *',
  $$
  select net.http_post(
    url := 'https://snyxsulasabbpkmzcqvx.supabase.co/functions/v1/send-approval-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
