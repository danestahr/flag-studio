-- Recovered from the remote migration history table (supabase_migrations.schema_migrations) —
-- this was applied directly against the live database on 2026-07-13, outside of any
-- committed migration file, and is added here now so local history matches remote
-- truth. Content is the exact statement recorded remotely, not a guess.
--
-- Guarded because of a replay-ordering quirk: this migration's real remote
-- timestamp (2026-07-13) predates the schema baseline snapshot's timestamp
-- (2026-08-10), even though these tables obviously already existed well
-- before 07-13 — the baseline is a snapshot, not real history, so a
-- from-scratch local replay hits this before the baseline creates the
-- tables. Skips harmlessly on a fresh local db; re-run
-- `select public.ensure_realtime_publication();` after `supabase db reset`
-- if you need Realtime working locally.
create or replace function "public"."ensure_realtime_publication"()
returns void
language plpgsql
as $$
begin
  if to_regclass('public.flag_config') is not null
     and to_regclass('public.hole_sign_config') is not null
     and to_regclass('public.variation_feedback') is not null then
    begin
      alter publication supabase_realtime add table flag_config, hole_sign_config, variation_feedback;
    exception when duplicate_object then
      null; -- already a member, nothing to do
    end;
  end if;
end;
$$;

select "public"."ensure_realtime_publication"();
