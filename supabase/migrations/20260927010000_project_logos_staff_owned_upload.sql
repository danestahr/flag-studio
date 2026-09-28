-- landing.js's admin "+ New project" fast-path creates the row while the
-- admin is logged in, so `created_by` defaults to the admin's own uid
-- instead of staying null. That means such a project is neither
-- project_is_ownerless() nor owns_project() for the anonymous customer who
-- later visits their post-order links (upload-logos.html, and the project
-- page itself before a share_token has been minted) - every anon branch of
-- the "projects"/"project_logos" policies fails, and the customer can't even
-- load the project, let alone upload a logo to it.
--
-- project_is_staff_owned() closes that gap by recognizing "created_by
-- belongs to a staff/admin profile, not a real customer" as equivalent to
-- ownerless for anon access purposes - the project has no real logged-in
-- owner session claiming it either way. Modeled on project_is_ownerless()
-- (20260811030000_owner_scoped_rls.sql): a plain security-definer lookup, not
-- reusable inside the same INSERT...RETURNING statement pattern that
-- 20260902020000_fix_anon_select_ownerless_project.sql had to special-case
-- (that recursion issue only applies to a function subquerying the very
-- projects row still being inserted; here the row was already committed
-- earlier by the admin, in a separate request, so it's safe to use in a
-- plain function everywhere it's needed).
create or replace function public.project_is_staff_owned(target_project_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    join public.profiles pr on pr.id = p.created_by
    where p.id = target_project_id and pr.role in ('staff', 'admin')
  );
$$;

revoke all on function public.project_is_staff_owned(uuid) from public;
grant execute on function public.project_is_staff_owned(uuid) to authenticated, anon;

-- projects: anon needs to load the project at all (upload-logos.html,
-- review.html before a share_token exists) once it's staff-owned, same as
-- it already can for an ownerless one.
drop policy "projects select (anon, share token)" on public.projects;
create policy "projects select (anon, share token)" on public.projects
  for select to anon
  using (share_token is not null or created_by is null or public.project_is_staff_owned(id));

-- project_logos: anon needs to see existing logos (upload-logos.html's
-- "Current logos" list) on a staff-owned project the same way it already
-- can on an ownerless one.
drop policy "project_logos select (anon, share token)" on public.project_logos;
create policy "project_logos select (anon, share token)" on public.project_logos
  for select to anon
  using (public.has_share_token(project_id) or public.project_is_ownerless(project_id) or public.project_is_staff_owned(project_id));

-- project_logos: the actual upload itself.
drop policy "project_logos insert" on public.project_logos;
create policy "project_logos insert" on public.project_logos
  for insert to authenticated, anon
  with check (
    (public.project_is_ownerless(project_id) and public.project_has_unlocked_design(project_id))
    or (public.project_is_staff_owned(project_id) and public.project_has_unlocked_design(project_id))
    or (public.owns_project(project_id) and public.project_has_unlocked_design(project_id))
    or public.is_staff_or_admin()
  );
