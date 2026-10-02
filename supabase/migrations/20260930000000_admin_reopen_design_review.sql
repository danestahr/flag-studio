-- Staff/admin only. approved -> proof_sent.
--
-- Escape hatch for a client approving the wrong proof: staff pulls the design
-- back out of approved, edits it, and refreshes/resends the proof. It lands
-- in proof_sent (not submitted) because that's the only state where the
-- review link is live and client_approve_design_proof will accept a new
-- approval. Approver identity and all variation_feedback for the design are
-- cleared so every variation must be re-approved; the original approval
-- stays in admin_actions for audit.
create or replace function public.admin_reopen_design_review(target_project_id uuid, target_product_type text, note text default null)
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
    raise exception 'only staff or admin can reopen a design for review';
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

  if current_status <> 'approved' then
    raise exception 'cannot reopen % design from status %', target_product_type, current_status;
  end if;

  perform set_config('app.allow_design_status_change', 'true', true);

  if target_product_type = 'flags' then
    update public.flag_config
      set status = 'proof_sent', approved_by_name = null, approved_by_email = null, approved_at = null, updated_at = now()
      where project_id = target_project_id;
  else
    update public.hole_sign_config
      set status = 'proof_sent', approved_by_name = null, approved_by_email = null, approved_at = null, updated_at = now()
      where project_id = target_project_id;
  end if;

  delete from public.variation_feedback
    where project_id = target_project_id and product_type = target_product_type;

  select email into caller_email from public.profiles where id = auth.uid();

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (auth.uid(), caller_email, target_project_id, target_product_type, 'admin_reopen_review', note);
end;
$$;

revoke all on function public.admin_reopen_design_review(uuid, text, text) from public;
grant execute on function public.admin_reopen_design_review(uuid, text, text) to authenticated;
