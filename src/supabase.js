import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function saveDraft(state) {
  const payload = {
    flag_id: state.flagId,
    colors: state.colors,
    variations: state.variations,
    status: 'draft',
  };

  if (state.orderId) {
    const { data, error } = await supabase
      .from('flag_orders')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', state.orderId)
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  } else {
    const { data, error } = await supabase
      .from('flag_orders')
      .insert(payload)
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }
}

export async function loadOrder(orderId) {
  const { data, error } = await supabase
    .from('flag_orders')
    .select('*')
    .eq('id', orderId)
    .single();
  if (error) throw error;
  return data;
}
