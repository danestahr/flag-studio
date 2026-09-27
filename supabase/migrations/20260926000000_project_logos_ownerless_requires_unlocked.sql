-- The public /upload-logos page lets a customer add logos to their project
-- any time after ordering, with no login — it rides the same
-- project_is_ownerless(project_id) branch order.js's own pre-login
-- uploadLogo() already uses (see 20260811030000_owner_scoped_rls.sql). But
-- that branch has never been tied to design-lock status, unlike the owner
-- branch added in 20260913000000_per_design_status_workflow.sql
-- (owns_project AND project_has_unlocked_design) — whose own comment is
-- exactly the reasoning this closes for the anon case too: block new logo
-- uploads once a design is under review, rather than risk a new upload
-- being mistaken for content belonging to the design currently being
-- reviewed. Safe for the order-creation flow itself: that always runs
-- before any flag_config/hole_sign_config row exists, and
-- project_has_unlocked_design() treats "no config row yet" as unlocked.

drop policy "project_logos insert" on public.project_logos;
create policy "project_logos insert" on public.project_logos
  for insert to authenticated, anon
  with check (
    (public.project_is_ownerless(project_id) and public.project_has_unlocked_design(project_id))
    or (public.owns_project(project_id) and public.project_has_unlocked_design(project_id))
    or public.is_staff_or_admin()
  );
