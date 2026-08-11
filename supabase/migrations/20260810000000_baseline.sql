


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."claim_my_projects"() RETURNS SETOF "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  my_email text;
begin
  my_email := auth.email();
  if my_email is null then
    raise exception 'not authenticated';
  end if;

  return query
  update public.projects p
  set created_by = auth.uid()
  from public.order_intakes oi
  where oi.project_id = p.id
    and p.created_by is null
    and lower(oi.contact_email) = lower(my_email)
  returning p.id;
end;
$$;


ALTER FUNCTION "public"."claim_my_projects"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."grant_role"("target_user_id" "uuid", "new_role" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  caller_role text;
  caller_email text;
  target_email text;
  prior_role text;
begin
  select role, email into caller_role, caller_email
  from public.profiles where id = auth.uid();

  if caller_role is distinct from 'admin' then
    raise exception 'only admins can grant roles';
  end if;

  if new_role not in ('customer', 'staff', 'admin') then
    raise exception 'invalid role: %', new_role;
  end if;

  select role, email into prior_role, target_email
  from public.profiles where id = target_user_id;

  if prior_role is null then
    raise exception 'target user not found';
  end if;

  insert into public.role_grants
    (granted_by, granted_by_email, target_user_id, target_email, old_role, new_role)
  values
    (auth.uid(), caller_email, target_user_id, target_email, prior_role, new_role);

  perform set_config('app.allow_role_change', 'true', true);
  update public.profiles set role = new_role, updated_at = now() where id = target_user_id;
end;
$$;


ALTER FUNCTION "public"."grant_role"("target_user_id" "uuid", "new_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, email, first_name, last_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'last_name'
  )
  on conflict (id) do update set
    email = excluded.email,
    first_name = coalesce(excluded.first_name, public.profiles.first_name),
    last_name = coalesce(excluded.last_name, public.profiles.last_name),
    updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_role_self_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.role is distinct from old.role
     and coalesce(current_setting('app.allow_role_change', true), 'false') <> 'true' then
    raise exception 'role cannot be changed directly; use grant_role()';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."prevent_role_self_update"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."admin_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "admin_id" "uuid",
    "admin_email" "text",
    "project_id" "uuid",
    "action" "text" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."flag_config" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "flag_id" "text",
    "colors" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "base_assignment" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "variations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "same_logo_on_both_sides" boolean DEFAULT true NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."flag_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hole_sign_config" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "template_style" "text",
    "colors" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "variations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "one_offs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."hole_sign_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_intakes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "event_name" "text" NOT NULL,
    "event_date" "date" NOT NULL,
    "contact_name" "text" NOT NULL,
    "contact_email" "text" NOT NULL,
    "address_line1" "text" NOT NULL,
    "address_line2" "text",
    "city" "text" NOT NULL,
    "state_province" "text" NOT NULL,
    "postal_code" "text" NOT NULL,
    "country" "text" DEFAULT 'US'::"text" NOT NULL,
    "flag_style" "text",
    "flag_colors" "jsonb" DEFAULT '[]'::"jsonb",
    "flag_setup" "text" DEFAULT 'same'::"text" NOT NULL,
    "design_notes" "text",
    "ack_deadline" boolean DEFAULT false NOT NULL,
    "ack_pricing" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "flag_qty" integer,
    "course_name" "text",
    "attn" "text"
);


ALTER TABLE "public"."order_intakes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "role" "text" DEFAULT 'customer'::"text" NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['customer'::"text", 'staff'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_logos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "public_url" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_logos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "share_token" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_info" "jsonb",
    "created_by" "uuid" DEFAULT "auth"."uid"()
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_grants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "granted_by" "uuid",
    "granted_by_email" "text",
    "target_user_id" "uuid",
    "target_email" "text",
    "old_role" "text",
    "new_role" "text" NOT NULL,
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."role_grants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."variation_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "product_type" "text" DEFAULT 'flags'::"text" NOT NULL,
    "variation_id" "text" NOT NULL,
    "status" "text",
    "note" "text",
    "resolved" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewer_name" "text"
);


ALTER TABLE "public"."variation_feedback" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_actions"
    ADD CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."flag_config"
    ADD CONSTRAINT "flag_config_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."flag_config"
    ADD CONSTRAINT "flag_config_project_id_key" UNIQUE ("project_id");



ALTER TABLE ONLY "public"."hole_sign_config"
    ADD CONSTRAINT "hole_sign_config_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hole_sign_config"
    ADD CONSTRAINT "hole_sign_config_project_id_key" UNIQUE ("project_id");



ALTER TABLE ONLY "public"."order_intakes"
    ADD CONSTRAINT "order_intakes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_logos"
    ADD CONSTRAINT "project_logos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_share_token_key" UNIQUE ("share_token");



ALTER TABLE ONLY "public"."role_grants"
    ADD CONSTRAINT "role_grants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."variation_feedback"
    ADD CONSTRAINT "variation_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."variation_feedback"
    ADD CONSTRAINT "variation_feedback_project_id_product_type_variation_id_key" UNIQUE ("project_id", "product_type", "variation_id");



CREATE OR REPLACE TRIGGER "prevent_role_self_update" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_role_self_update"();



