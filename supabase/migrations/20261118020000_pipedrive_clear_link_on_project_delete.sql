-- When a project is deleted, clear the "Design Studio Project Link" field on its linked
-- Pipedrive deal(s) so they don't point at a dead page. BEFORE DELETE so the deal ids are
-- still readable; the ids ride in the payload because the row is gone by the time the
-- (async, post-COMMIT) request runs. Same Vault config + off-switch as
-- 20261117010000_pipedrive_status_sync_trigger.sql, and never blocks the delete.

create or replace function public.clear_pipedrive_link_on_project_delete() returns trigger
  language plpgsql
  security definer
  set search_path = public, vault, net
  as $$
declare
  v_url text;
  v_key text;
begin
  if old.pipedrive_flags_deal_id is null and old.pipedrive_hs_deal_id is null then
    return old;
  end if;

  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'pipedrive_function_url';
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
    if v_url is null or v_key is null then
      return old;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object(
        'action', 'clear-link-field',
        'dealIds', to_jsonb(array_remove(array[old.pipedrive_flags_deal_id, old.pipedrive_hs_deal_id], null))
      )
    );
  exception when others then
    raise warning 'pipedrive link-clear trigger failed for project %: %', old.id, sqlerrm;
  end;

  return old;
end;
$$;

revoke all on function public.clear_pipedrive_link_on_project_delete() from public, anon, authenticated;

drop trigger if exists clear_pipedrive_link_on_project_delete on public.projects;
create trigger clear_pipedrive_link_on_project_delete
  before delete on public.projects
  for each row execute function public.clear_pipedrive_link_on_project_delete();
