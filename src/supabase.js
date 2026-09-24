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
    redirectTo: `${window.location.origin}/reset-password`,
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
// customerInfo is optional so this stays a one-statement insert (never a
// bare row followed by an update) when the caller already has event info to
// save - see event-info.js, the only caller that passes it today.
export async function createProject(name = '', customerInfo = null) {
  const { data, error } = await supabase
    .from('projects')
    .insert({ name: name || null, ...(customerInfo ? { customer_info: customerInfo } : {}) })
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
// Note: `status` filtering (by flags/hole-signs design status) happens
// client-side in landing.js, not here - PostgREST can't express an OR
// across two different embedded tables' columns (flag_config.status vs
// hole_sign_config.status) in one query, only within a single one.
export async function listProjects({ userId, role, cursor = null, pageSize = 30, q = '' } = {}) {
  let query = supabase
    .from('projects')
    .select(`id, name, status, updated_at, created_by, customer_info, profiles(email, first_name, last_name), flag_config(id, flag_id, status), hole_sign_config(id, template_style, status)`)
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

  // Not tracked in project_logos (it's an order-confirmation-email preview,
  // not a customer logo — see uploadFlagPreview), so delete_project() doesn't
  // know about it; best-effort clean up here instead of leaving it orphaned.
  await supabase.storage.from('flag-logos').remove([`${projectId}/flag-preview.png`]).catch(() => {});
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
  // Date.now() alone collides when multiple files upload in parallel (e.g.
  // hs/variations.js's handleHsArtboardUpload, which Promise.all()s a
  // multi-file selection) — several calls can land in the same millisecond.
  const path = `${projectId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

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

// Renders a one-off PNG of the flag design the customer picked in the order
// intake flow (order.js's rasterizeFlagPreviewPng), so send-order-confirmation
// — a Deno edge function with no DOM/canvas — can embed it as a plain <img>
// without having to render anything itself. Reuses the flag-logos bucket
// (already public and anon-writable from this same anonymous flow) instead of
// adding a new bucket; upsert:true so a retried submit overwrites cleanly.
// Deliberately not inserted into project_logos — it's not a customer logo.
export async function uploadFlagPreview(projectId, blob) {
  const path = `${projectId}/flag-preview.png`;
  const { error: uploadError } = await supabase.storage
    .from('flag-logos')
    .upload(path, blob, { upsert: true, contentType: 'image/png' });
  if (uploadError) throw uploadError;

  const { data: { publicUrl } } = supabase.storage
    .from('flag-logos')
    .getPublicUrl(path);
  return publicUrl;
}

// A customer's replacement-logo request from review.html's "Request edits"
// quick-picks. Same reasoning as uploadFlagPreview: the review page's anon
// share-token client can't insert a project_logos row (that table's insert
// RLS requires ownership/staff/an ownerless project — none apply to an
// existing, already-owned project at review time), so this writes straight
// to the public flag-logos bucket and the URL/path are stored directly on
// the variation_feedback row instead (requested_logo_url/requested_logo_path).
export async function uploadFeedbackLogo(projectId, variationId, file, client = supabase) {
  const ext = file.name.split('.').pop();
  const path = `${projectId}/feedback/${variationId}-${Date.now()}.${ext}`;
  const { error } = await client.storage
    .from('flag-logos')
    .upload(path, file, { contentType: file.type });
  if (error) throw error;

  const { data: { publicUrl } } = client.storage
    .from('flag-logos')
    .getPublicUrl(path);
  return { url: publicUrl, storagePath: path };
}

// Staff "adopting" a reviewer-uploaded feedback logo (see uploadFeedbackLogo
// above) into the project's regular logo library, once they apply it via the
// edit-requests panel — the file already lives in the flag-logos bucket at
// requested_logo_path (the feedback flow could only write there, not to
// project_logos, per uploadFeedbackLogo's own comment), so this just adds the
// missing project_logos row pointing at that same object instead of
// re-uploading it. Unlike uploadFeedbackLogo, this runs in an authenticated
// staff/owner session, so the normal project_logos insert RLS applies fine.
export async function adoptFeedbackLogo(projectId, name, publicUrl, storagePath, client = supabase) {
  const { data, error } = await client
    .from('project_logos')
    .insert({ project_id: projectId, name, storage_path: storagePath, public_url: publicUrl })
    .select('id, name, storage_path, public_url')
    .single();
  if (error) throw error;
  return { id: data.id, name: data.name, src: data.public_url, storagePath: data.storage_path };
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

// A logo library reusable across a user's own projects (unlike project_logos,
// scoped by created_by rather than project_id — see user_logos migration).
export async function uploadUserLogo(file) {
  const { data: { session } } = await supabase.auth.getSession();
  const userId = session.user.id;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const { rasterizePdfToPng } = await import('./pdf-raster.js');
    file = await rasterizePdfToPng(file);
  }
  file = await downscaleRasterIfNeeded(file);
  const ext = file.name.split('.').pop();
  const path = `user-logos/${userId}/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('flag-logos')
    .upload(path, file, { upsert: false });
  if (uploadError) throw uploadError;

  const { data: { publicUrl } } = supabase.storage
    .from('flag-logos')
    .getPublicUrl(path);

  const { data, error } = await supabase
    .from('user_logos')
    .insert({ created_by: userId, name: file.name.replace(/\.[^.]+$/, ''), storage_path: path, public_url: publicUrl })
    .select('id, name, storage_path, public_url')
    .single();
  if (error) throw error;

  return { id: data.id, name: data.name, src: publicUrl, storagePath: path };
}

// `ownerId` is required so staff/admin (whose RLS OR-branch has no
// project-scoping to fall back on - user_logos isn't project_id-keyed, see
// the migration) don't pull in every customer's personal library alongside
// the one they're actually supposed to be looking at.
export async function listUserLogos(ownerId, client = supabase) {
  const { data, error } = await client
    .from('user_logos')
    .select('id, name, public_url, storage_path')
    .eq('created_by', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(l => ({ id: l.id, name: l.name, src: l.public_url, storagePath: l.storage_path }));
}

export async function deleteUserLogo(storagePath, logoId) {
  await supabase.storage.from('flag-logos').remove([storagePath]);
  await supabase.from('user_logos').delete().eq('id', logoId);
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
      // Each variation carries its own sameLogoOnBothSides now (see
      // flags/variations.js's toggleSameSides) — flag_config's own
      // same_logo_on_both_sides column is legacy (pre-per-variation) and
      // deliberately left untouched here; a variation saved before that
      // migration falls back to whatever value is already in it.
      variations: { layout: state.logoLayout || 'single', items: state.variations, gsTag: state.gsTag ?? false, gsTagMode: state.gsTagMode ?? 'auto', gsTagColor: state.gsTagColor ?? '#ffffff', customColors: state.customColors || [], textLayers: state.textLayers || [], imageLayers: state.imageLayers || [] },
      // status is NOT set here - it's an independent state machine owned by
      // the submit/review RPCs (submit_design_for_review, admin_send_design_proof,
      // client_approve_design_proof, etc. - see 20260913000000_per_design_status_workflow.sql).
      // Writing 'draft' here on every autosave would silently undo any
      // progress the design already made through that workflow the moment
      // staff (who bypass the design_is_editable() RLS check) touch the
      // editor again after submission.
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
      // status intentionally omitted — see the same note in saveFlagConfig above.
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

// ── Review workflow (flag_config.status / hole_sign_config.status
// state machines - flags and hole signs progress independently, see
// supabase/migrations/20260913000000_per_design_status_workflow.sql) ───────
// Every RPC takes `target_project_id`/`target_product_type` keys - must
// match the Postgres function's parameter names exactly (supabase-js maps
// object keys straight through to named params). `productType` is always
// 'flags' or 'hole-signs'. client_approve_design_proof/
// client_reject_design_proof accept a `client` override so review.js can
// pass its createReviewClient(token) instance - the x-share-token header it
// attaches is what the RPC checks server-side, since there's no Supabase
// Auth session on that page.
export async function submitDesignForReview(projectId, productType) {
  const { error } = await supabase.rpc('submit_design_for_review', { target_project_id: projectId, target_product_type: productType });
  if (error) throw error;
}

export async function adminRequestDesignChanges(projectId, productType, note = null) {
  const { error } = await supabase.rpc('admin_request_design_changes', { target_project_id: projectId, target_product_type: productType, note });
  if (error) throw error;
}

// Returns the project's share_token (minted server-side if it didn't
// already have one) so the caller can build the review URL without a
// second round trip.
export async function adminSendDesignProof(projectId, productType) {
  const { data, error } = await supabase.rpc('admin_send_design_proof', { target_project_id: projectId, target_product_type: productType });
  if (error) throw error;
  return data;
}

export async function clientApproveDesignProof(projectId, productType, client = supabase) {
  const { error } = await client.rpc('client_approve_design_proof', { target_project_id: projectId, target_product_type: productType });
  if (error) throw error;
}

export async function clientRejectDesignProof(projectId, productType, note = null, client = supabase) {
  const { error } = await client.rpc('client_reject_design_proof', { target_project_id: projectId, target_product_type: productType, note });
  if (error) throw error;
}

export async function adminMarkDesignSentToPrint(projectId, productType, storagePath = null, note = null) {
  const { error } = await supabase.rpc('admin_mark_design_sent_to_print', {
    target_project_id: projectId,
    target_product_type: productType,
    storage_path: storagePath,
    note,
  });
  if (error) throw error;
}

// Most recent reason a design was kicked back to needs_changes - shown to
// the owner on project.html. Owners can read their own project's
// admin_actions rows (see "owners can read own project admin_actions" RLS
// policy); note can be null if the actor didn't leave one.
export async function loadLatestChangeNote(projectId, productType) {
  const { data, error } = await supabase
    .from('admin_actions')
    .select('note, created_at, action')
    .eq('project_id', projectId)
    .eq('product_type', productType)
    .in('action', ['admin_request_changes', 'client_reject_proof'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Most recent time this design was sent/resent to print - admin_mark_design_
// sent_to_print logs a fresh 'sent_to_print' admin_actions row on every send,
// including resends (see 20260915000000_allow_resend_to_print.sql), so this
// is the authoritative "last sent" timestamp - unlike flag_config/hole_sign_
// config.updated_at, which also moves on unrelated edits made after the print
// action.
export async function loadLatestPrintAction(projectId, productType) {
  const { data, error } = await supabase
    .from('admin_actions')
    .select('created_at')
    .eq('project_id', projectId)
    .eq('product_type', productType)
    .eq('action', 'sent_to_print')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
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

// Deleting a variation should not leave its feedback row behind — an orphan
// there would keep showing up in the "Edit requested" banner's count forever
// since nothing else ever resolves or deletes it.
export async function deleteFeedbackForVariation(projectId, productType, variationId) {
  const { error } = await supabase
    .from('variation_feedback')
    .delete()
    .eq('project_id', projectId)
    .eq('product_type', productType)
    .eq('variation_id', variationId);
  if (error) throw error;
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

// Internal notification (dane@danestahr.com) fired when a customer submits an
// order via /orders - see send-order-notification edge function.
export async function sendOrderNotification(payload) {
  return callEdgeFunction('send-order-notification', payload);
}

// Given a GolfStatus event page URL, returns { eventName, courseName,
// eventDate, logoBase64, logoContentType } (nulls for whatever's missing) —
// see supabase/functions/sync-event-info for the GolfStatus API details.
// Unwraps the edge function's { error } body into a plain Error message
// where possible, so callers can show it directly rather than
// callEdgeFunction's generic "Edge function X failed: <raw body>" text.
export async function syncEventInfo(url) {
  try {
    return await callEdgeFunction('sync-event-info', { url });
  } catch (err) {
    const prefix = 'Edge function sync-event-info failed: ';
    if (err.message?.startsWith(prefix)) {
      let parsed = null;
      try { parsed = JSON.parse(err.message.slice(prefix.length)); } catch { /* not JSON, fall through */ }
      if (parsed?.error) throw new Error(parsed.error);
    }
    throw err;
  }
}

export async function sendProofReady(payload) {
  return callEdgeFunction('send-proof-ready', payload);
}

// Internal notification (dane@danestahr.com) fired when a client acts on a
// proof from review.html - see send-review-decision edge function.
export async function sendReviewDecision(payload) {
  return callEdgeFunction('send-review-decision', payload);
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
