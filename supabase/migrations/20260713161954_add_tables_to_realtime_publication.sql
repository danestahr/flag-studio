-- Recovered from the remote migration history table (supabase_migrations.schema_migrations) —
-- this was applied directly against the live database on 2026-07-13, outside of any
-- committed migration file, and is added here now so local history matches remote
-- truth. Content is the exact statement recorded remotely, not a guess.
alter publication supabase_realtime add table flag_config, hole_sign_config, variation_feedback;
