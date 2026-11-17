-- Canadian orders need an extra week for customs, so the approval deadline moves
-- 7 days earlier when order_intakes.country = 'CA' (24 days before the delivery
-- date instead of 17). event_date is the customer's delivery date. Mirrors
-- leadExtraFor() / calcApprovalDeadline() in src/intake-shared.js and the copies in
-- send-order-confirmation and send-prestige-order.
-- Existing Canadian orders are recomputed too, so what the reminder emails count
-- against matches what the order form, project pages and emails show.

create or replace function "public"."compute_approval_deadline"("p_event_date" date, "p_country" text)
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
    end) - 17 - case when p_country = 'CA' then 7 else 0 end
  end;
$$;

-- The existing one-argument form keeps meaning "US".
create or replace function "public"."compute_approval_deadline"("p_event_date" date)
returns date
language sql
immutable
as $$ select public.compute_approval_deadline(p_event_date, null::text); $$;

create or replace function "public"."order_intakes_set_approval_deadline"()
returns trigger
language plpgsql
as $$
begin
  new.approval_deadline := public.compute_approval_deadline(new.event_date, new.country);
  return new;
end;
$$;

drop trigger if exists "order_intakes_approval_deadline" on "public"."order_intakes";
create trigger "order_intakes_approval_deadline"
  before insert or update of event_date, country on "public"."order_intakes"
  for each row execute function "public"."order_intakes_set_approval_deadline"();

update "public"."order_intakes"
  set approval_deadline = public.compute_approval_deadline(event_date, country)
  where approval_deadline is distinct from public.compute_approval_deadline(event_date, country);
