-- Removing the cross-project "shared logo library" (user_logos, merged into
-- S.library/HS.library via mergeLibraries() — see flags/design.js,
-- flags/variations.js, hs/app.js, hs/variations.js) in favor of every logo
-- living only in project_logos, scoped to one project. A placed logo doesn't
-- store its own image data — a variation only stores a bare `logoId` that
-- gets resolved against the *live* library at render/export time
-- (render.js's findLogo(), hs/app.js's HS.library.find()) — so before the
-- app stops reading user_logos at all, any user_logos row still referenced
-- by a project's flag_config/hole_sign_config JSONB has to land in that
-- project's own project_logos, or the placed logo silently disappears next
-- render.
--
-- A user_logos row referenced by exactly one project can be copied in under
-- its *same* id — nothing in that project's JSONB needs to change. A row
-- referenced by more than one project (the actual cross-project reuse case)
-- needs a distinct project_logos row per project, so each project gets a
-- fresh id and every occurrence of the old id in that project's JSONB is
-- rewritten to match.
--
-- A user_logos row referenced by *no* project (uploaded into the shared
-- library but never actually placed on a variation) is intentionally left
-- alone here — it just stops showing up in any Logo Library panel once the
-- merge is removed, which is the whole point of this change.
do $$
declare
  ul record;
  proj record;
  ref_count integer;
  new_id uuid;
begin
  for ul in select * from public.user_logos loop
    select count(distinct project_id) into ref_count
    from (
      select fc.project_id
      from public.flag_config fc
      where (fc.variations::text like '%' || ul.id::text || '%')
         or (fc.base_assignment::text like '%' || ul.id::text || '%')
      union
      select hsc.project_id
      from public.hole_sign_config hsc
      where (hsc.variations::text like '%' || ul.id::text || '%')
         or (hsc.one_offs::text like '%' || ul.id::text || '%')
    ) refs;

    if ref_count = 0 then
      continue;
    elsif ref_count = 1 then
      insert into public.project_logos (id, project_id, name, storage_path, public_url, created_at)
      select ul.id, refs.project_id, ul.name, ul.storage_path, ul.public_url, ul.created_at
      from (
        select fc.project_id
        from public.flag_config fc
        where (fc.variations::text like '%' || ul.id::text || '%')
           or (fc.base_assignment::text like '%' || ul.id::text || '%')
        union
        select hsc.project_id
        from public.hole_sign_config hsc
        where (hsc.variations::text like '%' || ul.id::text || '%')
           or (hsc.one_offs::text like '%' || ul.id::text || '%')
      ) refs
      on conflict (id) do nothing;
    else
      for proj in
        select fc.project_id
        from public.flag_config fc
        where (fc.variations::text like '%' || ul.id::text || '%')
           or (fc.base_assignment::text like '%' || ul.id::text || '%')
        union
        select hsc.project_id
        from public.hole_sign_config hsc
        where (hsc.variations::text like '%' || ul.id::text || '%')
           or (hsc.one_offs::text like '%' || ul.id::text || '%')
      loop
        -- Idempotency guard in case this migration is ever re-run by hand:
        -- skip a project that's already been backfilled for this exact
        -- shared logo (same storage_path, since the id itself changes).
        if exists (
          select 1 from public.project_logos
          where project_id = proj.project_id and storage_path = ul.storage_path
        ) then
          continue;
        end if;

        new_id := gen_random_uuid();

        insert into public.project_logos (id, project_id, name, storage_path, public_url, created_at)
        values (new_id, proj.project_id, ul.name, ul.storage_path, ul.public_url, ul.created_at);

        update public.flag_config
        set variations = replace(variations::text, ul.id::text, new_id::text)::jsonb,
            base_assignment = replace(base_assignment::text, ul.id::text, new_id::text)::jsonb
        where project_id = proj.project_id
          and (variations::text like '%' || ul.id::text || '%'
               or base_assignment::text like '%' || ul.id::text || '%');

        update public.hole_sign_config
        set variations = replace(variations::text, ul.id::text, new_id::text)::jsonb,
            one_offs = replace(one_offs::text, ul.id::text, new_id::text)::jsonb
        where project_id = proj.project_id
          and (variations::text like '%' || ul.id::text || '%'
               or one_offs::text like '%' || ul.id::text || '%');
      end loop;
    end if;
  end loop;
end $$;
