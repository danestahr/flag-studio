-- Shipping "Full Name" (who the package is addressed to) captured on order.html
-- Step 2, separate from the contact (approver) name and the optional ATTN line.
-- save_order_intake is redefined unchanged apart from persisting ship_to.

alter table "public"."order_intakes"
  add column if not exists "ship_to" text;

create or replace function "public"."save_order_intake"(
  "p_project_id" uuid,
  "p_data" jsonb,
  "p_finalize" boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.order_intakes;
  v_privileged boolean;
  v_submitted timestamptz;
begin
  if not exists (select 1 from public.projects where id = p_project_id) then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;

  v_privileged := public.owns_project(p_project_id) or public.is_staff_or_admin();
  if not (public.project_is_ownerless(p_project_id) or v_privileged) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  select submitted_at into v_submitted from public.order_intakes where project_id = p_project_id;
  if v_submitted is not null and not v_privileged then
    raise exception 'order_already_submitted' using errcode = '42501';
  end if;

  r := jsonb_populate_record(null::public.order_intakes, p_data);

  insert into public.order_intakes (
    project_id, course_name, event_source_url, event_name, event_date,
    contact_name, contact_email, ship_to, attn, address_line1, address_line2, city,
    state_province, postal_code, country, flag_style, flag_colors, flag_setup,
    flag_qty, design_notes, front_design_notes, back_design_notes,
    ack_deadline, submitted_at
  ) values (
    p_project_id, r.course_name, r.event_source_url, r.event_name, r.event_date,
    r.contact_name, r.contact_email, r.ship_to, r.attn, r.address_line1, r.address_line2, r.city,
    r.state_province, r.postal_code, coalesce(r.country, 'US'), r.flag_style, r.flag_colors,
    coalesce(r.flag_setup, 'same'), r.flag_qty, r.design_notes, r.front_design_notes,
    r.back_design_notes, coalesce(r.ack_deadline, false),
    case when p_finalize then now() end
  )
  on conflict (project_id) do update set
    course_name = excluded.course_name,
    event_source_url = excluded.event_source_url,
    event_name = excluded.event_name,
    event_date = excluded.event_date,
    contact_name = excluded.contact_name,
    contact_email = excluded.contact_email,
    ship_to = excluded.ship_to,
    attn = excluded.attn,
    address_line1 = excluded.address_line1,
    address_line2 = excluded.address_line2,
    city = excluded.city,
    state_province = excluded.state_province,
    postal_code = excluded.postal_code,
    country = excluded.country,
    flag_style = excluded.flag_style,
    flag_colors = excluded.flag_colors,
    flag_setup = excluded.flag_setup,
    flag_qty = excluded.flag_qty,
    design_notes = excluded.design_notes,
    front_design_notes = excluded.front_design_notes,
    back_design_notes = excluded.back_design_notes,
    ack_deadline = excluded.ack_deadline,
    submitted_at = coalesce(public.order_intakes.submitted_at, excluded.submitted_at);

  -- Keep the project name in step with the event name for customer-made
  -- (ownerless) projects only - never rename an owned/staff project.
  update public.projects
    set name = r.event_name, updated_at = now()
    where id = p_project_id and created_by is null;
end;
$$;

revoke all on function "public"."save_order_intake"(uuid, jsonb, boolean) from public;
grant execute on function "public"."save_order_intake"(uuid, jsonb, boolean) to "authenticated", "anon";
