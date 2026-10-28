-- SHA-256 of the saved flag design (flag_id, colors, variations,
-- same_logo_on_both_sides) at the moment a Prestige zip was built. The project
-- page compares it with the current design's hash to tell "the design actually
-- changed since these files were generated" apart from status-only saves.
-- Null on orders built before this column existed (staleness unknown).
alter table public.prestige_orders add column design_hash text;
