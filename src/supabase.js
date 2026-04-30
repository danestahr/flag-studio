import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function uploadLogo(orderId, file) {
  const ext = file.name.split('.').pop();
  const path = `${orderId}/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('flag-logos')
    .upload(path, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { data: { publicUrl } } = supabase.storage
    .from('flag-logos')
    .getPublicUrl(path);

  const { data, error } = await supabase
    .from('flag_logos')
    .insert({ order_id: orderId, name: file.name.replace(/\.[^.]+$/, ''), storage_path: path, public_url: publicUrl })
    .select('id, name, storage_path, public_url')
    .single();
  if (error) throw error;

  return { id: data.id, name: data.name, src: publicUrl, storagePath: path };
}

export async function loadLogosForOrder(orderId) {
  const { data, error } = await supabase
    .from('flag_logos')
    .select('id, name, public_url')
    .eq('order_id', orderId);
  if (error) throw error;
  return data.map(l => ({ id: l.id, name: l.name, src: l.public_url }));
}

export async function deleteLogo(storagePath, logoId) {
  await supabase.storage.from('flag-logos').remove([storagePath]);
  await supabase.from('flag_logos').delete().eq('id', logoId);
}

export async function saveDraft(state) {
  const payload = {
    flag_id: state.flagId,
    colors: state.colors,
    variations: state.variations,
    event_name: state.eventName || null,
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

export async function listDrafts() {
  const { data, error } = await supabase
    .from('flag_orders')
    .select('id, event_name, flag_id, updated_at, status')
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return data;
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
