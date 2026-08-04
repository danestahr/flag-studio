import { isDisplayableImage, fileTypeLabel } from './media-utils.js';

// Clamp bounds for drag/resize, expressed as percent of the zone box — the
// zone is only a placement suggestion (not a hard boundary), so a logo can
// be dragged/resized past it, but not past the canvas itself, which clips it
// via its own overflow:hidden.
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
    src, alt = '', fileLabel, aboveFrame = false,
    minW = 10, maxW = 150, onClick, onStart, onCommit, onSwap, onRemove,
  } = opts;

  const wrap = document.createElement('div');
  wrap.className = 'dz-logo-wrap' + (aboveFrame ? ' above-frame' : '');
  wrap.style.left = data.x + '%';
  wrap.style.top = data.y + '%';
  wrap.style.width = data.w + '%';

  if (isDisplayableImage(src)) {
    const img = document.createElement('img');
    img.className = 'placed-img';
    img.src = src;
    img.alt = alt;
    img.draggable = false;
    wrap.appendChild(img);
  } else {
    const badge = document.createElement('div');
    badge.className = 'placed-file-badge';
    badge.textContent = fileLabel ?? fileTypeLabel(src);
    wrap.appendChild(badge);
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
    if (isCorner(e.target)) return;
    dragging = true;
    zone.classList.add('dz-adjusting');
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
    const dx = (e.clientX - startPX) / zoneRect.width * 100;
    const dy = (e.clientY - startPY) / zoneRect.height * 100;
    const bounds = canvasBoundsInZonePct(zone, canvasEl);
    let nx = Math.max(bounds.minX, Math.min(bounds.maxX, startX + dx));
    let ny = Math.max(bounds.minY, Math.min(bounds.maxY, startY + dy));

    const snapPxX = 5 / zoneRect.width * 100;
    const snapPxY = 5 / zoneRect.height * 100;
    const snapH = Math.abs(nx - 50) < snapPxX;
    const snapV = Math.abs(ny - 50) < snapPxY;
    if (snapH) nx = 50;
    if (snapV) ny = 50;
    zone.classList.toggle('snap-h', snapH);
    zone.classList.toggle('snap-v', snapV);

    data.x = nx; data.y = ny;
    wrap.style.left = nx + '%';
    wrap.style.top = ny + '%';
  });

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    zone.classList.remove('dz-adjusting', 'snap-h', 'snap-v');
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
      zone.classList.add('dz-adjusting');
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
      }
    });

    const stopResizing = () => {
      if (!resizing) return;
      resizing = false;
      zone.classList.remove('dz-adjusting');
      onCommit?.();
    };
    handle.addEventListener('pointerup', stopResizing);
    handle.addEventListener('pointercancel', stopResizing);
  });

  wrap.addEventListener('click', e => {
    e.stopPropagation();
    onClick?.(e);
  });

  return wrap;
}
