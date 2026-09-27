-- review.html's "Request edits" quick-picks previously tracked only ONE
-- pending logo replacement per variation_feedback row (requested_logo_url/
-- path/target_id, all singular - see 20260912020000 and 20260914010000's
-- comments), even though a variation can have several logo placements
-- (front + back zones, multiple template-logo slots). Picking "Replace" on
-- a second logo silently discarded the first pending choice. This replaces
-- those three singular columns with one jsonb array, `requested_logos`, so
-- a customer can queue up as many replacements/additions as they want
-- before submitting:
--   requested_logos - array of { target_id, url, path }, in the shape
--     src/review.js's buildFeedbackRow now writes: target_id is the same
--     opaque id requested_logo_target_id used to carry (a flag zone
--     placement id, 'back-<id>' for a back-face placement, 'slot-<i>' for a
--     hole-sign template-logo slot), or null for an "Add a logo" entry not
--     tied to replacing anything. url/path mirror the old
--     requested_logo_url/requested_logo_path columns, one pair per entry.
--
-- Existing rows with a pending single logo request are backfilled into a
-- one-element array so an edit request submitted before this migration
-- still shows up for staff to apply after it.

alter table "public"."variation_feedback"
  add column "requested_logos" jsonb;

update "public"."variation_feedback"
  set requested_logos = jsonb_build_array(
    jsonb_build_object(
      'target_id', requested_logo_target_id,
      'url', requested_logo_url,
      'path', requested_logo_path
    )
  )
  where requested_logo_url is not null;

alter table "public"."variation_feedback"
  drop column "requested_logo_url",
  drop column "requested_logo_path",
  drop column "requested_logo_target_id";
