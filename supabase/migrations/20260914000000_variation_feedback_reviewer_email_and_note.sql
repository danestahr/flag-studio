-- review.html now requires a reviewer email (alongside the existing
-- reviewer name) and offers one freeform "general notes" box per
-- submission, separate from each variation's own per-card note. Both are
-- denormalized onto every row of a submission exactly like `reviewer_name`
-- already is - there's no project-wide row shape in this table (the unique
-- key is project_id/product_type/variation_id), so "one value shared by a
-- batch of variation rows" is the existing pattern, not a new one. No RLS
-- changes needed: the existing anon insert/select policies key off
-- has_matching_share_token(project_id), not specific columns (same
-- reasoning as the quickpicks columns added in
-- 20260912020000_variation_feedback_quickpicks.sql).

alter table "public"."variation_feedback"
  add column "reviewer_email" text,
  add column "general_note" text;
