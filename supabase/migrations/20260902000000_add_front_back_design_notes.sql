-- Front/back design notes: when a customer picks "Different front & back"
-- flag setup on the order form, the single general design_notes field isn't
-- enough to describe two distinct designs - the form now collects a
-- required note for each side in that case. Both columns stay nullable at
-- the DB layer (same as design_notes) since they only apply, and are only
-- required client-side, when flag_setup = 'different'.

alter table "public"."order_intakes"
  add column if not exists "front_design_notes" "text",
  add column if not exists "back_design_notes" "text";
