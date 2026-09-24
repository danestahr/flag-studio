-- admin_send_proof() previously only accepted 'submitted' as its source
-- status, so once a client rejected a proof (proof_sent -> needs_changes
-- via client_reject_proof), staff had no RPC to send a revised proof back
-- out - project.html's admin panel could only show "waiting on the client
-- to resubmit" with no action. This widens the same RPC's own precondition
-- to also accept 'needs_changes', since sending "whatever's currently
-- designed" as a proof is the same staff action regardless of why the
-- project landed in needs_changes. No other behavior changes - it still
-- mints/reuses share_token, flips to proof_sent, and logs admin_actions
-- exactly as before.

create or replace function "public"."admin_send_proof"("target_project_id" uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  existing_token text;
  caller_email text;
  final_token text;
begin
  if not public.is_staff_or_admin() then
    raise exception 'only staff or admin can send a proof';
  end if;

  select status, share_token into current_status, existing_token
  from public.projects
  where id = target_project_id
  for update;

  if current_status is null then
    raise exception 'project % not found', target_project_id;
  end if;

  if current_status not in ('submitted', 'needs_changes') then
    raise exception 'cannot send proof from status %', current_status;
  end if;

  final_token := coalesce(existing_token, gen_random_uuid()::text);

  update public.projects
  set status = 'proof_sent', share_token = final_token, updated_at = now()
  where id = target_project_id;

  select email into caller_email from public.profiles where id = auth.uid();

  insert into public.admin_actions (admin_id, admin_email, project_id, action, note)
  values (auth.uid(), caller_email, target_project_id, 'admin_send_proof', null);

  return final_token;
end;
$$;

revoke all on function "public"."admin_send_proof"(uuid) from public;
grant execute on function "public"."admin_send_proof"(uuid) to "authenticated";
