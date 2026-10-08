-- Approval reminders only go out when the customer has something they can act
-- on from a link they can open (customers don't have project.html access):
--   * the order form isn't finished          -> /order?resume=
--   * a proof is waiting (share token exists) -> /review?token=
--   * order placed, no logos yet, and logo upload is still open (every
--     existing design is draft/needs_changes) -> /upload-logos
-- Previously ANY design in draft/needs_changes/proof_sent qualified, so an
-- order with a design under staff review (or a stray empty draft design) got a
-- reminder with nothing to do. Same signature/return type as before.
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
  )
  select d.project_id, d.event_name, d.contact_name, d.contact_email,
         d.approval_deadline, d.days_left::int, d.days_left::int, d.share_token,
         d.order_complete, d.has_logos, d.proof_sent
  from due d
  where (
      not d.order_complete
      or (d.proof_sent and d.share_token is not null)
      or (not d.has_logos and public.project_has_unlocked_design(d.project_id))
    )
    and not exists (select 1 from public.approval_reminders_sent s
                    where s.project_id = d.project_id and s.days_before = d.days_left);
$$;
