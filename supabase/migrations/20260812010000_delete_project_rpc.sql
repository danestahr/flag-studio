-- Workstream B: deleteProject() atomicity.
--
-- The client previously did 8 sequential, non-transactional round-trips -
-- storage cleanup FIRST, then five per-table deletes, then the projects row
-- last. A failure partway through could orphan DB rows pointing at
-- already-deleted storage objects (the worse failure mode - an orphaned
-- storage object is harmless, an orphaned DB row is not).
--
-- All five child tables (flag_config, hole_sign_config, order_intakes,
-- project_logos, variation_feedback) already have ON DELETE CASCADE to
-- projects (confirmed in the baseline dump, no separate per-table deletes
-- were ever actually necessary) - so this function only needs to capture the
-- logo storage paths before deleting the projects row; the single DELETE
-- statement's cascade handles every child row atomically in one transaction.
--
-- security invoker (the default - not stated explicitly) means the DELETE
-- below is still subject to the existing "projects delete" RLS policy
-- (created_by = auth.uid() or is_staff_or_admin()) - no separate ownership
-- check is duplicated here. If RLS silently filters the row (caller doesn't
-- own it and isn't staff/admin), FOUND is false and this raises rather than
-- reporting a false success back to the client.
create or replace function "public"."delete_project"("target_project_id" uuid)
returns text[]
language plpgsql
as $$
declare
  logo_paths text[];
begin
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
