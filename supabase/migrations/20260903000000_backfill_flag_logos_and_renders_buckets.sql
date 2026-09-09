-- Backfills two storage buckets that exist on the hosted project but were
-- never captured in a migration - they were created directly (dashboard or
-- an ad-hoc script) before print-sheets became the first bucket ever set up
-- via migration (20260812030000_print_sheets_storage.sql). Confirmed via
-- `supabase db dump --linked -s storage`: both already exist in production
-- with these exact settings/policies. Because they were never migrated,
-- `supabase db reset` locally never creates them, so uploadLogo() - and
-- therefore the whole order.html submit flow, which uploads a logo right
-- after creating the project - fails locally with a storage "Bucket not
-- found" error that doesn't happen in production.
--
-- `on conflict do nothing` / existence-checked policy creation makes this
-- safe to also run against production, where the bucket rows and policies
-- already exist.

insert into storage.buckets (id, name, public)
values
  ('flag-logos', 'flag-logos', true),
  ('renders', 'renders', true)
on conflict (id) do nothing;

-- uploadLogo() (src/supabase.js) writes/reads flag-logos as anon (order.html,
-- pre-account) and authenticated (the flag/hole-sign designers) alike, and
-- the bucket is public - matches production's "Allow public uploads" policy:
-- no role restriction, all commands, gated only on bucket_id.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Allow public uploads'
  ) then
    create policy "Allow public uploads" on "storage"."objects"
      using (bucket_id = 'flag-logos')
      with check (bucket_id = 'flag-logos');
  end if;
end $$;

-- renders is legacy (CLAUDE.md: "holds a few historical objects - not
-- written to by any current code path") - backfilled for schema parity only,
-- scoped exactly as it is in production.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Allow authenticated uploads to prestige-orders'
  ) then
    create policy "Allow authenticated uploads to prestige-orders" on "storage"."objects"
      for insert to "authenticated"
      with check (bucket_id = 'renders' and (storage.foldername(name))[1] = 'prestige-orders');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Allow authenticated updates to prestige-orders'
  ) then
    create policy "Allow authenticated updates to prestige-orders" on "storage"."objects"
      for update to "authenticated"
      using (bucket_id = 'renders' and (storage.foldername(name))[1] = 'prestige-orders');
  end if;
end $$;
