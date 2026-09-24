-- Shared logo library: logos reusable across a user's own projects, not tied
-- to one project_id (unlike project_logos, whose RLS is irreducibly keyed off
-- project ownership). Scoped by created_by = auth.uid(), with the same
-- staff/admin OR-branch used everywhere else in this schema.
create table public.user_logos (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  storage_path text not null,
  public_url text not null,
  created_at timestamptz not null default now()
);

alter table public.user_logos enable row level security;

create policy "user_logos insert" on public.user_logos
  for insert to authenticated
  with check (created_by = auth.uid() or public.is_staff_or_admin());

create policy "user_logos select" on public.user_logos
  for select to authenticated
  using (created_by = auth.uid() or public.is_staff_or_admin());

create policy "user_logos delete" on public.user_logos
  for delete to authenticated
  using (created_by = auth.uid() or public.is_staff_or_admin());
