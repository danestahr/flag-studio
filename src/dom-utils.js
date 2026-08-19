// Shared DOM/string helpers used across the flags and hole-sign editors.

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Trigger a browser download of a blob/object URL.
export function dl(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Lowercase, dash-separated slug for filenames. `fallback` is used when `s`
// is empty (e.g. hole signs default to 'hole-sign').
export function slug(s, fallback = '') {
  return (s || fallback).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Strip characters illegal in filenames on Windows/macOS while preserving
// case and spaces (unlike `slug`, meant for human-readable download names).
export function sanitizeFilename(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

// Runs `fn` over `items` with at most `limit` in flight at once, preserving
// output order (results[i] corresponds to items[i]). Used by the print
// export pipelines (flags/gallery.js, hs/export.js) to render several
// variations concurrently instead of one at a time — a pure wall-clock win,
// since the final zip is only assembled once at the end either way (nothing
// about peak memory changes based on rendering order).
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
