-- Step 3 of the auth/ownership workstream, simplified per decision: no claim
-- token/link — any project whose order_intakes.contact_email matches a
-- logged-in user's own (necessarily confirmed, since Confirm Email is on)
-- account email is auto-attached on login, no per-project confirmation step.
-- Shared inboxes are an accepted non-issue: whoever logs in with that email
-- gets full access to everything submitted from it.
--
-- A plain client-side `update projects set created_by = auth.uid() where ...`
-- can't do this — RLS ownership policies (landing in a later step) only ever
-- let an owner touch rows they already own, not claim a fresh one. This
-- function is the one narrow, guarded bridge for that.
create or replace function "public"."claim_my_projects"()
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  my_email text;
begin
  my_email := auth.email();
  if my_email is null then
    raise exception 'not authenticated';
  end if;

  return query
  update public.projects p
  set created_by = auth.uid()
  from public.order_intakes oi
  where oi.project_id = p.id
    and p.created_by is null
    and lower(oi.contact_email) = lower(my_email)
  returning p.id;
end;
$$;

revoke all on function "public"."claim_my_projects"() from public;
grant execute on function "public"."claim_my_projects"() to "authenticated";
