-- 20260915000000_allow_resend_to_print.sql re-created admin_mark_design_sent_to_print()
-- without the set_config('app.allow_design_status_change', 'true', true) call the
-- original (20260913000000) had, so prevent_design_status_self_update() rejects
-- the approved -> sent_to_print transition ("status cannot be changed directly").
-- Resends (sent_to_print -> sent_to_print) don't change status, which is why
-- only the first send broke. Same function, flag restored; nothing else changes.
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

  perform set_config('app.allow_design_status_change', 'true', true);

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
