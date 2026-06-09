import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Auth ──────────────────────────────────────────────────
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

// ── Projects ──────────────────────────────────────────────
export async function createProject(name = '') {
  const { data, error } = await supabase
    .from('projects')
    .insert({ name: name || null })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateProject(projectId, fields) {
  const { error } = await supabase
    .from('projects')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', projectId);
  if (error) throw error;
}

export async function listProjects() {
  const { data, error } = await supabase
    .from('projects')
    .select(`id, name, status, updated_at, flag_config(id, flag_id), hole_sign_config(id, template_style)`)
    .order('updated_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

export async function loadProject(projectId) {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (error) throw error;
  return data;
}

export async function deleteProject(projectId) {
  const { data: logos, error: logoListErr } = await supabase
    .from('project_logos')
    .select('storage_path')
    .eq('project_id', projectId);
  if (logoListErr) throw logoListErr;

  if (logos?.length) {
    const { error: storageErr } = await supabase.storage
      .from('flag-logos')
      .remove(logos.map(l => l.storage_path));
    if (storageErr) throw storageErr;
  }

  for (const table of ['variation_feedback', 'order_intakes', 'flag_config', 'hole_sign_config', 'project_logos']) {
    const { error } = await supabase.from(table).delete().eq('project_id', projectId);
    if (error) throw error;
  }

  const { error } = await supabase.from('projects').delete().eq('id', projectId);
  if (error) throw error;
}

// ── Logos ──────────────────────────────────────────────────
export async function uploadLogo(projectId, file) {
  const ext = file.name.split('.').pop();
  const path = `${projectId}/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('flag-logos')
    .upload(path, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { data: { publicUrl } } = supabase.storage
    .from('flag-logos')
    .getPublicUrl(path);

  const { data, error } = await supabase
    .from('project_logos')
    .insert({ project_id: projectId, name: file.name.replace(/\.[^.]+$/, ''), storage_path: path, public_url: publicUrl })
    .select('id, name, storage_path, public_url')
    .single();
  if (error) throw error;

  return { id: data.id, name: data.name, src: publicUrl, storagePath: path };
}

export async function loadLogosForProject(projectId) {
  const { data, error } = await supabase
    .from('project_logos')
    .select('id, name, public_url, storage_path')
    .eq('project_id', projectId);
  if (error) throw error;
  return data.map(l => ({ id: l.id, name: l.name, src: l.public_url, storagePath: l.storage_path }));
}

export async function deleteLogo(storagePath, logoId) {
  await supabase.storage.from('flag-logos').remove([storagePath]);
  await supabase.from('project_logos').delete().eq('id', logoId);
}

// ── Flag config ────────────────────────────────────────────
export async function saveFlagConfig(projectId, state) {
  const { error } = await supabase
    .from('flag_config')
    .upsert({
      project_id: projectId,
      flag_id: state.flagId,
      colors: state.colors,
      base_assignment: state.baseAssignment,
      variations: { layout: state.logoLayout || 'single', items: state.variations },
      same_logo_on_both_sides: state.sameLogoOnBothSides,
      status: 'draft',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id' });
  if (error) throw error;
  await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId);
}

export async function loadFlagConfig(projectId) {
  const { data, error } = await supabase
    .from('flag_config')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ── Hole sign config ───────────────────────────────────────
export async function saveHoleSignConfig(projectId, state) {
  const { error } = await supabase
    .from('hole_sign_config')
    .upsert({
      project_id: projectId,
      template_style: state.templateStyle,
      colors: state.colors,
      variations: state.variations,
      one_offs: state.oneOffs || [],
      status: 'draft',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id' });
  if (error) throw error;
  await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId);
}

export async function loadHoleSignConfig(projectId) {
  const { data, error } = await supabase
    .from('hole_sign_config')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ── Share & review ─────────────────────────────────────────
export async function generateShareToken(projectId) {
  const token = crypto.randomUUID();
  const { error } = await supabase
    .from('projects')
    .update({ share_token: token })
    .eq('id', projectId);
  if (error) throw error;
  return token;
}

export async function getProjectByToken(token) {
  const { data: project, error } = await supabase
    .from('projects')
    .select('*')
    .eq('share_token', token)
    .single();
  if (error) throw error;

  const [{ data: flagCfg }, { data: holeCfg }] = await Promise.all([
    supabase.from('flag_config').select('*').eq('project_id', project.id).maybeSingle(),
    supabase.from('hole_sign_config').select('*').eq('project_id', project.id).maybeSingle(),
  ]);

  return { ...project, flagConfig: flagCfg || null, holeSignConfig: holeCfg || null };
}

// ── Order intake ──────────────────────────────────────────
export async function loadOrderIntake(projectId) {
  const { data, error } = await supabase
    .from('order_intakes')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ── Feedback ───────────────────────────────────────────────
export async function submitFeedback(projectId, productType, feedbackItems) {
  const { error } = await supabase
    .from('variation_feedback')
    .upsert(
      feedbackItems.map(f => ({ project_id: projectId, product_type: productType, resolved: false, ...f })),
      { onConflict: 'project_id,product_type,variation_id' }
    );
  if (error) throw error;
}

export async function resolveFeedback(projectId, productType, variationId = null) {
  let q = supabase
    .from('variation_feedback')
    .update({ resolved: true })
    .eq('project_id', projectId)
    .eq('product_type', productType)
    .eq('status', 'needs_edits');
  if (variationId) q = q.eq('variation_id', variationId);
  const { error } = await q;
  if (error) throw error;
}

export async function getFeedback(projectId, productType = 'flags') {
  const { data, error } = await supabase
    .from('variation_feedback')
    .select('*')
    .eq('project_id', projectId)
    .eq('product_type', productType);
  if (error) throw error;
  return data || [];
}

// ── Edge functions ─────────────────────────────────────────
async function callEdgeFunction(name, body) {
  const url = `${SUPABASE_URL}/functions/v1/${name}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge function ${name} failed: ${text}`);
  }
  return res.json();
}

export async function sendOrderConfirmation(payload) {
  return callEdgeFunction('send-order-confirmation', payload);
}

export async function sendProofReady(payload) {
  return callEdgeFunction('send-proof-ready', payload);
}
