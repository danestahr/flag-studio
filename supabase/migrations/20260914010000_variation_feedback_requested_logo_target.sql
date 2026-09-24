-- review.html's "Request edits" quick-picks now show every logo actually
-- placed on the variation (flags: front/back zones; hole signs: template
-- logo slots) with its own "Replace logo" button, instead of one generic
-- upload box with no way to say which existing logo it's meant to replace.
-- This column records which one the customer targeted (an opaque id local
-- to review.js - 'pl-<ts>'/'back-pl-<ts>' for a flag zone placement id,
-- 'slot-<i>' for a hole-sign template-logo slot index) alongside the
-- existing requested_logo_url/path.
--
-- Still only one pending replacement per variation_feedback row, matching
-- requested_logo_url/path already being singular rather than an array -
-- picking a different logo's "Replace" button just moves which one this
-- points at, same as requestedColors/requestedFlagId already being
-- overwritten wholesale on each edit.
--
-- Dormant scaffolding for now, same pattern as projects.status/admin_actions
-- before their consuming feature landed (see CLAUDE.md) - nothing on the
-- staff side (edit-requests-panel.js, flags/variations.js's
-- renderLogoSwapPicker, hs/variations.js) reads this yet. Until it does,
-- staff still get asked "which logo?" via the existing picker when a
-- variation has more than one placed logo, same as before this column
-- existed.

alter table "public"."variation_feedback"
  add column "requested_logo_target_id" text;
