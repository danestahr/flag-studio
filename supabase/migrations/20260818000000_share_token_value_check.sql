-- Closes a real PII-exposure gap in the "review link" access model.
--
-- has_share_token()/`share_token is not null` (20260811030000) only checks
-- that a project HAS been shared at some point - not that the caller
-- actually supplied its real share_token. Since the anon key is public,
-- anyone could already call the REST API directly with no filter at all:
--
--   GET {SUPABASE_URL}/rest/v1/projects?select=*
--   apikey: <public anon key>
--
-- and get back every ever-shared project's row - including customer_info
-- (contact name, email, mailing address) and the real share_token, no link
-- required. Those leaked tokens then unlock that project's flag_config,
-- hole_sign_config, project_logos, and variation_feedback the same way.
--
-- Fixed by binding the check to a value the caller must actually present:
-- review.js now sends the token as an `x-share-token` request header (via
-- createReviewClient() in src/supabase.js), and the policies below compare
-- that header against the row's real share_token instead of just checking
-- it's non-null.
--
-- flag_config and hole_sign_config deliberately KEEP the old, loose
-- has_share_token() check rather than moving to this stricter one: Realtime's
-- postgres_changes authorization has no access to custom HTTP headers (it
-- evaluates RLS using only the socket's connected JWT), so switching those
-- two to a header-based check would silently kill review.html's
-- live-refresh-on-designer-edit subscription (src/review.js
-- subscribeToDesignChanges()). Those tables hold only design/color config,
-- not customer PII, so the residual gap - readable by anyone who already
-- has a project's UUID without its real token, i.e. a 128-bit guess - is an
-- accepted tradeoff for now. Properly closing it needs the reviewer session
-- to carry the token as a JWT claim instead of a header (Realtime *can* see
-- JWT claims); that's a bigger change, tracked as follow-up, not done here.

create or replace function "public"."request_share_token"()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-share-token', '');
$$;

create or replace function "public"."has_matching_share_token"("target_project_id" uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects
    where id = target_project_id
      and share_token is not null
      and share_token = public.request_share_token()
  );
$$;

revoke all on function "public"."has_matching_share_token"(uuid) from public;
grant execute on function "public"."has_matching_share_token"(uuid) to "authenticated", "anon";

-- ── projects ────────────────────────────────────────────────
-- getProjectByToken() (review.html) - only call site of the anon branch.
drop policy "projects select" on "public"."projects";

create policy "projects select" on "public"."projects"
  for select to "authenticated", "anon"
  using (
    share_token = public.request_share_token()
    or created_by = auth.uid()
    or public.is_staff_or_admin()
  );

-- ── project_logos ───────────────────────────────────────────
-- loadLogosForProject() from review.html - not Realtime-subscribed, safe to tighten.
drop policy "project_logos select" on "public"."project_logos";

create policy "project_logos select" on "public"."project_logos"
  for select to "authenticated", "anon"
  using (
    public.has_matching_share_token(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

-- ── variation_feedback ──────────────────────────────────────
-- getFeedback()/submitFeedback() from review.html - the designer-side
-- Realtime subscriptions (flags/variations.js, flags/gallery.js, hs/app.js)
-- are all authenticated and covered by owns_project()/is_staff_or_admin(),
-- so tightening the anon branch here doesn't touch Realtime.
drop policy "variation_feedback select" on "public"."variation_feedback";
drop policy "variation_feedback insert" on "public"."variation_feedback";

create policy "variation_feedback select" on "public"."variation_feedback"
  for select to "authenticated", "anon"
  using (
    public.has_matching_share_token(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

create policy "variation_feedback insert" on "public"."variation_feedback"
  for insert to "authenticated", "anon"
  with check (
    public.has_matching_share_token(project_id)
    or public.owns_project(project_id)
    or public.is_staff_or_admin()
  );

-- ── profiles ────────────────────────────────────────────────
-- Was `using (true)` for any authenticated user - every customer account
-- could read every other customer's and every staff member's email/name
-- (`select * from profiles`). Scoped to: your own row, or staff/admin see
-- all (needed for listProjects()'s profiles(email, first_name, last_name)
-- join in src/supabase.js, used on the staff/admin unscoped branch).
drop policy "profiles select all" on "public"."profiles";

create policy "profiles select own or staff" on "public"."profiles"
  for select to "authenticated"
  using (id = auth.uid() or public.is_staff_or_admin());
