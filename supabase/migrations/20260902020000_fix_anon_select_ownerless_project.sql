-- Fixes a break in the order.html submit flow introduced by
-- 20260811030000_owner_scoped_rls.sql: createProject() and uploadLogo()
-- (src/supabase.js) both do `.insert(...).select(...).single()`, and
-- Postgres enforces the table's SELECT policy against RETURNING - not just
-- the INSERT policy's WITH CHECK. The anon SELECT policy on "projects" only
-- covers rows with a share_token, and a freshly-created anon project has
-- none yet, so reading back the just-inserted row (to get its id) raised
-- "new row violates row-level security policy for table \"projects\"" on
-- every anonymous order submission. Same bug for project_logos after
-- uploadLogo()'s insert.
--
-- projects: checks created_by is null directly rather than reusing
-- project_is_ownerless(id) - that function subquery-selects from
-- public.projects itself, and a STABLE function's subquery doesn't see the
-- row this same INSERT statement is still in the middle of returning
-- (confirmed by hand: the function version raises the same RLS error
-- forever, even after the policy is fixed, because it's checking the row
-- against a snapshot that predates its own insert). A plain column
-- comparison against the in-flight tuple doesn't have that problem.
--
-- project_logos: safe to use project_is_ownerless(project_id) as-is - it
-- looks up a *different*, already-committed table row (the project, created
-- in an earlier request by createProject()), not the row being inserted.

drop policy "projects select (anon, share token)" on "public"."projects";
create policy "projects select (anon, share token)" on "public"."projects"
  for select to "anon"
  using (share_token is not null or created_by is null);

drop policy "project_logos select (anon, share token)" on "public"."project_logos";
create policy "project_logos select (anon, share token)" on "public"."project_logos"
  for select to "anon"
  using (public.has_share_token(project_id) or public.project_is_ownerless(project_id));
