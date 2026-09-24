-- admin_mark_design_sent_to_print() was a one-way terminal transition
-- (approved -> sent_to_print only) - but designs sometimes need a tweak
-- after they've already gone to print (a client-requested change caught
-- late, a vendor-flagged issue, etc.), and staff need to resend the
-- corrected files. Widen the same RPC's own precondition to also accept
-- 'sent_to_print' as a source status, same pattern as
-- 20260912000000_admin_send_proof_from_needs_changes.sql widening
-- admin_send_proof to allow a resend-while-pending. No other behavior
-- changes - it still sets status = 'sent_to_print' (a no-op status-wise on
-- a resend) and logs a fresh admin_actions row each time, so repeated
-- prints stay in the audit trail.
create or replace function public.admin_mark_design_sent_to_print(
  target_project_id uuid,
  target_product_type text,
  storage_path text default null,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  caller_email text;
  combined_note text;
begin
  if not public.is_staff_or_admin() then
    raise exception 'only staff or admin can mark a design sent to print';
  end if;

  if target_product_type = 'flags' then
    select status into current_status from public.flag_config where project_id = target_project_id for update;
  elsif target_product_type = 'hole-signs' then
    select status into current_status from public.hole_sign_config where project_id = target_project_id for update;
  else
    raise exception 'invalid product_type %', target_product_type;
  end if;

  if current_status is null then
    raise exception 'no % design found for project %', target_product_type, target_project_id;
  end if;

  if current_status not in ('approved', 'sent_to_print') then
    raise exception 'cannot mark % design sent to print from status %', target_product_type, current_status;
  end if;

  if target_product_type = 'flags' then
    update public.flag_config set status = 'sent_to_print', updated_at = now() where project_id = target_project_id;
  else
    update public.hole_sign_config set status = 'sent_to_print', updated_at = now() where project_id = target_project_id;
  end if;

  select email into caller_email from public.profiles where id = auth.uid();

  combined_note := note;
  if storage_path is not null then
    combined_note := case
      when combined_note is not null then combined_note || ' — print-sheets object: ' || storage_path
      else 'print-sheets object: ' || storage_path
    end;
  end if;

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (auth.uid(), caller_email, target_project_id, target_product_type, 'sent_to_print', combined_note);
end;
$$;

revoke all on function public.admin_mark_design_sent_to_print(uuid, text, text, text) from public;
grant execute on function public.admin_mark_design_sent_to_print(uuid, text, text, text) to authenticated;
