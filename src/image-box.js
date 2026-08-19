import { isDisplayableImage, fileTypeLabel } from './media-utils.js';
import { findAxisSnap, hideAlignGuides, setAlignGuide } from './align-guides.js';

// Clamp bounds for drag/resize, expressed as percent of the zone box — the
// zone is only a placement suggestion (not a hard boundary), so a logo can
// be dragged/resized past it, but not past the canvas itself, which clips
// the image (not the box) via clipToCanvas below.
function canvasBoundsInZonePct(zone, canvasEl) {
  const zoneRect = zone.getBoundingClientRect();
  const canvasRect = canvasEl.getBoundingClientRect();
  return {
    minX: (canvasRect.left - zoneRect.left) / zoneRect.width * 100,
    maxX: (canvasRect.right - zoneRect.left) / zoneRect.width * 100,
    minY: (canvasRect.top - zoneRect.top) / zoneRect.height * 100,
    maxY: (canvasRect.bottom - zoneRect.top) / zoneRect.height * 100,
  };
}

// Clip `visual` (the actual <img>/badge, never the wrap) to the canvas's own
// on-screen rect via a pixel clip-path — a logo can be dragged/resized well
// past the canvas (see canvasBoundsInZonePct above), and only the image
// content should visually cut off there, same as the final print. The wrap
// itself (and its corner handles) must stay unclipped so the user can always
// grab a handle to pull an off-canvas logo back, however far it's been
// dragged — an ancestor `overflow:hidden` can't do that selectively since it
// would clip the handles right along with the image.
export function clipToCanvas(visual, canvasEl) {
  const r = visual.getBoundingClientRect();
  const c = canvasEl.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const left = Math.max(0, c.left - r.left);
  const top = Math.max(0, c.top - r.top);
  const right = Math.max(0, r.right - c.right);
  const bottom = Math.max(0, r.bottom - c.bottom);
  visual.style.clipPath = (left || top || right || bottom)
    ? `inset(${top}px ${right}px ${bottom}px ${left}px)`
    : '';
}

// Re-clip every placed image already on this canvas to its current on-screen
// rect — needed after a zoom-level change, since existing clip-paths were
// computed in px at the old canvas size and don't rescale on their own.
export function refreshImageBoxClips(canvasEl) {
  canvasEl.querySelectorAll('.dz-logo-wrap').forEach(wrap => {
    const visual = wrap.querySelector('.placed-img, .placed-file-badge');
    if (visual) clipToCanvas(visual, canvasEl);
  });
  // The below-bg ghost (see createImageBox) lives outside the wrap it mirrors.
  canvasEl.querySelectorAll('.dz-logo-ghost').forEach(ghost => clipToCanvas(ghost, canvasEl));
}

// Same idea for text layers (flags/text-layers.js and hs/design.js share the
// same .hs-tl-overlay/.hs-tl-content structure) — kept here since it's the
// same canvas-bounds clipping concern, just for a different visual element.
export function refreshTextLayerClips(canvasEl) {
  canvasEl.querySelectorAll('.hs-tl-overlay').forEach(overlay => {
    const content = overlay.querySelector('.hs-tl-content');
    if (content) clipToCanvas(content, canvasEl);
  });
}

// Same idea for hole-sign template-logo slots (hs/design.js + template-logos.js).
export function refreshTlSlotClips(canvasEl) {
  canvasEl.querySelectorAll('.tl-slot').forEach(overlay => {
    const visual = overlay.querySelector('.tl-slot-img');
    if (visual) clipToCanvas(visual, canvasEl);
  });
}

