-- Approval reminders fire only on the exact day: an order is due when
-- (approval_deadline - today) is exactly 45, 30, 14, 7 or 3. No catch-up: an
-- order created inside a window (e.g. 36 days out) skips the thresholds it
-- already passed and waits for the next one. approval_reminders_sent still
-- guards against a double send if the job runs twice in one day.
-- Replaces the "smallest threshold >= days left" rule from
-- 20261007010000_approval_deadline_reminders.sql; same signature/return type.
create or replace function "public"."approval_reminder_candidates"()
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
           (oi.approval_deadline - current_date) as days_left
    from public.order_intakes oi
    join public.projects p on p.id = oi.project_id
    where oi.approval_deadline is not null
      and (oi.approval_deadline - current_date) in (3, 7, 14, 30, 45)
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
         d.approval_deadline, d.days_left::int, d.days_left::int, d.share_token,
         d.order_complete, d.has_logos, d.proof_sent
  from due d
  where not exists (select 1 from public.approval_reminders_sent s
                    where s.project_id = d.project_id and s.days_before = d.days_left);
$$;
