// Shared DOM/string helpers used across the flags and hole-sign editors.

// Brings the first validation error on screen after a failed "Next"/"Save"/
// "Submit" re-renders the form with error state — a long page (or one where
// the user already scrolled to the button at the bottom) can leave the actual
// problem off-screen with no visible feedback otherwise. Call after the
// re-render that adds the error markup (wrapped in requestAnimationFrame so
// the DOM is committed first). `container` scopes the search when a page has
// more than one form section on screen at once (e.g. a sidebar panel next to
// a canvas) — omit it to search the whole document.
export function scrollToFirstError(container) {
  requestAnimationFrame(() => {
    const root = container || document;
    const el = root.querySelector('.form-error, .field-error, .ack-item.error, .error');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

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

// Force-commit whichever inline canvas text editor (a free text layer or a
// top/bottom banner caption) currently has focus, unless it's inside
// `exceptContainer` (the thing the caller is about to select instead).
// These editors' own pointerdown handlers call preventDefault (needed for
// their custom drag-to-reposition), which suppresses the browser's native
// click-elsewhere blur — so without this, switching selection to a different
// canvas element leaves the old one's toolbar/edit state stuck on screen
// until some later, unrelated click happens to blur it for free.
export function commitActiveCanvasEdit(exceptContainer) {
  const el = document.activeElement;
  if (!el || !el.classList) return;
  const isEditor = el.classList.contains('canvas-edit-input') || el.classList.contains('hs-tl-editor');
  if (isEditor && (!exceptContainer || !exceptContainer.contains(el))) el.blur();
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

// Positions a floating toolbar next to `anchorEl`: centered on it horizontally,
// above it if there's room, below it otherwise — then clamps both axes so the
// toolbar stays within `containerEl` (the design/variations preview column)
// rather than the browser viewport, which would otherwise let it bleed under
// the sidebar or off the top of the page for a zone near the column's edge.
// Falls back to the viewport when `containerEl` isn't found (e.g. anchorEl
// isn't inside a preview column). Shared by the text-layer/banner toolbar
// (hs/design.js's repositionToolbar, position:fixed) and the logo zone
// toolbar (hs/var-toolbar.js's showHsToolbar, position:absolute — pass
// toDocument:true so the result also accounts for page scroll).
export function positionFloatingToolbar(tb, anchorEl, containerEl, { gap = 8, toDocument = false } = {}) {
  const r = anchorEl.getBoundingClientRect();
  const c = containerEl
    ? containerEl.getBoundingClientRect()
    : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  const tw = tb.offsetWidth || 200;
  const th = tb.offsetHeight || 36;

  const fitsAbove = r.top - th - gap >= c.top;
  const top = fitsAbove ? r.top - th - gap : r.bottom + gap;
  const left = r.left + r.width / 2 - tw / 2;

  const clampedTop = Math.max(c.top + gap, Math.min(c.bottom - th - gap, top));
  const clampedLeft = Math.max(c.left + gap, Math.min(c.right - tw - gap, left));

  const offsetX = toDocument ? window.scrollX : 0;
  const offsetY = toDocument ? window.scrollY : 0;
  tb.style.left = (clampedLeft + offsetX) + 'px';
  tb.style.top  = (clampedTop + offsetY) + 'px';
}
