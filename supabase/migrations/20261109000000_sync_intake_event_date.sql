-- Staff corrections to the event date are saved to projects.customer_info, but
-- reminders read order_intakes.approval_deadline, which a trigger derives from
-- order_intakes.event_date. order_intakes has no UPDATE policy, so this
-- SECURITY DEFINER RPC is how customer_info edits propagate to the intake row
-- (and, via the existing trigger, to approval_deadline).
create or replace function "public"."sync_intake_event_date"(
  "p_project_id" uuid,
  "p_event_date" date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.owns_project(p_project_id) or public.is_staff_or_admin()) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_event_date is null then return; end if;  -- event_date is NOT NULL

  update public.order_intakes
     set event_date = p_event_date
   where project_id = p_project_id
     and event_date is distinct from p_event_date;
end;
$$;

revoke all on function "public"."sync_intake_event_date"(uuid, date) from public;
grant execute on function "public"."sync_intake_event_date"(uuid, date) to "authenticated";

-- One-time backfill for corrections already made in customer_info.
update public.order_intakes oi
   set event_date = (p.customer_info->>'event_date')::date
  from public.projects p
 where p.id = oi.project_id
   and p.customer_info->>'event_date' ~ '^\d{4}-\d{2}-\d{2}$'
   and oi.event_date is distinct from (p.customer_info->>'event_date')::date;
