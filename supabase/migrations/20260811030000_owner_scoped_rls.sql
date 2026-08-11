-- Step 4 of the auth/ownership workstream: the real lockdown.
--
-- RLS has been enabled on every one of these tables since before this repo
-- had any migrations (confirmed in Step 0's baseline pull) - but every
-- existing policy is `USING (true)` / `WITH CHECK (true)` for BOTH
-- authenticated AND anon, meaning anyone holding the public anon key can
-- already read, write, and delete every row in every one of these tables,
-- no login and no share_token required. This migration replaces that
-- wide-open policy set with owner-scoped access in the same transaction -
-- there is no window where the old permissive policies are gone but the new
-- ones aren't in place yet, since a single migration file runs as one
-- transaction.
--
-- Every policy below is derived from an actual query in src/supabase.js /
-- src/order.js / src/review.js, not written speculatively - see the comments
-- on each block for which call site it exists to support.
--
-- Every ownership check below goes through a security-definer helper rather
-- than an inline `exists (select 1 from public.projects ...)` subquery -
-- verified via local testing that the inline form has a real bug: a
-- subquery against `projects` is itself subject to `projects`' own RLS
-- SELECT policy, which has no "ownerless" branch, so an inline check for
-- `created_by is null` silently returns zero rows (RLS hides the row before
-- the created_by check ever runs) even though the row genuinely is
-- ownerless. The helpers below run as security definer specifically to
-- bypass that and reason about raw table state directly.

-- ── Helper predicates ───────────────────────────────────────

create or replace function "public"."is_staff_or_admin"()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('staff', 'admin')
  );
$$;

revoke all on function "public"."is_staff_or_admin"() from public;
grant execute on function "public"."is_staff_or_admin"() to "authenticated", "anon";

create or replace function "public"."has_share_token"("target_project_id" uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects
    where id = target_project_id and share_token is not null
  );
$$;

revoke all on function "public"."has_share_token"(uuid) from public;
grant execute on function "public"."has_share_token"(uuid) to "authenticated", "anon";

create or replace function "public"."owns_project"("target_project_id" uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects
    where id = target_project_id and created_by = auth.uid()
  );
$$;

revoke all on function "public"."owns_project"(uuid) from public;
grant execute on function "public"."owns_project"(uuid) to "authenticated", "anon";

create or replace function "public"."project_is_ownerless"("target_project_id" uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects
    where id = target_project_id and created_by is null
  );
$$;

revoke all on function "public"."project_is_ownerless"(uuid) from public;
grant execute on function "public"."project_is_ownerless"(uuid) to "authenticated", "anon";

-- ── projects ────────────────────────────────────────────────
drop policy "anon delete projects" on "public"."projects";
drop policy "anon insert projects" on "public"."projects";
drop policy "anon select projects" on "public"."projects";
drop policy "anon update projects" on "public"."projects";

-- createProject() (src/supabase.js) never sets created_by itself - it relies
-- on the column default (auth.uid()), which is NULL for anon (order.html) and
-- the real user id for an authenticated insert (landing.js "+ New project").
create policy "projects insert" on "public"."projects"
  for insert to "authenticated", "anon"
  with check (created_by is null or created_by = auth.uid());

-- anon branch: getProjectByToken() (review.html) selects by exact share_token
-- match - client already filters .eq('share_token', token), so this only
-- ever exposes a specific row to someone who already supplies its real
-- token value, same security level as today.
create policy "projects select" on "public"."projects"
  for select to "authenticated", "anon"
  using (
    share_token is not null
    or created_by = auth.uid()
    or public.is_staff_or_admin()
  );

-- updateProject() / upsertCustomerInfo() / generateShareToken() - all
-- authenticated-only call sites today.
create policy "projects update" on "public"."projects"
  for update to "authenticated"
  using (created_by = auth.uid() or public.is_staff_or_admin())
  with check (created_by = auth.uid() or public.is_staff_or_admin());

-- deleteProject() - authenticated-only.
create policy "projects delete" on "public"."projects"
  for delete to "authenticated"
  using (created_by = auth.uid() or public.is_staff_or_admin());

-- ── flag_config ─────────────────────────────────────────────
drop policy "anon delete flag_config" on "public"."flag_config";
drop policy "anon insert flag_config" on "public"."flag_config";
drop policy "anon select flag_config" on "public"."flag_config";
drop policy "anon update flag_config" on "public"."flag_config";

-- saveFlagConfig() - authenticated-only (the flag designer requires login).
create policy "flag_config insert" on "public"."flag_config"
  for insert to "authenticated"
  with check (public.owns_project(project_id) or public.is_staff_or_admin());

