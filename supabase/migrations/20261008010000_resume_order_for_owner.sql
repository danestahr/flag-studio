-- The "continue your order" email link (order.html?resume=<project id>) must keep
-- working for anonymous customers on any device. It only resolves while the
-- project is ownerless, but claim_my_projects() (run on sign-in) attached
-- in-progress orders to the matching account, so the link then found nothing.
-- Fix: only claim projects whose order has been submitted; an in-progress order
-- stays ownerless (and anon-resumable) until the customer places it.
create or replace function "public"."claim_my_projects"() returns setof "uuid"
    language "plpgsql" security definer
    set "search_path" to 'public'
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
    and oi.submitted_at is not null
    and lower(oi.contact_email) = lower(my_email)
  returning p.id;
end;
$$;

-- Owners/staff (e.g. admin-created projects, or orders already claimed before
-- this migration) can resume too; anon behaviour is unchanged.
create or replace function "public"."get_order_intake_for_resume"("p_project_id" uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(oi)
  from public.order_intakes oi
  where oi.project_id = p_project_id
    and oi.submitted_at is null
    and (
      public.project_is_ownerless(p_project_id)
      or public.owns_project(p_project_id)
      or public.is_staff_or_admin()
    );
$$;
