// Read-only scoping pass for the PDF-logo recovery: lists every uploaded
// logo that's still a raw PDF (pre-dates the upload-time rasterization fix),
// so we know the blast radius before writing anything. Run with:
//   node scripts/pdf-logo-scope.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  const env = {};
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = loadEnv();
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: logos, error } = await supabase
  .from('project_logos')
  .select('id, project_id, name, storage_path, public_url')
  .ilike('storage_path', '%.pdf');
if (error) throw error;

console.log(`Found ${logos.length} logo(s) still stored as PDF.\n`);
if (!logos.length) process.exit(0);

const projectIds = [...new Set(logos.map(l => l.project_id))];
const { data: projects, error: pErr } = await supabase
  .from('projects')
  .select('id, name')
  .in('id', projectIds);
if (pErr) throw pErr;
const projectName = Object.fromEntries(projects.map(p => [p.id, p.name]));

// Cross-reference flag_config / hole_sign_config so we know which of these
// logos are actually referenced by a saved variation (vs. uploaded but never
// placed) — that's what determines whether a config patch is needed too.
const { data: flagCfgs } = await supabase.from('flag_config').select('project_id, variations');
const { data: hsCfgs } = await supabase.from('hole_sign_config').select('project_id, variations, one_offs');

function referencesUrl(obj, url) {
  return obj && JSON.stringify(obj).includes(url);
}

for (const l of logos) {
  const usedInFlag = flagCfgs?.some(c => c.project_id === l.project_id && referencesUrl(c.variations, l.public_url));
  const usedInHs = hsCfgs?.some(c => c.project_id === l.project_id &&
    (referencesUrl(c.variations, l.public_url) || referencesUrl(c.one_offs, l.public_url)));
  console.log(
    `- [${projectName[l.project_id] || l.project_id}] "${l.name}"\n` +
    `    logo id: ${l.id}\n` +
    `    storage_path: ${l.storage_path}\n` +
    `    referenced in flag_config: ${!!usedInFlag}, hole_sign_config: ${!!usedInHs}`
  );
}