ALTER TABLE ONLY "public"."admin_actions"
    ADD CONSTRAINT "admin_actions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."admin_actions"
    ADD CONSTRAINT "admin_actions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."flag_config"
    ADD CONSTRAINT "flag_config_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hole_sign_config"
    ADD CONSTRAINT "hole_sign_config_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_intakes"
    ADD CONSTRAINT "order_intakes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_logos"
    ADD CONSTRAINT "project_logos_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."role_grants"
    ADD CONSTRAINT "role_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."role_grants"
    ADD CONSTRAINT "role_grants_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."variation_feedback"
    ADD CONSTRAINT "variation_feedback_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;



ALTER TABLE "public"."admin_actions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "anon delete flag_config" ON "public"."flag_config" FOR DELETE TO "authenticated", "anon" USING (true);



CREATE POLICY "anon delete hole_sign_config" ON "public"."hole_sign_config" FOR DELETE TO "authenticated", "anon" USING (true);



CREATE POLICY "anon delete order_intakes" ON "public"."order_intakes" FOR DELETE TO "authenticated", "anon" USING (true);



CREATE POLICY "anon delete project_logos" ON "public"."project_logos" FOR DELETE TO "authenticated", "anon" USING (true);



CREATE POLICY "anon delete projects" ON "public"."projects" FOR DELETE TO "authenticated", "anon" USING (true);



CREATE POLICY "anon delete variation_feedback" ON "public"."variation_feedback" FOR DELETE TO "authenticated", "anon" USING (true);



CREATE POLICY "anon insert" ON "public"."order_intakes" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "anon insert flag_config" ON "public"."flag_config" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "anon insert hole_sign_config" ON "public"."hole_sign_config" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "anon insert project_logos" ON "public"."project_logos" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "anon insert projects" ON "public"."projects" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "anon insert variation_feedback" ON "public"."variation_feedback" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



CREATE POLICY "anon select" ON "public"."order_intakes" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon select flag_config" ON "public"."flag_config" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon select hole_sign_config" ON "public"."hole_sign_config" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon select order_intakes" ON "public"."order_intakes" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon select project_logos" ON "public"."project_logos" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon select projects" ON "public"."projects" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon select variation_feedback" ON "public"."variation_feedback" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "anon update flag_config" ON "public"."flag_config" FOR UPDATE TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon update hole_sign_config" ON "public"."hole_sign_config" FOR UPDATE TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon update projects" ON "public"."projects" FOR UPDATE TO "authenticated", "anon" USING (true) WITH CHECK (true);



CREATE POLICY "anon update variation_feedback" ON "public"."variation_feedback" FOR UPDATE TO "authenticated", "anon" USING (true);



ALTER TABLE "public"."flag_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hole_sign_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."order_intakes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles select all" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "profiles update own" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "id"));



ALTER TABLE "public"."project_logos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_grants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "staff and admin can log their own admin_actions" ON "public"."admin_actions" FOR INSERT TO "authenticated" WITH CHECK ((("admin_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['staff'::"text", 'admin'::"text"])))))));



CREATE POLICY "staff and admin can read admin_actions" ON "public"."admin_actions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['staff'::"text", 'admin'::"text"]))))));



CREATE POLICY "staff and admin can read role_grants" ON "public"."role_grants" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['staff'::"text", 'admin'::"text"]))))));



ALTER TABLE "public"."variation_feedback" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_my_projects"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_my_projects"() TO "anon";
GRANT ALL ON FUNCTION "public"."claim_my_projects"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_my_projects"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."grant_role"("target_user_id" "uuid", "new_role" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."grant_role"("target_user_id" "uuid", "new_role" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."grant_role"("target_user_id" "uuid", "new_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."grant_role"("target_user_id" "uuid", "new_role" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_role_self_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_role_self_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_role_self_update"() TO "service_role";



GRANT ALL ON TABLE "public"."admin_actions" TO "anon";
GRANT ALL ON TABLE "public"."admin_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_actions" TO "service_role";



GRANT ALL ON TABLE "public"."flag_config" TO "anon";
GRANT ALL ON TABLE "public"."flag_config" TO "authenticated";
GRANT ALL ON TABLE "public"."flag_config" TO "service_role";



GRANT ALL ON TABLE "public"."hole_sign_config" TO "anon";
GRANT ALL ON TABLE "public"."hole_sign_config" TO "authenticated";
GRANT ALL ON TABLE "public"."hole_sign_config" TO "service_role";



GRANT ALL ON TABLE "public"."order_intakes" TO "anon";
GRANT ALL ON TABLE "public"."order_intakes" TO "authenticated";
GRANT ALL ON TABLE "public"."order_intakes" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."project_logos" TO "anon";
GRANT ALL ON TABLE "public"."project_logos" TO "authenticated";
GRANT ALL ON TABLE "public"."project_logos" TO "service_role";



GRANT ALL ON TABLE "public"."projects" TO "anon";
GRANT ALL ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT ALL ON TABLE "public"."role_grants" TO "anon";
GRANT ALL ON TABLE "public"."role_grants" TO "authenticated";
GRANT ALL ON TABLE "public"."role_grants" TO "service_role";



GRANT ALL ON TABLE "public"."variation_feedback" TO "anon";
GRANT ALL ON TABLE "public"."variation_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."variation_feedback" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







