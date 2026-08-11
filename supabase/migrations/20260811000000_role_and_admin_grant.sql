-- Step 1 of the auth/ownership workstream: add a role concept to profiles,
-- close the self-escalation path on the existing "profiles update own" policy,
-- and lay down the audit tables admin work depends on later.
-- Purely additive — nothing in the app reads `role` or calls grant_role() yet,
-- so this changes no runtime behavior for the current team.

-- 1. role column, backfilled to 'staff' since every existing profile today
--    predates self-serve customer accounts.
alter table "public"."profiles"
  add column "role" text not null default 'customer'
  check ("role" in ('customer', 'staff', 'admin'));

update "public"."profiles" set "role" = 'staff';

-- 2. Block direct self-escalation. RLS is row-level, not column-level, and the
--    existing "profiles update own" policy (auth.uid() = id) already lets any
--    logged-in user update every column on their own row, including role — so
--    without this, adding role would let a customer just grant themselves admin.
--    grant_role() below is the only sanctioned path; it flips a transaction-local
--    flag immediately before its own update so this trigger lets that one write through.
create or replace function "public"."prevent_role_self_update"()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role
     and coalesce(current_setting('app.allow_role_change', true), 'false') <> 'true' then
    raise exception 'role cannot be changed directly; use grant_role()';
  end if;
  return new;
end;
$$;

create trigger "prevent_role_self_update"
  before update on "public"."profiles"
  for each row
  execute function "public"."prevent_role_self_update"();

-- 3. Audit trail for every role change, independent of who made it.
create table "public"."role_grants" (
  "id" uuid primary key default gen_random_uuid(),
  "granted_by" uuid references "auth"."users"("id") on delete set null,
  "granted_by_email" text,
  "target_user_id" uuid references "auth"."users"("id") on delete set null,
  "target_email" text,
  "old_role" text,
  "new_role" text not null,
  "granted_at" timestamptz not null default now()
);

alter table "public"."role_grants" enable row level security;

create policy "staff and admin can read role_grants"
  on "public"."role_grants" for select
  to "authenticated"
  using (
    exists (
      select 1 from "public"."profiles" p
      where p.id = auth.uid() and p.role in ('staff', 'admin')
    )
  );
-- No insert/update/delete policy for any client role — only grant_role() (below,
-- security definer) writes rows here, so the audit trail can't be edited or
-- backfilled after the fact by anyone going through the normal API.

-- 4. The only sanctioned way to change someone's role.
create or replace function "public"."grant_role"("target_user_id" uuid, "new_role" text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
  caller_email text;
  target_email text;
  prior_role text;
begin
  select role, email into caller_role, caller_email
  from public.profiles where id = auth.uid();

  if caller_role is distinct from 'admin' then
    raise exception 'only admins can grant roles';
  end if;

  if new_role not in ('customer', 'staff', 'admin') then
    raise exception 'invalid role: %', new_role;
  end if;

  select role, email into prior_role, target_email
  from public.profiles where id = target_user_id;

  if prior_role is null then
    raise exception 'target user not found';
  end if;

  insert into public.role_grants
    (granted_by, granted_by_email, target_user_id, target_email, old_role, new_role)
  values
    (auth.uid(), caller_email, target_user_id, target_email, prior_role, new_role);

  perform set_config('app.allow_role_change', 'true', true);
  update public.profiles set role = new_role, updated_at = now() where id = target_user_id;
end;
$$;

revoke all on function "public"."grant_role"(uuid, text) from public;
grant execute on function "public"."grant_role"(uuid, text) to "authenticated";

-- 5. Audit table for admin project access — both "viewed" and (later, once
--    Workstream C's takeover UI ships) "edited" actions land here. Created now
--    so the schema exists before any admin-facing UI is built against it.
create table "public"."admin_actions" (
  "id" uuid primary key default gen_random_uuid(),
  "admin_id" uuid references "auth"."users"("id") on delete set null,
  "admin_email" text,
  "project_id" uuid references "public"."projects"("id") on delete set null,
  "action" text not null,
  "note" text,
  "created_at" timestamptz not null default now()
);

alter table "public"."admin_actions" enable row level security;

create policy "staff and admin can log their own admin_actions"
  on "public"."admin_actions" for insert
  to "authenticated"
  with check (
    admin_id = auth.uid()
    and exists (
      select 1 from "public"."profiles" p
      where p.id = auth.uid() and p.role in ('staff', 'admin')
    )
  );

create policy "staff and admin can read admin_actions"
  on "public"."admin_actions" for select
  to "authenticated"
  using (
    exists (
      select 1 from "public"."profiles" p
      where p.id = auth.uid() and p.role in ('staff', 'admin')
    )
  );
-- No update/delete policy anywhere — audit rows are write-once by design.
