// Recovery for logos uploaded as raw PDFs before uploadLogo() started
// rasterizing them (src/pdf-raster.js / src/supabase.js). Browsers can't
// paint a PDF via <img>/SVG <image>, so these never rendered once placed —
// this rasterizes page 1 of each, re-uploads it as a PNG, repoints the
// project_logos row, and patches the matching logoSrc/artboardSrc URLs saved
// inside that project's hole_sign_config (flag_config had none — see
// pdf-logo-scope.mjs output). Original PDFs are left in Storage untouched.
//
// Run with: node scripts/pdf-logo-fix.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

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
const BUCKET = 'flag-logos';
const RASTER_SCALE = 300 / 72; // print-resolution equivalent for a 72pt/in PDF page

async function rasterizeFirstPage(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: RASTER_SCALE });
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer('image/png');
}

const limit = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;

const { data: allLogos, error } = await supabase
  .from('project_logos')
  .select('id, project_id, name, storage_path, public_url')
  .ilike('storage_path', '%.pdf');
if (error) throw error;
const logos = allLogos.slice(0, limit);
console.log(`Fixing ${logos.length} of ${allLogos.length} PDF logo(s)...\n`);

let fixed = 0, failed = 0;

for (const logo of logos) {
  try {
    const { data: pdfBlob, error: dlErr } = await supabase.storage.from(BUCKET).download(logo.storage_path);
    if (dlErr) throw dlErr;
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());

    const pngBuffer = await rasterizeFirstPage(pdfBytes);
    const newPath = logo.storage_path.replace(/\.pdf$/i, '.png');

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(newPath, pngBuffer, { contentType: 'image/png', upsert: false });
    if (upErr) throw upErr;

    const { data: { publicUrl: newUrl } } = supabase.storage.from(BUCKET).getPublicUrl(newPath);

    const { error: updErr } = await supabase
      .from('project_logos')
      .update({ storage_path: newPath, public_url: newUrl })
      .eq('id', logo.id);
    if (updErr) throw updErr;

    // Patch denormalized copies of the old URL saved inside variations —
    // logoSrc/artboardSrc were snapshotted at assignment time, not looked up
    // by logo id, so updating project_logos alone wouldn't fix them.
    const { data: hsCfg, error: hsErr } = await supabase
      .from('hole_sign_config')
      .select('project_id, variations, one_offs')
      .eq('project_id', logo.project_id)
      .maybeSingle();
    if (hsErr) throw hsErr;

    if (hsCfg) {
      const patch = {};
      if (JSON.stringify(hsCfg.variations || null).includes(logo.public_url)) {
        patch.variations = JSON.parse(JSON.stringify(hsCfg.variations).split(logo.public_url).join(newUrl));
      }
      if (JSON.stringify(hsCfg.one_offs || null).includes(logo.public_url)) {
        patch.one_offs = JSON.parse(JSON.stringify(hsCfg.one_offs).split(logo.public_url).join(newUrl));
      }
      if (Object.keys(patch).length) {
        const { error: patchErr } = await supabase.from('hole_sign_config').update(patch).eq('project_id', logo.project_id);
        if (patchErr) throw patchErr;
      }
    }

    console.log(`✓ ${logo.name} (${logo.id}) → ${newPath}`);
    fixed++;
  } catch (err) {
    console.error(`✗ ${logo.name} (${logo.id}) failed:`, err.message || err);
    failed++;
  }
}

console.log(`\nDone. Fixed ${fixed}, failed ${failed}. Original PDFs left in place in "${BUCKET}".`);
