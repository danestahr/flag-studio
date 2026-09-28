-- Captures who approved a design, at the design level, so project.html, the
-- review page, and the flags order-summary PDF can all display it without
-- reaching into variation_feedback (per-variation, not per-design, and its
-- created_at doesn't advance on a resubmit - see review.js's reviewer name/
-- email fields, which are the closest thing that existed before this).
--
-- client_approve_design_proof didn't accept a reviewer identity at all -
-- it's dropped and recreated (rather than CREATE OR REPLACE, which would
-- leave the old 2-arg signature as a second overload) with two new
-- parameters that get stamped onto flag_config/hole_sign_config at the same
-- moment the status flips to 'approved'.

alter table public.flag_config
  add column if not exists approved_by_name text,
  add column if not exists approved_by_email text,
  add column if not exists approved_at timestamptz;

alter table public.hole_sign_config
  add column if not exists approved_by_name text,
  add column if not exists approved_by_email text,
  add column if not exists approved_at timestamptz;

drop function if exists public.client_approve_design_proof(uuid, text);

create function public.client_approve_design_proof(
  target_project_id uuid,
  target_product_type text,
  reviewer_name text default null,
  reviewer_email text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
begin
  if not public.has_matching_share_token(target_project_id) then
    raise exception 'invalid or missing share token';
  end if;

  if target_product_type = 'flags' then
    select status into current_status from public.flag_config where project_id = target_project_id for update;
  elsif target_product_type = 'hole-signs' then
    select status into current_status from public.hole_sign_config where project_id = target_project_id for update;
  else
    raise exception 'invalid product_type %', target_product_type;
  end if;

  if current_status is null then
    raise exception 'no % design found for project %', target_product_type, target_project_id;
  end if;

  if current_status <> 'proof_sent' then
    raise exception 'cannot approve % design from status %', target_product_type, current_status;
  end if;

  perform set_config('app.allow_design_status_change', 'true', true);

  if target_product_type = 'flags' then
    update public.flag_config
      set status = 'approved',
          approved_by_name = reviewer_name,
          approved_by_email = reviewer_email,
          approved_at = now(),
          updated_at = now()
      where project_id = target_project_id;
  else
    update public.hole_sign_config
      set status = 'approved',
          approved_by_name = reviewer_name,
          approved_by_email = reviewer_email,
          approved_at = now(),
          updated_at = now()
      where project_id = target_project_id;
  end if;

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (
    null, null, target_project_id, target_product_type, 'client_approve_proof',
    case
      when reviewer_name is not null or reviewer_email is not null then
        trim(concat_ws(' ', reviewer_name, case when reviewer_email is not null then '(' || reviewer_email || ')' end))
      else null
    end
  );
end;
$$;

revoke all on function public.client_approve_design_proof(uuid, text, text, text) from public;
grant execute on function public.client_approve_design_proof(uuid, text, text, text) to anon, authenticated;