// The shared "placed image" box — the draggable/resizable bounding box used
// for any logo image a user has added to a zone (a flag logo, a hole-sign
// variation's logo). Not for backgrounds or template-owned slots, which have
// a different data model (absolute pixel coordinates, aspect-locked resize).
//
// zone     — positioned container defining the %-of-zone coordinate space
//            (e.g. `.dzone`); drag guides are appended here.
// canvasEl — the outer canvas element drag/resize are clamped against.
// data     — plain object with x/y/w (percent of zone box; x/y is the
//            image's center, matching the wrap's translate(-50%,-50%)
//            centering) — mutated in place as the user drags/resizes.
// opts:
//   src, alt     — image to display
//   fileLabel    — badge text shown instead of the image when src isn't a
//                  browser-displayable image type (falls back automatically
//                  via isDisplayableImage/fileTypeLabel if omitted)
//   aboveFrame   — adds the .above-frame class (see .dz-frame-overlay)
//   belowBackground — (hole signs only) the picture itself should render
//                  behind the background/frame. The interactive box (outline,
//                  handles, hover actions) stays normal-tier and fully
//                  clickable/visible regardless — only a non-interactive
//                  "ghost" copy of the image is what actually recedes, kept
//                  in sync with the real box on every drag/resize. This is
//                  necessary rather than just z-indexing the wrap negative:
//                  .dz-logo-wrap's own `transform` makes it a stacking
//                  context root, so a negative z-index directly on it (or
//                  its children) can only ever escape as far as .dzone, its
//                  own parent — which, being otherwise-empty but still a
//                  normal hit-testable box, would then paint (and swallow
//                  clicks) in front of its own now-recessed child.
//   minW, maxW   — width clamp, percent of zone (default 10/150)
//   onClick(e)   — fired on click; caller owns selection/toolbar entirely,
//                  this component never toggles its own .selected class
//   onStart()    — fired once when a drag or resize gesture begins
//   onCommit()   — fired once when a drag or resize gesture ends
//   onSwap()     — if given, adds a hover-only "swap image" button (top-right
//                  corner, matching the template-logo slot's hover actions)
//   onRemove()   — if given, adds a matching hover-only "remove" button
//
// Resizing anchors the corner diagonally opposite whichever handle is being
// dragged (so that corner stays put on screen) — hold Cmd/Meta to grow from
// the center instead.
export function createImageBox(zone, canvasEl, data, opts = {}) {
  const {
    src, alt = '', fileLabel, aboveFrame = false, belowBackground = false,
    minW = 10, maxW = 150, onClick, onStart, onCommit, onSwap, onRemove,
  } = opts;

  const wrap = document.createElement('div');
  wrap.className = 'dz-logo-wrap' + (aboveFrame ? ' above-frame' : '');
  wrap.style.left = data.x + '%';
  wrap.style.top = data.y + '%';
  wrap.style.width = data.w + '%';

  let visual, ghost = null;
  if (isDisplayableImage(src)) {
    const img = document.createElement('img');
    img.className = 'placed-img';
    img.src = src;
    img.alt = alt;
    img.draggable = false;
    // The natural size (and so the rendered height, since height:auto) isn't
    // known until the image loads — clipping any earlier would use a stale
    // (often zero) rect.
    img.addEventListener('load', () => { clipToCanvas(img, canvasEl); if (ghost) clipToCanvas(ghost, canvasEl); });
    wrap.appendChild(img);
    visual = img;

    if (belowBackground) {
      // See the belowBackground doc above — the real img just stays laid
      // out (so wrap keeps its correct size/handles) but invisible; this
      // separate copy, living outside wrap's stacking context, is what
      // actually shows through/behind the background.
      img.style.opacity = '0';
      ghost = document.createElement('img');
      ghost.className = 'dz-logo-ghost';
      ghost.src = src;
      ghost.alt = '';
      ghost.draggable = false;
      ghost.style.left = data.x + '%';
      ghost.style.top = data.y + '%';
      ghost.style.width = data.w + '%';
      zone.appendChild(ghost);
    }
  } else {
    const badge = document.createElement('div');
    badge.className = 'placed-file-badge';
    badge.textContent = fileLabel ?? fileTypeLabel(src);
    wrap.appendChild(badge);
    visual = badge;
  }

  if (onSwap || onRemove) {
    const actions = document.createElement('div');
    actions.className = 'dz-logo-hover-actions';
    if (onSwap) {
      const swapBtn = document.createElement('button');
      swapBtn.type = 'button';
      swapBtn.className = 'dz-logo-mini-btn';
      swapBtn.title = 'Swap image';
      swapBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i>';
      swapBtn.addEventListener('click', e => { e.stopPropagation(); onSwap(); });
      actions.appendChild(swapBtn);
    }
    if (onRemove) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'dz-logo-mini-btn dz-logo-mini-remove';
      removeBtn.title = 'Remove';
      removeBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
      removeBtn.addEventListener('click', e => { e.stopPropagation(); onRemove(); });
      actions.appendChild(removeBtn);
    }
    wrap.appendChild(actions);
  }

  const corners = ['tl', 'tr', 'bl', 'br'].map(pos => {
    const h = document.createElement('div');
    h.className = `dz-resize dz-resize-${pos}`;
    wrap.appendChild(h);
    return { pos, el: h };
  });
  const isCorner = el => corners.some(c => c.el === el);

  // ── Drag ──────────────────────────────────────────────────
  let dragging = false, startPX, startPY, startX, startY;

  wrap.addEventListener('pointerdown', e => {
    // Also skip the hover-only swap/remove buttons — capturing the pointer
    // here would redirect their eventual `click` event's target to `wrap`
    // itself (per the Pointer Events spec, capture redirects associated
    // mouse events too), so the button's own click listener never runs and
    // this component's generic onClick fires in its place instead.
    if (isCorner(e.target) || e.target.closest('.dz-logo-hover-actions')) return;
    dragging = true;
    wrap.setPointerCapture(e.pointerId);
    startPX = e.clientX; startPY = e.clientY;
    startX = data.x; startY = data.y;
    onStart?.();
    // preventDefault below also suppresses the browser's default focus-blur
    // of whatever text field was previously focused elsewhere on the page —
    // without this, that stale field stays focused and a later Delete/
    // Backspace keypress gets swallowed by the "don't delete while typing"
    // guard instead of removing this image.
    document.activeElement?.blur?.();
    e.preventDefault();
  });

  wrap.addEventListener('pointermove', e => {
    // hasPointerCapture guards against a dropped/lost pointerup leaving
    // `dragging` stuck true — without it, the next hover-only pointermove
    // would move the box using the stale start point.
    if (!dragging || !wrap.hasPointerCapture(e.pointerId)) return;
    const zoneRect = zone.getBoundingClientRect();
    const canvasRect = canvasEl.getBoundingClientRect();
    const dx = (e.clientX - startPX) / zoneRect.width * 100;
    const dy = (e.clientY - startPY) / zoneRect.height * 100;
    const bounds = canvasBoundsInZonePct(zone, canvasEl);
    let nx = Math.max(bounds.minX, Math.min(bounds.maxX, startX + dx));
    let ny = Math.max(bounds.minY, Math.min(bounds.maxY, startY + dy));

    // Snap to the zone's own center (nx/ny are already the image's center
    // point per the data-model doc above, so size=0 — a point, not a box).
    const snapTolX = 5 / zoneRect.width * 100;
    const snapTolY = 5 / zoneRect.height * 100;
    const snapX = findAxisSnap([50], nx, 0, snapTolX);
    const snapY = findAxisSnap([50], ny, 0, snapTolY);
    if (snapX) nx = snapX.newPos;
    if (snapY) ny = snapY.newPos;

    // Guides are drawn on the whole canvas, not just this zone, so convert
    // the zone-relative snap point into a canvas-relative percent for display.
    setAlignGuide(canvasEl, 'v', !!snapX, (zoneRect.left + zoneRect.width / 2 - canvasRect.left) / canvasRect.width * 100 + '%');
    setAlignGuide(canvasEl, 'h', !!snapY, (zoneRect.top + zoneRect.height / 2 - canvasRect.top) / canvasRect.height * 100 + '%');

    data.x = nx; data.y = ny;
    wrap.style.left = nx + '%';
    wrap.style.top = ny + '%';
    clipToCanvas(visual, canvasEl);
    if (ghost) {
      ghost.style.left = nx + '%';
      ghost.style.top = ny + '%';
      clipToCanvas(ghost, canvasEl);
    }
  });

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    hideAlignGuides(canvasEl);
    onCommit?.();
  };
  wrap.addEventListener('pointerup', stopDragging);
  wrap.addEventListener('pointercancel', stopDragging);

  // ── Resize ────────────────────────────────────────────────
  corners.forEach(({ pos, el: handle }) => {
    const dirX = pos === 'tl' || pos === 'bl' ? -1 : 1;
    const dirY = pos === 'tl' || pos === 'tr' ? -1 : 1;
    let resizing = false, rStartClientX, rStartClientY, rStartW, rDzW, rDzH;
    let rStartCenterPxX, rStartCenterPxY, rStartHalfPxW, rStartHalfPxH;

    handle.addEventListener('pointerdown', e => {
      resizing = true;
      handle.setPointerCapture(e.pointerId);
      rStartClientX = e.clientX;
      rStartClientY = e.clientY;
      rStartW = data.w;
      const zoneRect = zone.getBoundingClientRect();
      rDzW = zoneRect.width;
      rDzH = zoneRect.height;
      rStartCenterPxX = (data.x / 100) * rDzW;
      rStartCenterPxY = (data.y / 100) * rDzH;
      rStartHalfPxW = wrap.offsetWidth / 2;
      rStartHalfPxH = wrap.offsetHeight / 2;
      onStart?.();
      document.activeElement?.blur?.();
      e.stopPropagation();
      e.preventDefault();
    });

    handle.addEventListener('pointermove', e => {
      // hasPointerCapture guards against a dropped/lost pointerup leaving
      // `resizing` stuck true — without it, merely hovering the handle
      // afterward would resize using the stale start point.
      if (!resizing || !handle.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - rStartClientX;
      const dy = e.clientY - rStartClientY;
      // dead-zone: ignore micro-movements
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      // project displacement onto this corner's outward direction; both axes contribute
      const rawDx = dx / rDzW * 100 * 2;
      const rawDy = dy / rDzH * 100 * 2;
      const dw = dirX * rawDx + dirY * rawDy;
      const nw = Math.max(minW, Math.min(maxW, rStartW + dw));
      data.w = nw;
      wrap.style.width = nw + '%';
      if (ghost) ghost.style.width = nw + '%';

      // Anchor the diagonally opposite corner in place on screen — height
      // follows the image's own aspect ratio, so it scales by the same
      // factor as width. Cmd/Meta skips this and grows from the center
      // instead (x/y untouched).
      if (!e.metaKey && rStartW > 0) {
        const scale = nw / rStartW;
        const halfPxW = rStartHalfPxW * scale;
        const halfPxH = rStartHalfPxH * scale;
        const cx = rStartCenterPxX + dirX * (halfPxW - rStartHalfPxW);
        const cy = rStartCenterPxY + dirY * (halfPxH - rStartHalfPxH);
        const bounds = canvasBoundsInZonePct(zone, canvasEl);
        data.x = Math.max(bounds.minX, Math.min(bounds.maxX, (cx / rDzW) * 100));
        data.y = Math.max(bounds.minY, Math.min(bounds.maxY, (cy / rDzH) * 100));
        wrap.style.left = data.x + '%';
        wrap.style.top = data.y + '%';
        if (ghost) { ghost.style.left = data.x + '%'; ghost.style.top = data.y + '%'; }
      }
      clipToCanvas(visual, canvasEl);
      if (ghost) clipToCanvas(ghost, canvasEl);
    });

    const stopResizing = () => {
      if (!resizing) return;
      resizing = false;
      onCommit?.();
    };
    handle.addEventListener('pointerup', stopResizing);
    handle.addEventListener('pointercancel', stopResizing);
  });

  wrap.addEventListener('click', e => {
    e.stopPropagation();
    onClick?.(e);
  });

  // Deferred so it runs after the caller has appended `wrap` to the live DOM
  // (always done synchronously, in the same tick, right after this returns)
  // — clipping now would only see a zero-size, not-yet-laid-out rect.
  requestAnimationFrame(() => { clipToCanvas(visual, canvasEl); if (ghost) clipToCanvas(ghost, canvasEl); });

  return wrap;
}
