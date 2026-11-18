-- Pipedrive integration, step 3: outbound sync trigger.
--
-- Every status transition already logs a row to admin_actions (the six SECURITY DEFINER
-- RPCs in 20260913000000_per_design_status_workflow.sql), so one AFTER INSERT trigger
-- covers all of them with no client changes. It POSTs { action: 'move-deal', projectId,
-- productType } to the `pipedrive` edge function, which reads the design's *current*
-- status from the DB itself - so the trigger never carries (or trusts) a status, and a
-- spurious/duplicate admin_actions row just causes an idempotent re-sync.
--
-- Config lives in Vault, not hardcoded like 20261007010000_approval_deadline_reminders.sql
-- (which bakes in the production URL and would make a local trigger call prod):
--   service_role_key          already exists in prod (used by the reminders cron)
--   pipedrive_function_url    full URL of the function, e.g.
--                             https://<ref>.supabase.co/functions/v1/pipedrive
-- If either secret is missing the trigger does nothing, which doubles as the off switch:
-- delete `pipedrive_function_url` to pause all syncing.
--
-- Guarantees:
--   * Never blocks or fails the status RPC - any error is swallowed with a WARNING.
--   * pg_net is async and sends after COMMIT, so the edge function sees the new status.
--   * Projects with no linked deal for that product type make no HTTP call at all.
--   * client_set_qty doesn't change status, so it is skipped.
--
-- pg_net responses land in net._http_response (kept ~6h); retries and a staff-visible
-- failure indicator are step 5.

create or replace function public.sync_pipedrive_on_admin_action() returns trigger
  language plpgsql
  security definer
  set search_path = public, vault, net
  as $$
declare
  v_url text;
  v_key text;
  v_linked boolean;
begin
  if new.project_id is null
     or new.product_type not in ('flags', 'hole-signs')
     or new.action = 'client_set_qty' then
    return new;
  end if;

  begin
    select case new.product_type
             when 'flags' then pipedrive_flags_deal_id is not null
             else pipedrive_hs_deal_id is not null
           end
      into v_linked
      from public.projects where id = new.project_id;
    if not coalesce(v_linked, false) then
      return new;
    end if;

    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'pipedrive_function_url';
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
    if v_url is null or v_key is null then
      return new;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object(
        'action', 'move-deal',
        'projectId', new.project_id,
        'productType', new.product_type
      )
    );
  exception when others then
    raise warning 'pipedrive sync trigger failed for project % (%): %', new.project_id, new.action, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.sync_pipedrive_on_admin_action() from public, anon, authenticated;

drop trigger if exists sync_pipedrive_on_admin_action on public.admin_actions;
create trigger sync_pipedrive_on_admin_action
  after insert on public.admin_actions
  for each row execute function public.sync_pipedrive_on_admin_action();
