-- handle_new_user() has existed since the baseline migration, but no
-- migration ever attached it to auth.users - it was evidently wired up by
-- hand directly on production (via dashboard/SQL editor) at some point, so
-- production signups correctly populate profiles, but every local
-- `supabase start`/`db reset` reproduces the function with nothing calling
-- it. Confirmed locally: two fresh signups landed in auth.users with zero
-- matching profiles rows. This is very likely why past local test accounts
-- had to be hand-inserted into profiles directly (bypassing grant_role()
-- entirely, with no role_grants audit row) - there was no other way to get
-- a usable local account.
--
-- CREATE TRIGGER IF NOT EXISTS isn't available for triggers pre-PG15
-- syntax portability, so this guards manually - safe to re-run, and a
-- no-op against production if the equivalent trigger already exists there
-- under this name.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'on_auth_user_created'
      and tgrelid = 'auth.users'::regclass
  ) then
    create trigger "on_auth_user_created"
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end $$;
