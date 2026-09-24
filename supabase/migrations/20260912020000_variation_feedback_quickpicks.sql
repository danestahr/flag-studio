-- Adds optional structured "quick-pick" fields to a customer's edit request,
-- alongside the existing freeform `note`. Populated from review.html's
-- Request Edits quick-picks (flag style / template, colors, replacement
-- logo) and consumed by the designer's one-click "Apply" actions
-- (src/flags/variations.js, src/hs/export.js). All nullable: a customer may
-- use none, some, or all of them, same as `note` is already optional.
--
-- One shared column set for both product_type values ('flags' and
-- 'hole-signs'), same as `note`/`status` already do double duty -
-- `product_type` on the row disambiguates which fields apply:
--   requested_flag_id      - flags only, a FLAGS[].id (src/data.js)
--   requested_template_id  - hole-signs only, 'default:<id>' - same key
--                             shape src/hs/variations.js's setVarTemplate
--                             already parses
--   requested_colors       - flags: {[zoneId]: hex}; hole-signs:
--                             {background?, topText?, bottomText?} hex map
--   requested_logo_url/
--   requested_logo_path    - storage path/public URL in the flag-logos
--                             bucket (see uploadFeedbackLogo, src/supabase.js)
--
-- No RLS changes needed: the existing "variation_feedback insert"/"select"
-- policies (20260818000000_share_token_value_check.sql) key only on
-- has_matching_share_token(project_id), not specific columns.

alter table "public"."variation_feedback"
  add column "requested_flag_id" text,
  add column "requested_template_id" text,
  add column "requested_colors" jsonb,
  add column "requested_logo_url" text,
  add column "requested_logo_path" text;
