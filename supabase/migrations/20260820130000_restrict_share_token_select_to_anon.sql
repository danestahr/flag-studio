-- Closes a real leak: the "select" policies added in
-- 20260811030000_owner_scoped_rls.sql grant the share-token branch to BOTH
-- "authenticated" and "anon". That branch exists only so review.html's
-- anonymous reviewer (createReviewClient() - a separate client carrying no
-- auth session, always evaluated as Postgres role "anon") can read one
-- shared project. Because the branch also covers "authenticated", any
-- logged-in customer can read every row that has ever been shared for
-- review, system-wide - not just their own - regardless of what the
-- frontend's own query filters do. Confirmed in production: a
-- role='customer' account could see another customer's project in the
-- landing page list purely because that project had a non-null
-- share_token.
--
-- Fix: split each combined policy into two - an anon-only policy keeping
-- the share-token branch, and an authenticated-only policy with just
-- owns_project()/is_staff_or_admin(). Anon behavior (review.html) is
-- unchanged. Authenticated behavior loses only the share-token bypass;
-- owners and staff/admin keep exactly the access they had.

-- ── projects ────────────────────────────────────────────────
drop policy "projects select" on "public"."projects";

create policy "projects select (anon, share token)" on "public"."projects"
  for select to "anon"
  using (share_token is not null);

create policy "projects select (authenticated)" on "public"."projects"
  for select to "authenticated"
  using (created_by = auth.uid() or public.is_staff_or_admin());

-- ── flag_config ─────────────────────────────────────────────
drop policy "flag_config select" on "public"."flag_config";

create policy "flag_config select (anon, share token)" on "public"."flag_config"
  for select to "anon"
  using (public.has_share_token(project_id));

create policy "flag_config select (authenticated)" on "public"."flag_config"
  for select to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- ── hole_sign_config ────────────────────────────────────────
drop policy "hole_sign_config select" on "public"."hole_sign_config";

create policy "hole_sign_config select (anon, share token)" on "public"."hole_sign_config"
  for select to "anon"
  using (public.has_share_token(project_id));

create policy "hole_sign_config select (authenticated)" on "public"."hole_sign_config"
  for select to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- ── project_logos ───────────────────────────────────────────
drop policy "project_logos select" on "public"."project_logos";

create policy "project_logos select (anon, share token)" on "public"."project_logos"
  for select to "anon"
  using (public.has_share_token(project_id));

create policy "project_logos select (authenticated)" on "public"."project_logos"
  for select to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- ── variation_feedback ──────────────────────────────────────
drop policy "variation_feedback select" on "public"."variation_feedback";

create policy "variation_feedback select (anon, share token)" on "public"."variation_feedback"
  for select to "anon"
  using (public.has_share_token(project_id));

create policy "variation_feedback select (authenticated)" on "public"."variation_feedback"
  for select to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());
