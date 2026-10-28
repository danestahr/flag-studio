-- Failed Prestige downloads, reported by the public download page. A row in
-- prestige_downloads now means the file was fully fetched (success only);
-- failures land here so staff can see that Prestige hit a problem. Written
-- only by the prestige-download edge function (service role); readable by
-- staff/owners in the same shape as prestige_downloads.
create table public.prestige_download_errors (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.prestige_orders(id) on delete cascade,
  stage text,        -- where it failed: sign | fetch | write
  error text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index prestige_download_errors_order_idx on public.prestige_download_errors (order_id, created_at);

alter table public.prestige_download_errors enable row level security;

create policy "prestige_download_errors select" on public.prestige_download_errors
  for select to authenticated
  using (exists (
    select 1 from public.prestige_orders o
    where o.id = order_id and (public.owns_project(o.project_id) or public.is_staff_or_admin())
  ));
