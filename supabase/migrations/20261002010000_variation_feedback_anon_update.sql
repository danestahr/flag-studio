-- submitFeedback() (src/supabase.js) upserts on (project_id, product_type,
-- variation_id), so review.html's anon reviewer hits the ON CONFLICT DO UPDATE
-- branch whenever a feedback row already exists for that variation (changed
-- their mind, unapproved then resubmitted, resubmitted after edits). Postgres
-- evaluates the UPDATE policy on that branch, and the only existing one
-- ("variation_feedback update") is authenticated-only, so the resubmit failed
-- with "new row violates row-level security policy". First submissions were
-- unaffected, which is why this only showed up on repeat submits.
--
-- Same share-token scoping as the insert/select policies for the anon role.
create policy "variation_feedback update (anon, share token)" on "public"."variation_feedback"
  for update to "anon"
  using (public.has_matching_share_token(project_id))
  with check (public.has_matching_share_token(project_id));
