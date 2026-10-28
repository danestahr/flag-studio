-- Permanent Prestige order download links. Each "Send to Prestige" stores the
-- print zip in the private print-sheets bucket and creates a row here; the
-- row's id is the public link token (/prestige-download?id=<id>). Anyone with
-- the link can download any number of times, no expiry - the prestige-download
-- edge function mints a short-lived signed URL per download and logs a
-- prestige_downloads row, whose latest timestamp the project overview shows.
--
-- Both tables are written only by edge functions (service role). Staff/owners
-- can read them directly; anon has no policy at all (default-deny).
create table public.prestige_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  size_bytes bigint not null,
  variation_count int not null default 0,
  flag_count int not null default 0,
  in_hand_date date,
  -- null until the order email actually goes out (a prepared-only page for inspection has no sent_at)
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index prestige_orders_project_idx on public.prestige_orders (project_id, created_at desc);

create table public.prestige_downloads (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.prestige_orders(id) on delete cascade,
  email text, -- no email gate: the public page just logs the click
  downloaded_at timestamptz not null default now()
);
create index prestige_downloads_order_idx on public.prestige_downloads (order_id, downloaded_at);

alter table public.prestige_orders enable row level security;
alter table public.prestige_downloads enable row level security;

create policy "prestige_orders select" on public.prestige_orders
  for select to authenticated
  using (public.owns_project(project_id) or public.is_staff_or_admin());

create policy "prestige_downloads select" on public.prestige_downloads
  for select to authenticated
  using (exists (
    select 1 from public.prestige_orders o
    where o.id = order_id and (public.owns_project(o.project_id) or public.is_staff_or_admin())
  ));
