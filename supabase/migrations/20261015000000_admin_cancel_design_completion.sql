-- Staff/admin only. sent_to_print -> approved.
--
-- Undo for "Mark as complete" / a send to print: the design goes back to
-- approved so it can be edited and resent. Approver identity and
-- variation_feedback are left untouched (the client's approval still stands);
-- use admin_reopen_design_review afterwards if the approval itself needs to
-- be cancelled too. Logged to admin_actions so the original sent_to_print row
-- and this reversal both stay in the audit trail.
create or replace function public.admin_cancel_design_completion(target_project_id uuid, target_product_type text, note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  caller_email text;
begin
  if not public.is_staff_or_admin() then
    raise exception 'only staff or admin can cancel a design completion';
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

  if current_status <> 'sent_to_print' then
    raise exception 'cannot cancel completion of % design from status %', target_product_type, current_status;
  end if;

  perform set_config('app.allow_design_status_change', 'true', true);

  if target_product_type = 'flags' then
    update public.flag_config set status = 'approved', updated_at = now() where project_id = target_project_id;
  else
    update public.hole_sign_config set status = 'approved', updated_at = now() where project_id = target_project_id;
  end if;

  select email into caller_email from public.profiles where id = auth.uid();

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (auth.uid(), caller_email, target_project_id, target_product_type, 'cancel_completion', note);
end;
$$;

revoke all on function public.admin_cancel_design_completion(uuid, text, text) from public;
grant execute on function public.admin_cancel_design_completion(uuid, text, text) to authenticated;
