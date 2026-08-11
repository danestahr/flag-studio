-- Step 2 of the auth/ownership workstream: the existing handle_new_user()
-- trigger only ever copied email into profiles, never first_name/last_name.
-- signup.js now passes those via auth.signUp()'s options.data, which lands in
-- raw_user_meta_data immediately (even before email confirmation) — pull them
-- from there. coalesce on conflict so a later metadata update (e.g. missing a
-- name key) never blanks out a name that was already captured.
create or replace function "public"."handle_new_user"()
returns "trigger"
language "plpgsql" security definer
set "search_path" to 'public'
as $$
begin
  insert into public.profiles (id, email, first_name, last_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name'
  )
  on conflict (id) do update set
    email = excluded.email,
    first_name = coalesce(excluded.first_name, public.profiles.first_name),
    last_name = coalesce(excluded.last_name, public.profiles.last_name),
    updated_at = now();
  return new;
end;
$$;
