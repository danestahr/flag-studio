-- Anonymous, share-token-gated quantity change for a single variation.
-- Customers on review.html can't write flag_config/hole_sign_config directly
-- (RLS), so this SECURITY DEFINER RPC patches just variations[].qty — and
-- only while the proof is out for review (status = 'proof_sent').
create or replace function public.client_set_variation_qty(
  target_project_id uuid,
  target_product_type text,
  target_variation_id text,
  new_qty integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
  current_variations jsonb;
  updated_variations jsonb;
  items jsonb;
begin
  if not public.has_matching_share_token(target_project_id) then
    raise exception 'invalid or missing share token';
  end if;

  if new_qty is null or new_qty < 1 or new_qty > 100000 then
    raise exception 'invalid quantity %', new_qty;
  end if;

  if target_product_type = 'flags' then
    select status, variations into current_status, current_variations
      from public.flag_config where project_id = target_project_id for update;
  elsif target_product_type = 'hole-signs' then
    select status, variations into current_status, current_variations
      from public.hole_sign_config where project_id = target_project_id for update;
  else
    raise exception 'invalid product_type %', target_product_type;
  end if;

  if current_status is null then
    raise exception 'no % design found for project %', target_product_type, target_project_id;
  end if;

  if current_status <> 'proof_sent' then
    raise exception 'cannot change quantity of % design in status %', target_product_type, current_status;
  end if;

  -- variations is either a bare array (legacy) or an object with the list
  -- under "items" (layout/textLayers/etc. live alongside it).
  if jsonb_typeof(current_variations) = 'array' then
    items := current_variations;
  else
    items := coalesce(current_variations->'items', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(
           case when elem->>'id' = target_variation_id
                then jsonb_set(elem, '{qty}', to_jsonb(new_qty))
                else elem end
           order by ord), '[]'::jsonb)
    into items
    from jsonb_array_elements(items) with ordinality as t(elem, ord);

  if jsonb_typeof(current_variations) = 'array' then
    updated_variations := items;
  else
    updated_variations := jsonb_set(current_variations, '{items}', items);
  end if;

  if updated_variations = current_variations then
    return;
  end if;

  if target_product_type = 'flags' then
    update public.flag_config set variations = updated_variations, updated_at = now()
      where project_id = target_project_id;
  else
    update public.hole_sign_config set variations = updated_variations, updated_at = now()
      where project_id = target_project_id;
  end if;

  insert into public.admin_actions (admin_id, admin_email, project_id, product_type, action, note)
  values (null, null, target_project_id, target_product_type, 'client_set_qty',
          target_variation_id || ' -> ' || new_qty);
end;
$$;

revoke all on function public.client_set_variation_qty(uuid, text, text, integer) from public;
grant execute on function public.client_set_variation_qty(uuid, text, text, integer) to anon, authenticated;
