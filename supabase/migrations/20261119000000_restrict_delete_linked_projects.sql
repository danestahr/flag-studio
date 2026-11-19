-- A project linked to a Pipedrive deal can't be deleted: unlink it first (Project page > Pipedrive
-- > Unlink, which also clears the deal's "Design Studio Project Link"). Deleting a linked project
-- would orphan the deal's workflow (stage sync, board card, the auto-create idempotency anchor).
--
-- Two layers, same shape as the rest of the permission model:
--   1. RLS - the real boundary: the existing "projects delete" policy gains "not linked", so no
--      client (or direct REST call) can delete a linked project, owner or staff.
--   2. delete_project() - raises a readable error up front instead of the generic
--      "not found or not permitted" the RLS-filtered DELETE would produce. The service-role
--      caller (sweep-abandoned-drafts) bypasses RLS but hits this check too, so the sweeper can
--      never silently delete a linked project either.
-- The BEFORE DELETE link-clearing trigger stays as a backstop for any path that bypasses both
-- (e.g. a manual SQL delete by a database admin).

drop policy if exists "projects delete" on "public"."projects";
create policy "projects delete" on "public"."projects"
  for delete to "authenticated"
  using (
    (created_by = auth.uid() or public.is_staff_or_admin())
    and pipedrive_flags_deal_id is null
    and pipedrive_hs_deal_id is null
  );

create or replace function "public"."delete_project"("target_project_id" uuid)
returns text[]
language plpgsql
as $$
declare
  logo_paths text[];
begin
  if exists (
    select 1 from public.projects
    where id = target_project_id
      and (pipedrive_flags_deal_id is not null or pipedrive_hs_deal_id is not null)
  ) then
    raise exception 'Project % is linked to a Pipedrive deal; unlink it before deleting', target_project_id
      using errcode = 'P0001', hint = 'pipedrive_linked';
  end if;

  select coalesce(array_agg(storage_path), '{}')
    into logo_paths
    from public.project_logos
    where project_id = target_project_id;

  delete from public.projects where id = target_project_id;

  if not found then
    raise exception 'Project % not found or not permitted', target_project_id;
  end if;

  return logo_paths;
end;
$$;

revoke all on function "public"."delete_project"(uuid) from public;
grant execute on function "public"."delete_project"(uuid) to "authenticated";
