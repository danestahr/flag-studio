// Shared alignment-guide system for every drag/resize gesture that snaps to
// an axis (logos, free text layers, template-logo slots) — before this, each
// had its own hand-duplicated copy of the same guide-line + snap-math pattern.

// Lazily creates (or reuses) a pair of guide lines spanning the full width/
// height of `container` (which must be position:relative/absolute) — a fresh
// render normally clears the whole container anyway, so this just re-attaches
// them if missing.
export function ensureAlignGuides(container) {
  let v = container.querySelector(':scope > .align-guide-v');
  let h = container.querySelector(':scope > .align-guide-h');
  if (!v) { v = document.createElement('div'); v.className = 'align-guide-v'; container.appendChild(v); }
  if (!h) { h = document.createElement('div'); h.className = 'align-guide-h'; container.appendChild(h); }
  return { v, h };
}

// Shows (or hides) one axis's guide line independently of the other. `axis`
// is 'v' (vertical line, positioned via `valuePct` as a left offset) or 'h'
// (horizontal line, positioned via `valuePct` as a top offset).
export function setAlignGuide(container, axis, active, valuePct) {
  const { v, h } = ensureAlignGuides(container);
  const el = axis === 'v' ? v : h;
  if (active) {
    el.style[axis === 'v' ? 'left' : 'top'] = valuePct;
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}

export function hideAlignGuides(container) {
  container.querySelector(':scope > .align-guide-v')?.classList.remove('show');
  container.querySelector(':scope > .align-guide-h')?.classList.remove('show');
}

// Finds the first candidate whose value is within `tol` of the dragged box's
// leading edge, center, or trailing edge (same shape works for either axis —
// pass x/w for horizontal, y/h for vertical) and returns that candidate's
// value plus the box's new leading-edge position that aligns exactly to it.
// Returns null if nothing is within tolerance.
export function findAxisSnap(candidates, pos, size, tol) {
  for (const cand of candidates) {
    if (Math.abs(pos - cand) < tol)            return { value: cand, newPos: cand };
    if (Math.abs(pos + size / 2 - cand) < tol) return { value: cand, newPos: cand - size / 2 };
    if (Math.abs(pos + size - cand) < tol)     return { value: cand, newPos: cand - size };
  }
  return null;
}
