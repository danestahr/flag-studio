-- Admin "email a print-sheet link" feature. New, dedicated private bucket -
-- NOT a reuse of `renders`, which turns out to already hold 4 real objects
-- in production (confirmed via query, including a prestige-orders/*.zip
-- path from a flow that no longer uploads there - historical/orphaned, not
-- from the dead render-hole-signs function this plan removes) - not the
-- empty, safe-to-repurpose bucket it was assumed to be. Reusing it here
-- would tangle this feature's authorization boundary with an existing,
-- fully-public bucket that has its own unrelated history.
--
-- storage.objects ships with RLS already enabled by Supabase's storage
-- extension - this migration only adds policies, reusing the exact
-- is_staff_or_admin() helper already defined for every other RLS policy in
-- this repo (see 20260811030000_owner_scoped_rls.sql), not a new bypass
-- mechanism. No policy exists for anon or a plain 'customer' role -
-- default-deny, so a customer session cannot list or upload here even by
-- calling the Storage API directly.
--
-- No update policy: uploads are always upsert:false from the client, so
-- objects are immutable once written. The only way anyone ever reads an
-- object is a signed URL minted server-side (with the service role, which
-- bypasses RLS) by the send-print-sheet-ready edge function - recipients
-- never need a row-level grant of their own, so there is no select policy
-- for anon/authenticated either.
insert into storage.buckets (id, name, public)
values ('print-sheets', 'print-sheets', false)
on conflict (id) do update set public = false;

create policy "print_sheets insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'print-sheets' and public.is_staff_or_admin());

create policy "print_sheets select" on storage.objects
  for select to authenticated
  using (bucket_id = 'print-sheets' and public.is_staff_or_admin());

create policy "print_sheets delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'print-sheets' and public.is_staff_or_admin());
