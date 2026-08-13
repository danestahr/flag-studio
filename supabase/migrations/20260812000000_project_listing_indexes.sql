-- Workstream B: indexes backing listProjects()'s new keyset pagination and
-- the FK join columns that are queried directly today with no index.
--
-- Not included here because they already have a covering index via an
-- existing unique constraint (confirmed in the baseline dump):
--   projects.share_token, flag_config.project_id, hole_sign_config.project_id,
--   variation_feedback(project_id, product_type, variation_id) (covers
--   project_id-only lookups as its leading column).

create index if not exists "projects_updated_at_id_idx"
  on "public"."projects" ("updated_at" desc, "id" desc);

create index if not exists "projects_created_by_updated_at_id_idx"
  on "public"."projects" ("created_by", "updated_at" desc, "id" desc);

create index if not exists "project_logos_project_id_idx"
  on "public"."project_logos" ("project_id");

create index if not exists "order_intakes_project_id_idx"
  on "public"."order_intakes" ("project_id");
