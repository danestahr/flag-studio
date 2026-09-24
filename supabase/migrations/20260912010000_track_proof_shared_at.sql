-- Lets staff see when a design has changed since the proof was last shared,
-- so project.html can offer a "reshare updated design" action instead of
-- staff having to guess whether the client is looking at a stale link.
--
-- projects.proof_shared_at is set every time admin_send_proof() succeeds
-- (first send or a later resend) and compared client-side against
-- flag_config.updated_at / hole_sign_config.updated_at, both of which are
-- already bumped on every design save (saveFlagConfig/saveHoleSignConfig in
-- src/supabase.js) - no new tracking needed on that side.
--
-- Scope is deliberately narrow: admin_send_proof now also accepts
-- 'proof_sent' as a source status (resend-while-still-pending), but NOT
-- 'approved' - once a client approves, reopening that decision is out of
-- scope for this action and stays a manual/offline conversation.

alter table "public"."projects"
  add column if not exists "proof_shared_at" timestamp with time zone;

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

  if current_status not in ('submitted', 'needs_changes', 'proof_sent') then
    raise exception 'cannot send proof from status %', current_status;
  end if;

  final_token := coalesce(existing_token, gen_random_uuid()::text);

  update public.projects
  set status = 'proof_sent', share_token = final_token, proof_shared_at = now(), updated_at = now()
  where id = target_project_id;

  select email into caller_email from public.profiles where id = auth.uid();

  insert into public.admin_actions (admin_id, admin_email, project_id, action, note)
  values (auth.uid(), caller_email, target_project_id, 'admin_send_proof', null);

  return final_token;
end;
$$;

revoke all on function "public"."admin_send_proof"(uuid) from public;
grant execute on function "public"."admin_send_proof"(uuid) to "authenticated";
