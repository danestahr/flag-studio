-- Pipedrive integration, step 5: sync log, retries, failure visibility.
--
-- Outbox pattern. The admin_actions trigger (20261117010000) used to fire-and-forget through
-- pg_net, so a failed sync left no trace beyond net._http_response (~6h retention). Now:
--
--   1. The trigger inserts a `pending` row here (attempts = 1) BEFORE calling the function,
--      and passes its id along.
--   2. The `pipedrive` edge function records the outcome on that row: ok / skipped / failed
--      (+ error text, + retryable=false for failures retrying can't fix, e.g. a deleted deal).
--   3. A pg_cron job (every minute) re-dispatches the latest unfinished row per
--      (project, product) with exponential backoff. That also covers the case where the
--      function was never reached at all (row stays `pending`).
--
-- move-deal always reads the design's CURRENT status, so retrying is idempotent and an older
-- unfinished row is moot once a newer one exists - only the latest row per key is ever retried.
--
-- Backoff before attempt n+1 is 3^(n-1) minutes after attempt n's last update: 1, 3, 9, 27.
-- After 5 attempts the row is left `failed` (staff see it on the tool card and can "Retry now",
-- which starts a fresh row).

create table if not exists public.pipedrive_sync_log (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  product_type  text not null check (product_type in ('flags', 'hole-signs')),
  studio_status text,
  state         text not null default 'pending' check (state in ('pending', 'ok', 'skipped', 'failed')),
  attempts      int  not null default 1,
  retryable     boolean not null default true,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists pipedrive_sync_log_key_idx
  on public.pipedrive_sync_log (project_id, product_type, created_at desc);

-- Staff/admin read only. No insert/update/delete policy for any client role: rows are written
-- by the SECURITY DEFINER trigger/retry function and by the edge function (service role).
alter table public.pipedrive_sync_log enable row level security;

create policy "pipedrive_sync_log select" on public.pipedrive_sync_log
  for select to authenticated
  using (public.is_staff_or_admin());

-- ── Trigger: log first, then dispatch ───────────────────────
create or replace function public.sync_pipedrive_on_admin_action() returns trigger
  language plpgsql
  security definer
  set search_path = public, vault, net
  as $$
declare
  v_url text;
  v_key text;
  v_linked boolean;
  v_status text;
  v_log uuid;
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

    -- The RPCs update the design's status before logging to admin_actions, so this is the new one.
    if new.product_type = 'flags' then
      select status into v_status from public.flag_config where project_id = new.project_id;
    else
      select status into v_status from public.hole_sign_config where project_id = new.project_id;
    end if;

    insert into public.pipedrive_sync_log (project_id, product_type, studio_status)
    values (new.project_id, new.product_type, v_status)
    returning id into v_log;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object(
        'action', 'move-deal',
        'projectId', new.project_id,
        'productType', new.product_type,
        'logId', v_log
      ),
      timeout_milliseconds := 15000
    );
  exception when others then
    raise warning 'pipedrive sync trigger failed for project % (%): %', new.project_id, new.action, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.sync_pipedrive_on_admin_action() from public, anon, authenticated;

-- ── Retry sweep ─────────────────────────────────────────────
create or replace function public.pipedrive_retry_due() returns void
  language plpgsql
  security definer
  set search_path = public, vault, net
  as $$
declare
  c_max_attempts constant int := 5;
  v_url text;
  v_key text;
  r record;
begin
  -- Housekeeping: this is a diagnostic log, not an audit trail (admin_actions is).
  delete from public.pipedrive_sync_log where created_at < now() - interval '30 days';

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'pipedrive_function_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';

  -- Latest row per (project, product) only; an older unfinished row is superseded.
  for r in
    select * from (
      select distinct on (project_id, product_type) *
        from public.pipedrive_sync_log
       order by project_id, product_type, created_at desc
    ) latest
    where state in ('pending', 'failed')
      and retryable
      and updated_at + (power(3, attempts - 1) * interval '1 minute') <= now()
  loop
    if r.attempts >= c_max_attempts then
      -- Out of attempts. A row still `pending` never got an answer from the function at all.
      update public.pipedrive_sync_log
         set state = 'failed',
             retryable = false,
             last_error = coalesce(last_error, 'No response from the sync function'),
             updated_at = now()
       where id = r.id;
    elsif v_url is not null and v_key is not null then
      update public.pipedrive_sync_log
         set attempts = attempts + 1, state = 'pending', updated_at = now()
       where id = r.id;
      begin
        perform net.http_post(
          url := v_url,
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
          body := jsonb_build_object(
            'action', 'move-deal',
            'projectId', r.project_id,
            'productType', r.product_type,
            'logId', r.id
          ),
          timeout_milliseconds := 15000
        );
      exception when others then
        raise warning 'pipedrive retry dispatch failed for log %: %', r.id, sqlerrm;
      end;
    end if;
  end loop;
end;
$$;

revoke all on function public.pipedrive_retry_due() from public, anon, authenticated;

-- Idempotent by job name. A no-op while the Vault secrets are absent (local dev, or paused).
select cron.schedule('pipedrive-sync-retry', '* * * * *', $$select public.pipedrive_retry_due()$$);
