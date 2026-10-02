-- One row per outbound email attempt, written by the send-* edge functions
-- with the service role. Staff/admin can read; nobody writes from the client.
create table public.email_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null,
  project_id uuid,
  recipient text not null,
  status text not null check (status in ('sent', 'failed')),
  http_status int,
  error text
);

create index email_log_project_idx on public.email_log (project_id, created_at desc);
create index email_log_failed_idx on public.email_log (created_at desc) where status = 'failed';

alter table public.email_log enable row level security;

create policy "staff and admin can read email_log"
  on public.email_log for select
  using (public.is_staff_or_admin());