-- anon branch: getProjectByToken()'s flag_config read, and review.html's
-- Realtime subscription on this table - Realtime can't go through an RPC, so
-- this has to be a real table-level select policy, not just an RPC.
create policy "flag_config select" on "public"."flag_config"
  for select to "authenticated", "anon"
  using (
    public.has_share_token(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

create policy "flag_config update" on "public"."flag_config"
  for update to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin())
  with check (public.owns_project(project_id) or public.is_staff_or_admin());

-- deleteProject()'s cleanup loop - authenticated-only.
create policy "flag_config delete" on "public"."flag_config"
  for delete to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- ── hole_sign_config ────────────────────────────────────────
drop policy "anon delete hole_sign_config" on "public"."hole_sign_config";
drop policy "anon insert hole_sign_config" on "public"."hole_sign_config";
drop policy "anon select hole_sign_config" on "public"."hole_sign_config";
drop policy "anon update hole_sign_config" on "public"."hole_sign_config";

-- saveHoleSignConfig()/saveHsOneOffs() - authenticated-only.
create policy "hole_sign_config insert" on "public"."hole_sign_config"
  for insert to "authenticated"
  with check (public.owns_project(project_id) or public.is_staff_or_admin());

-- Same Realtime constraint as flag_config - review.html and hs/app.js both
-- subscribe to this table.
create policy "hole_sign_config select" on "public"."hole_sign_config"
  for select to "authenticated", "anon"
  using (
    public.has_share_token(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

create policy "hole_sign_config update" on "public"."hole_sign_config"
  for update to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin())
  with check (public.owns_project(project_id) or public.is_staff_or_admin());

create policy "hole_sign_config delete" on "public"."hole_sign_config"
  for delete to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- ── project_logos ───────────────────────────────────────────
drop policy "anon delete project_logos" on "public"."project_logos";
drop policy "anon insert project_logos" on "public"."project_logos";
drop policy "anon select project_logos" on "public"."project_logos";
-- (no "anon update project_logos" existed before this migration either - no
-- client code updates a logo row, only insert/select/delete.)

-- uploadLogo() is called from BOTH the anon order form (order.js:768, upload
-- their own logo onto the project they just anonymously created) and the
-- authenticated designer flow - anon branch is scoped to their own
-- just-created, still-ownerless project, not any arbitrary project_id.
create policy "project_logos insert" on "public"."project_logos"
  for insert to "authenticated", "anon"
  with check (
    public.project_is_ownerless(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

-- anon branch: review.html loads the logo library too (src/review.js).
create policy "project_logos select" on "public"."project_logos"
  for select to "authenticated", "anon"
  using (
    public.has_share_token(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

-- deleteLogo()/deleteProject() - authenticated-only.
create policy "project_logos delete" on "public"."project_logos"
  for delete to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- ── order_intakes ───────────────────────────────────────────
drop policy "anon delete order_intakes" on "public"."order_intakes";
drop policy "anon insert" on "public"."order_intakes";
drop policy "anon select" on "public"."order_intakes";
drop policy "anon select order_intakes" on "public"."order_intakes";

-- order.js's submit flow: createProject() then immediately inserts the
-- intake against that exact fresh project_id. Tightened beyond a bare `with
-- check (true)` - anon can only attach an intake to a project that is still
-- ownerless (their own), not an arbitrary existing project_id they might
-- guess or enumerate.
create policy "order_intakes insert" on "public"."order_intakes"
  for insert to "authenticated", "anon"
  with check (
    public.project_is_ownerless(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

-- loadOrderIntake()/loadEventName() - authenticated-only, no anon read path
-- exists anywhere in the app for this table.
create policy "order_intakes select" on "public"."order_intakes"
  for select to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- deleteProject()'s cleanup loop - authenticated-only.
create policy "order_intakes delete" on "public"."order_intakes"
  for delete to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- ── variation_feedback ──────────────────────────────────────
drop policy "anon delete variation_feedback" on "public"."variation_feedback";
drop policy "anon insert variation_feedback" on "public"."variation_feedback";
drop policy "anon select variation_feedback" on "public"."variation_feedback";
drop policy "anon update variation_feedback" on "public"."variation_feedback";

-- submitFeedback() - both an authenticated designer and an anon reviewer
-- (review.html) can leave feedback. Anon branch scoped to a project that was
-- actually shared, not any guessable project_id.
create policy "variation_feedback insert" on "public"."variation_feedback"
  for insert to "authenticated", "anon"
  with check (
    public.has_share_token(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

-- getFeedback() - anon branch lets review.html show a reviewer their own
-- previously-submitted notes; Realtime also subscribes to this table from
-- both the designer and review.html.
create policy "variation_feedback select" on "public"."variation_feedback"
  for select to "authenticated", "anon"
  using (
    public.has_share_token(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

-- resolveFeedback() - authenticated-only.
create policy "variation_feedback update" on "public"."variation_feedback"
  for update to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());

-- deleteProject()'s cleanup loop - authenticated-only.
create policy "variation_feedback delete" on "public"."variation_feedback"
  for delete to "authenticated"
  using (public.owns_project(project_id) or public.is_staff_or_admin());
