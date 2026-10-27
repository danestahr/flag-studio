-- Approval deadline now counts from the event's "working" Friday: an event on
-- Sat/Sun/Mon is first moved back to the preceding Friday (-1/-2/-3), then the
-- 17-day window is applied to that date. (Previously: event - 17, then nudged
-- back to Friday.) event_date itself is unchanged. Mirrors calcApprovalDeadline()
-- in src/order.js, src/intake-shared.js and send-order-confirmation.
create or replace function "public"."compute_approval_deadline"("p_event_date" date)
returns date
language sql
immutable
as $$
  select case when p_event_date is null then null else
    (p_event_date - case extract(dow from p_event_date)::int
      when 6 then 1
      when 0 then 2
      when 1 then 3
      else 0
    end) - 17
  end;
$$;

update "public"."order_intakes"
  set approval_deadline = public.compute_approval_deadline(event_date)
  where approval_deadline is distinct from public.compute_approval_deadline(event_date);
