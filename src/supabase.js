import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// review.html's anon reviewer flow needs its own client: the "projects
// select" / "project_logos select" / "variation_feedback select+insert" RLS
// policies check this header against the row's real share_token (see
// supabase/migrations/20260818000000_share_token_value_check.sql) rather
// than just trusting any share-token-bearing request, so every review-page
// call must carry it.
export function createReviewClient(token) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { 'x-share-token': token } },
  });
}

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

// first_name/last_name land in raw_user_meta_data immediately at signup (even
// before email confirmation), and the handle_new_user trigger copies them into
// profiles from there — see supabase/migrations for the trigger definition.
export async function signUp(email, password, { firstName, lastName } = {}) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { first_name: firstName, last_name: lastName } },
  });
  if (error) throw error;
  return data;
}

export async function resetPasswordForEmail(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password.html`,
  });
  if (error) throw error;
}

// Revokes every other active session on success, so a password reset actually
// invalidates a potentially-compromised existing session rather than leaving
// it live alongside the new password.
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
  await supabase.auth.signOut({ scope: 'others' });
}

// Attaches ownership of any project whose order was submitted anonymously
// under this account's own (confirmed) email — see claim_my_projects() in
// supabase/migrations. No-op, returns [] if nothing matches.
export async function claimMyProjects() {
  const { data, error } = await supabase.rpc('claim_my_projects');
  if (error) throw error;
  return data || [];
}

// ── Profile ───────────────────────────────────────────────
export async function getMyProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateMyProfile(userId, { firstName, lastName }) {
  const { error } = await supabase
    .from('profiles')
    .update({ first_name: firstName || null, last_name: lastName || null, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) throw error;
}

// Supabase emails the new address a confirmation link before the change
// actually takes effect — auth.users.email (and profiles.email, kept in sync
// by trigger) stay on the old address until that link is clicked.
export async function updateMyEmail(newEmail) {
  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) throw error;
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

export async function getMyRole(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data.role;
}

// Keyset pagination on (updated_at, id) rather than offset - offset pagination
// is unstable once projects are edited between page loads, since every save
// bumps updated_at. Pass back the cursor from the previous page's last row to
// get the next one; a null nextCursor means there's nothing more to load.
//
// Customers are explicitly scoped to their own rows here rather than relying
// solely on the "projects select" RLS policy - that policy's anon/review.html
// branch (`share_token is not null`) is intentionally broad enough that an
// unscoped select as an authenticated customer would also return every other
// customer's ever-shared project. Staff/admin stay unscoped (RLS already
// grants them everything via is_staff_or_admin()).
export async function listProjects({ userId, role, cursor = null, pageSize = 30, q = '' } = {}) {
  let query = supabase
    .from('projects')
    .select(`id, name, status, updated_at, created_by, profiles(email, first_name, last_name), flag_config(id, flag_id), hole_sign_config(id, template_style)`)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageSize);

  if (role !== 'staff' && role !== 'admin') {
    query = query.eq('created_by', userId);
  }
  if (q) {
    const escaped = q.replace(/[%_\\]/g, (m) => `\\${m}`);
    query = query.ilike('name', `%${escaped}%`);
  }
  if (cursor) {
    query = query.or(`updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.lt.${cursor.id})`);
  }

  const { data, error } = await query;
  if (error) throw error;

  const last = data[data.length - 1];
  const nextCursor = data.length === pageSize ? { updatedAt: last.updated_at, id: last.id } : null;
  return { projects: data, nextCursor };
}

export async function loadProject(projectId) {
  const { data, error } = await supabase
    .from('projects')
    .select('*, profiles(email, first_name, last_name)')
    .eq('id', projectId)
    .single();
  if (error) throw error;
  return data;
}

// The DB side is one atomic statement (delete_project() RPC - the projects
// row plus every child row via cascade, in a single transaction). Storage
// cleanup runs after and only on success: an orphaned storage object from a
// failed cleanup call is harmless, but cleaning up storage before the DB
// delete risks orphaning DB rows that point at files which no longer exist.
export async function deleteProject(projectId) {
  const { data: logoPaths, error } = await supabase.rpc('delete_project', { target_project_id: projectId });
  if (error) throw error;

  if (logoPaths?.length) {
    const { error: storageErr } = await supabase.storage.from('flag-logos').remove(logoPaths);
    if (storageErr) throw storageErr;
  }
}

// Print-quality ceiling for a logo placed on a flag/sign — comfortably above
// anything a print placement needs, but caps unbounded phone-camera-photo
// uploads (5000px+ on a side) that would otherwise be stored and re-fetched
// at full size on every gallery render and print export.
const MAX_LOGO_DIM = 3000;

// SVG stays vector (never rasterize it); GIF is skipped so an animated
// upload doesn't get flattened to its first frame.
async function downscaleRasterIfNeeded(file) {
  if (!/^image\//.test(file.type) || file.type === 'image/svg+xml' || file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const { width, height } = bitmap;
  if (Math.max(width, height) <= MAX_LOGO_DIM) { bitmap.close?.(); return file; }

  const scale = MAX_LOGO_DIM / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' });
}

// ── Logos ──────────────────────────────────────────────────
export async function uploadLogo(projectId, file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const { rasterizePdfToPng } = await import('./pdf-raster.js');
    file = await rasterizePdfToPng(file);
  }
  file = await downscaleRasterIfNeeded(file);
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

export async function loadLogosForProject(projectId, client = supabase) {
  const { data, error } = await client
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
      variations: { layout: state.logoLayout || 'single', items: state.variations, gsTag: state.gsTag ?? false, gsTagMode: state.gsTagMode ?? 'auto', gsTagColor: state.gsTagColor ?? '#ffffff' },
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
      one_offs: state.defaults || [],
      status: 'draft',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id' });
  if (error) throw error;
  await supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId);
}

export async function saveHsOneOffs(projectId, defaults) {
  const { error } = await supabase
    .from('hole_sign_config')
    .upsert({ project_id: projectId, one_offs: defaults || [], updated_at: new Date().toISOString() }, { onConflict: 'project_id' });
  if (error) throw error;
}

// ── Default hole sign library ──────────────────────────────
// Stored in the flag-logos bucket under a reserved _hs_defaults/ prefix so no
// separate bucket or policy setup is needed.
const HS_DEFAULTS_BUCKET = 'flag-logos';
const HS_DEFAULTS_FOLDER = '_hs_defaults';

export async function listHsDefaults() {
  const { data, error } = await supabase.storage
    .from(HS_DEFAULTS_BUCKET)
    .list(HS_DEFAULTS_FOLDER, { limit: 500, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw error;
  return (data || [])
    .filter(f => f.name && !f.name.endsWith('/') && f.id)
    .map(f => {
      const path = `${HS_DEFAULTS_FOLDER}/${f.name}`;
      const { data: { publicUrl } } = supabase.storage.from(HS_DEFAULTS_BUCKET).getPublicUrl(path);
      return { id: path, name: f.name.replace(/\.[^.]+$/, ''), src: publicUrl, storagePath: path };
    });
}

export async function uploadHsDefault(file) {
  const ext = file.name.split('.').pop();
  const name = file.name.replace(/\.[^.]+$/, '');
  const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
  const path = `${HS_DEFAULTS_FOLDER}/${Date.now()}_${safeName}.${ext}`;
  const { error } = await supabase.storage
    .from(HS_DEFAULTS_BUCKET)
    .upload(path, file, { upsert: false });
  if (error) throw error;
  const { data: { publicUrl } } = supabase.storage.from(HS_DEFAULTS_BUCKET).getPublicUrl(path);
  return { id: path, name: safeName, src: publicUrl, storagePath: path };
}

export async function deleteHsDefault(storagePath) {
  const { error } = await supabase.storage.from(HS_DEFAULTS_BUCKET).remove([storagePath]);
  if (error) throw error;
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

export async function getProjectByToken(token, client = supabase) {
  const { data: project, error } = await client
    .from('projects')
    .select('*')
    .eq('share_token', token)
    .single();
  if (error) throw error;

  const [{ data: flagCfg }, { data: holeCfg }] = await Promise.all([
    client.from('flag_config').select('*').eq('project_id', project.id).maybeSingle(),
    client.from('hole_sign_config').select('*').eq('project_id', project.id).maybeSingle(),
  ]);

  return { ...project, flagConfig: flagCfg || null, holeSignConfig: holeCfg || null };
}

// ── Review workflow (projects.status state machine) ─────────
// Every RPC takes a `target_project_id` key - must match the Postgres
// function's parameter name exactly (supabase-js maps object keys straight
// through to named params). client_approve_proof/client_reject_proof accept
// a `client` override so review.js can pass its createReviewClient(token)
// instance - the x-share-token header it attaches is what the RPC checks
// server-side, since there's no Supabase Auth session on that page.
export async function submitProjectForReview(projectId) {
  const { error } = await supabase.rpc('submit_project_for_review', { target_project_id: projectId });
  if (error) throw error;
}

export async function adminRequestChanges(projectId, note = null) {
  const { error } = await supabase.rpc('admin_request_changes', { target_project_id: projectId, note });
  if (error) throw error;
}

// Returns the project's share_token (minted server-side if it didn't
// already have one) so the caller can build the review URL without a
// second round trip.
export async function adminSendProof(projectId) {
  const { data, error } = await supabase.rpc('admin_send_proof', { target_project_id: projectId });
  if (error) throw error;
  return data;
}

export async function clientApproveProof(projectId, client = supabase) {
  const { error } = await client.rpc('client_approve_proof', { target_project_id: projectId });
  if (error) throw error;
}

export async function clientRejectProof(projectId, note = null, client = supabase) {
  const { error } = await client.rpc('client_reject_proof', { target_project_id: projectId, note });
  if (error) throw error;
}

export async function adminMarkSentToPrint(projectId, storagePath = null, note = null) {
  const { error } = await supabase.rpc('admin_mark_sent_to_print', {
    target_project_id: projectId,
    storage_path: storagePath,
    note,
  });
  if (error) throw error;
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

// Customer-facing event name (distinct from the internal project name) —
// prefers the editable customer_info record, falls back to the original
// order-form intake.
export async function loadEventName(projectId) {
  const [{ data: project }, { data: intake }] = await Promise.all([
    supabase.from('projects').select('customer_info').eq('id', projectId).maybeSingle(),
    supabase.from('order_intakes').select('event_name').eq('project_id', projectId).maybeSingle(),
  ]);
  return project?.customer_info?.event_name || intake?.event_name || null;
}

// ── Customer info (editable, separate from original intake) ──
export async function upsertCustomerInfo(projectId, info) {
  const { error } = await supabase
    .from('projects')
    .update({ customer_info: info, updated_at: new Date().toISOString() })
    .eq('id', projectId);
  if (error) throw error;
}

// ── Feedback ───────────────────────────────────────────────
export async function submitFeedback(projectId, productType, feedbackItems, client = supabase) {
  const { error } = await client
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

export async function getFeedback(projectId, productType = 'flags', client = supabase) {
  const { data, error } = await client
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

export async function sendPrestigeOrder(projectId, projectName, zipBlob) {
  const params = new URLSearchParams({ projectId, projectName });
  const url = `${SUPABASE_URL}/functions/v1/send-prestige-order?${params}`;
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token || SUPABASE_ANON_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: zipBlob,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Prestige send failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Print sheet email (staff/admin only) ────────────────────
const PRINT_SHEETS_BUCKET = 'print-sheets';

export async function uploadPrintSheet(projectId, productType, blob) {
  const path = `${projectId}/${productType}-${Date.now()}.zip`;
  const { error } = await supabase.storage
    .from(PRINT_SHEETS_BUCKET)
    .upload(path, blob, { upsert: false, contentType: 'application/zip' });
  if (error) throw error; // a non-staff caller sees a clear RLS-denied error here
  return path;
}

// Unlike callEdgeFunction() (always anon-key auth, fine for the token-gated
// send-proof-ready/send-order-confirmation), this carries the caller's real
// identity - the edge function re-derives role from this token itself and
// never trusts the client's own isStaffOrAdmin() check. Fails closed rather
// than falling back to the anon key like sendPrestigeOrder() does, since
// this is a privileged action with no legitimate anonymous caller.
export async function sendPrintSheetReady(payload) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-print-sheet-ready`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Print sheet email failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Browsing (not uploading) previously-generated print sheets - relies
// entirely on the print-sheets bucket's own staff/admin-only RLS (no
// ownership branch), same as uploadPrintSheet() above. createSignedUrl()/
// list() are evaluated against the caller's own JWT, not the anon key, so
// no edge function is needed just to mint a browse-time signed URL.
export async function listPrintSheets(projectId) {
  const { data, error } = await supabase.storage
    .from(PRINT_SHEETS_BUCKET)
    .list(projectId, { sortBy: { column: 'created_at', order: 'desc' } });
  if (error) throw error;
  return (data || [])
    .filter(f => f.id)
    .map(f => ({ name: f.name, path: `${projectId}/${f.name}`, createdAt: f.created_at }));
}

export async function getPrintSheetDownloadUrl(path, expiresIn = 300) {
  const { data, error } = await supabase.storage.from(PRINT_SHEETS_BUCKET).createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}
