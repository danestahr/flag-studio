-- The order form's optional GolfStatus event-sync step captures the event
-- URL the customer pasted in, but it was only ever held in client memory
-- (O.syncUrl) and never persisted - staff reviewing a submitted order had no
-- way to see which event site the design was pulled from. Nullable since a
-- customer who skips the sync step ("Fill Out Form Manually") never has one.

alter table "public"."order_intakes"
  add column if not exists "event_source_url" "text";
