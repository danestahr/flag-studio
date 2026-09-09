-- Local dev bootstrap: a fresh `supabase db reset` wipes auth.users, so this
-- recreates a standing admin login instead of it having to be redone by hand
-- every time. Local-only — never applied against the hosted project.

do $$
declare
  admin_id uuid;
  admin_email text := 'dane@danestahr.com';
  admin_password text := 'localdev123';
begin
  select id into admin_id from auth.users where email = admin_email;

  if admin_id is null then
    admin_id := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000',
      admin_id, 'authenticated', 'authenticated', admin_email,
      extensions.crypt(admin_password, extensions.gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}', '{}',
      now(), now(),
      '', '', '', ''
    );

    insert into auth.identities (
      id, provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), admin_id, admin_id,
      jsonb_build_object('sub', admin_id::text, 'email', admin_email),
      'email', now(), now(), now()
    );
  end if;

  -- handle_new_user's trigger already created a 'customer' profile row;
  -- bypass prevent_role_self_update the same way grant_role() does.
  perform set_config('app.allow_role_change', 'true', true);
  update public.profiles set role = 'admin', updated_at = now() where id = admin_id;
end $$;
