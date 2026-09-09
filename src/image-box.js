import { isDisplayableImage, fileTypeLabel } from './media-utils.js';
import { findAxisSnap, hideAlignGuides, setAlignGuide } from './align-guides.js';

// ── Cover-fit "drag to reposition" image math ──────────────────────────────
// Shared by the hole-sign banner image and main sign background image
// controls (hs/banner.js, hs/design.js) AND their SVG renderer
// (hole-sign-render.js's bgCoverBox, used for both) — true "background-size:
// cover" behavior: the natural image is scaled by
// max(containerW/natW, containerH/natH) — whichever axis is tighter — so it
// exactly covers the container with the OTHER axis left with real slack to
// pan through, before any extra `scalePct` zoom is even applied. This is why
// natural image size has to flow all the way into the renderer (captured
// once at upload time — see handleBannerImageUpload/handleBgImageUpload —
// and stored as bg.imageNaturalW/imageNaturalH) rather than staying a
// client-side-preview-only concern: without it the renderer can't tell which
// axis has slack, so panning would either do nothing (locked dead center) or
// invent slack that isn't really there.
const _imgNaturalSizeCache = new Map();

// Loads (and caches) an image's natural pixel size, then calls back with
// (naturalWidth, naturalHeight). Calls back synchronously on a cache hit.
// Used to backfill bg.imageNaturalW/H at upload time, and as a fallback for
// the sidebar preview on images saved before that capture existed (their
// bg.imageNaturalW/H is undefined, so layoutImgDragThumb falls back to this).
export function loadNaturalImgSize(url, cb) {
  const cached = _imgNaturalSizeCache.get(url);
  if (cached) { cb(cached.w, cached.h); return; }
  const img = new Image();
  img.onload = () => {
    const size = { w: img.naturalWidth, h: img.naturalHeight };
    _imgNaturalSizeCache.set(url, size);
    cb(size.w, size.h);
  };
  img.src = url;
}

// The scaled image size for a true cover fit — dispW/dispH is the container
// (px on screen, or sign units for the SVG side — unit-agnostic as long as
// every argument agrees), natW/natH the image's natural size, scalePct the
// sidebar's 100-300 scroll-to-zoom control (100 = bare cover, no extra zoom).
export function coverFitBox(dispW, dispH, natW, natH, scalePct) {
  const base = Math.max(dispW / natW, dispH / natH);
  const f = base * ((scalePct ?? 100) / 100);
  return { w: natW * f, h: natH * f };
}

// Clamps one axis's pan percent so the cover-scaled image never uncovers a
// gap on that axis — `imgSize`/`dispSize` are that axis's already-scaled
// image size (coverFitBox's w or h) and the container size (same units). At
// the minimum cover scale (imgSize === dispSize, that axis has zero natural
// slack) this collapses to exactly 50 — any pan would show a gap; the more
// natural slack an axis has (from a mismatched aspect ratio, or extra
// scalePct zoom), the wider the symmetric range around 50 gets. That range
// is NOT capped to [0, 100]: once an axis has more than 2x slack (r > 2,
// common for a portrait photo panned inside a wide banner), the position
// where the image's own edge is exactly flush with the container's edge
// needs a pct outside 0-100 — clamping to that range would cut the pan
// range off short of the image's actual top/bottom (or left/right) edge,
// even though nothing about imageX/imageY or the renderer requires 0-100.
export function clampCoverPct(pct, imgSize, dispSize) {
  const r = dispSize > 0 ? imgSize / dispSize : 1; // >= 1 once scaled to cover
  const min = 100 - 50 * r, max = 50 * r;
  return Math.max(min, Math.min(max, pct ?? 50));
}

// Clamps xPct/yPct against the TRUE container dimensions (containerW/
// containerH — sign units: HS_W/bannerHeight for a banner, HS_W/HS_H for the
// main background; see hole-sign-data.js) rather than any rendered pixel
// measurement. A rendered widget's offsetWidth/offsetHeight are integers, and
// on a very short/wide widget (a tight banner strip can be well under 100px
// tall) that rounding is enough — a percent or so — to compute a slightly
// tighter range than the real one, so the clamp lets go a hair short of the
// image's actual edge and leaves a sliver ungapped-but-uncovered instead of
// flush. Using the exact sign-unit dimensions here (the same ones the
// renderer itself uses) makes this the single source of truth for what
// xPct/yPct is actually allowed — see clampPanToBg/layoutImgDragThumb below,
// both of which route through this instead of re-deriving their own range
// from a DOM measurement.
export function clampPanPct(containerW, containerH, natW, natH, scalePct, xPct, yPct) {
  const { w, h } = coverFitBox(containerW, containerH, natW, natH, scalePct);
  return {
    x: clampCoverPct(xPct, w, containerW),
    y: clampCoverPct(yPct, h, containerH),
  };
}

// Synchronous pan clamp for drag/wheel handlers, reading natural size
// straight off `bg` (bg.imageNaturalW/imageNaturalH — see the module doc
// above) instead of waiting on loadNaturalImgSize, so it can't race a
// cold image-size cache the way layoutImgDragThumb below can. `containerW`/
// `containerH` are the TRUE container dimensions — see clampPanPct; pass the
// same ones layoutImgDragThumb is given for this bg. Falls back to a plain
// 0-100 clamp for an image saved before natural size was captured;
// layoutImgDragThumb's own (async) clamp corrects those the next time the
// sidebar re-renders, once its natural size has loaded.
export function clampPanToBg(containerW, containerH, bg, xPct, yPct) {
  const { imageNaturalW: natW, imageNaturalH: natH, imageScale } = bg;
  if (natW && natH) return clampPanPct(containerW, containerH, natW, natH, imageScale, xPct, yPct);
  return { x: Math.max(0, Math.min(100, xPct ?? 50)), y: Math.max(0, Math.min(100, yPct ?? 50)) };
}

// The image's on-screen pixel box for a "drag to reposition" thumb —
// dispW/dispH here ARE the rendered pixel dimensions (unlike clampPanPct's
// containerW/containerH), used only to size/position the CSS box in real
// px; xPct/yPct must already be clamped (see clampPanPct) before calling
// this, since it does no clamping of its own. Returns { w, h, x, y } (x/y is
// the top-left, not the center, ready to hand straight to background-
// position).
export function coverImgBox(dispW, dispH, natW, natH, scalePct, xPct, yPct) {
  const { w, h } = coverFitBox(dispW, dispH, natW, natH, scalePct);
  const cx = (xPct ?? 50) / 100 * dispW, cy = (yPct ?? 50) / 100 * dispH;
  return { w, h, x: cx - w / 2, y: cy - h / 2 };
}

// Applies coverImgBox to a "drag to reposition" thumb's background-size/
// -position — called after every render (once the thumb's actual on-screen
// size is known) and live during drag/wheel. `bg` is the plain state object
// carrying imageUrl/imageX/imageY/imageScale/imageNaturalW/imageNaturalH (a
// banner's `banner.bg` or the main sign's `HS.background`) — its imageX/
// imageY are corrected in place via clampPanPct against `containerW`/
// `containerH` (the TRUE container dimensions, not a DOM measurement — see
// clampPanPct) before being used to size the thumb, so a pan/zoom that would
// otherwise leave a gap gets pulled back to the nearest position that
// doesn't, for both this preview and the real SVG render (which reads the
// same fields) — and never re-tightens an already-exact position the way
// clamping against this thumb's own rendered pixels could. Prefers bg's own
// captured natural size (synchronous); for an image saved before that
// capture existed (so bg.imageNaturalW/H is still empty), falls back to the
// async image-load lookup AND backfills bg.imageNaturalW/H from it — the
// renderer (hole-sign-render.js's bgCoverBox) can't load the image itself,
// so without this backfill a pre-existing image would stay locked out of
// the real cover-fit (and its actual pan range) forever, not just until
// this thumb's own next render. `onNaturalSizeLoaded`, if given, fires once
// that backfill lands — callers use it to redraw the canvas, which (unlike
// this thumb) doesn't otherwise get a second chance to pick the new size up.
export function layoutImgDragThumb(wrap, thumb, bg, containerW, containerH, onNaturalSizeLoaded) {
  if (!wrap || !thumb || !bg?.imageUrl) return;
  const apply = (natW, natH) => {
    if (!wrap.isConnected || !thumb.isConnected) return;
    const dispW = wrap.offsetWidth, dispH = wrap.offsetHeight;
    if (!dispW || !dispH || !natW || !natH) return;
    const p = clampPanPct(containerW, containerH, natW, natH, bg.imageScale, bg.imageX, bg.imageY);
    bg.imageX = p.x;
    bg.imageY = p.y;
    const box = coverImgBox(dispW, dispH, natW, natH, bg.imageScale, p.x, p.y);
    thumb.style.backgroundSize = `${box.w}px ${box.h}px`;
    thumb.style.backgroundPosition = `${box.x}px ${box.y}px`;
  };
  if (bg.imageNaturalW && bg.imageNaturalH) {
    apply(bg.imageNaturalW, bg.imageNaturalH);
  } else {
    loadNaturalImgSize(bg.imageUrl, (natW, natH) => {
      bg.imageNaturalW = natW;
      bg.imageNaturalH = natH;
      apply(natW, natH);
      onNaturalSizeLoaded?.();
    });
  }
}

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
// variation's logo, a hole-sign template-logo slot).
//
// zone     — positioned container defining the %-of-zone coordinate space
//            (e.g. `.dzone`); drag guides are appended here. Pass the same
//            element as canvasEl when there's no sub-zone (e.g. template
//            logos, positioned directly against the whole sign canvas).
// canvasEl — the outer canvas element drag/resize are clamped against.
// data     — plain object (or getter/setter adapter over some other backing
//             store, e.g. a template-logo slot's absolute-pixel freeX/freeY/
//             freeW/freeH) with x/y/w (percent of zone box; x/y is the box's
//             center, matching the wrap's translate(-50%,-50%) centering) —
//             mutated in place as the user drags/resizes. An optional `h`
//             (percent of zone) locks the wrap to an explicit, independently
//             stored aspect ratio instead of the default CSS height:auto
//             (which otherwise just follows the image's own intrinsic
//             ratio) — resize scales h by the same factor as w, so the box's
//             own aspect ratio never changes, only its size.
// opts:
//   src, alt     — image to display
//   visualEl     — use this pre-built element as the visual instead of
//                  building an <img>/badge from src (e.g. a template-logo
//                  slot's own background/border/fit-positioned content) —
//                  src/alt/fileLabel are ignored when given.
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
//   onRemove()   — if given, adds a hover-only "remove" button (top-right
//                  corner, matching the template-logo slot's hover actions).
//                  Swap/reorder actions live only in the zone toolbar now, not
//                  on the image itself.
//   extraSnapX, extraSnapY — extra drag snap-candidate percents (of zone),
//                  beyond the zone's own 50% center — e.g. sibling template-
//                  logo slots' edges/centers, so one slot's drag can snap
//                  into alignment with another. Center-point-only, same as
//                  the built-in center snap (not full edge-to-edge matching).
//
// Resizing (from a corner or an edge-midpoint handle) anchors whichever
// point is diagonally/directly opposite the handle being dragged (so that
// point stays put on screen) — hold Cmd/Meta to grow from the center instead.
export function createImageBox(zone, canvasEl, data, opts = {}) {
  const {
    src, alt = '', fileLabel, visualEl, aboveFrame = false, belowBackground = false,
    minW = 10, maxW = 150, onClick, onStart, onCommit, onRemove,
  } = opts;

  const wrap = document.createElement('div');
  wrap.className = 'dz-logo-wrap' + (aboveFrame ? ' above-frame' : '');
  wrap.style.left = data.x + '%';
  wrap.style.top = data.y + '%';
  wrap.style.width = data.w + '%';
  if (data.h != null) wrap.style.height = data.h + '%';

  let visual, ghost = null;
  if (visualEl) {
    wrap.appendChild(visualEl);
    visual = visualEl;
  } else if (isDisplayableImage(src)) {
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

  if (onRemove) {
    const actions = document.createElement('div');
    actions.className = 'dz-logo-hover-actions';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'dz-logo-mini-btn dz-logo-mini-remove';
    removeBtn.title = 'Remove';
    removeBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
    removeBtn.addEventListener('click', e => { e.stopPropagation(); onRemove(); });
    actions.appendChild(removeBtn);
    wrap.appendChild(actions);
  }

  const corners = ['tl', 'tr', 'bl', 'br', 't', 'r', 'b', 'l'].map(pos => {
    const h = document.createElement('div');
    h.className = `dz-resize dz-resize-${pos}`;
    wrap.appendChild(h);
    return { pos, el: h };
  });
  const isCorner = el => corners.some(c => c.el === el);

  // ── Drag ──────────────────────────────────────────────────
  let dragging = false, moved = false, startPX, startPY, startX, startY;
  // A pointerdown+pointerup pair on the same element always fires a trailing
  // native 'click' afterward, even when a drag or resize moved the box in
  // between — the browser only cares that down/up landed on the same target,
  // not what happened while the pointer was captured. Without this flag that
  // synthetic click reaches the listener below just like a real click would,
  // and since the box is already selected at that point, onClick's toggle
  // logic reads it as "clicked again while selected" and deselects — so
  // every drag/resize-then-release immediately undid its own selection.
  let suppressNextClick = false;

  wrap.addEventListener('pointerdown', e => {
    // Also skip the hover-only swap/remove buttons — capturing the pointer
    // here would redirect their eventual `click` event's target to `wrap`
    // itself (per the Pointer Events spec, capture redirects associated
    // mouse events too), so the button's own click listener never runs and
    // this component's generic onClick fires in its place instead.
    if (isCorner(e.target) || e.target.closest('.dz-logo-hover-actions')) return;
    onStart?.();
    // preventDefault below also suppresses the browser's default focus-blur
    // of whatever text field was previously focused elsewhere on the page —
    // without this, that stale field stays focused and a later Delete/
    // Backspace keypress gets swallowed by the "don't delete while typing"
    // guard instead of removing this image.
    document.activeElement?.blur?.();
    e.preventDefault();
    // A focused text/caption editor's blur can synchronously commit and
    // trigger a full canvas rerender (hs/text-layers.js, hs/banner.js),
    // which tears down and rebuilds this exact wrap (and every other image
    // box) for the same underlying data — out from under this very
    // pointerdown. When the browser's mousedown target is no longer in the
    // document by mouseup, it never fires a trailing click at all (not even
    // retargeted), so nothing would otherwise select this image — the click
    // just silently vanishes. Re-find whatever image box is now under the
    // pointer (the freshly rebuilt one, still at the same screen position)
    // and dispatch a click on it directly, so its own onClick fires with
    // correctly closured, live DOM/data instead of this stale instance's.
    if (!wrap.isConnected) {
      document.elementFromPoint(e.clientX, e.clientY)?.closest('.dz-logo-wrap')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return;
    }
    dragging = true;
    moved = false;
    wrap.setPointerCapture(e.pointerId);
    startPX = e.clientX; startPY = e.clientY;
    startX = data.x; startY = data.y;
  });

  // Pointermove can fire far more often than the screen actually repaints
  // (especially trackpads/high-poll-rate mice), and every update here forces
  // a synchronous layout read (getBoundingClientRect, via clipToCanvas) right
  // after a style write — doing that once per raw input event instead of
  // once per rendered frame is what reads as "glitchy" under fast movement.
  // Coalescing to one rAF-scheduled update per frame fixes that without
  // changing the behavior, just how often it's applied.
  let dragRaf = null, latestDragEvent = null;

  function applyDragMove() {
    dragRaf = null;
    const e = latestDragEvent;
    const zoneRect = zone.getBoundingClientRect();
    const canvasRect = canvasEl.getBoundingClientRect();
    const dx = (e.clientX - startPX) / zoneRect.width * 100;
    const dy = (e.clientY - startPY) / zoneRect.height * 100;
    const bounds = canvasBoundsInZonePct(zone, canvasEl);
    let nx = Math.max(bounds.minX, Math.min(bounds.maxX, startX + dx));
    let ny = Math.max(bounds.minY, Math.min(bounds.maxY, startY + dy));

    // Snap to the zone's own center (nx/ny are already the image's center
    // point per the data-model doc above, so size=0 — a point, not a box) —
    // plus any extra candidates the caller supplied (e.g. sibling template-
    // logo slots' edges/centers, see opts.extraSnapX/extraSnapY above).
    const snapTolX = 5 / zoneRect.width * 100;
    const snapTolY = 5 / zoneRect.height * 100;
    const snapCandX = [50, ...(opts.extraSnapX || [])];
    const snapCandY = [50, ...(opts.extraSnapY || [])];
    const snapX = findAxisSnap(snapCandX, nx, 0, snapTolX);
    const snapY = findAxisSnap(snapCandY, ny, 0, snapTolY);
    if (snapX) nx = snapX.newPos;
    if (snapY) ny = snapY.newPos;

    // Guides are drawn on the whole canvas, not just this zone, so convert
    // the matched candidate's zone-relative percent into a canvas-relative
    // percent for display (falls back to the zone's own center when nothing
    // matched, same position the guide always used before extra candidates).
    const guideXPct = (zoneRect.left + ((snapX ? snapX.value : 50) / 100) * zoneRect.width - canvasRect.left) / canvasRect.width * 100 + '%';
    const guideYPct = (zoneRect.top + ((snapY ? snapY.value : 50) / 100) * zoneRect.height - canvasRect.top) / canvasRect.height * 100 + '%';
    setAlignGuide(canvasEl, 'v', !!snapX, guideXPct);
    setAlignGuide(canvasEl, 'h', !!snapY, guideYPct);

    data.x = nx; data.y = ny;
    wrap.style.left = nx + '%';
    wrap.style.top = ny + '%';
    clipToCanvas(visual, canvasEl);
    if (ghost) {
      ghost.style.left = nx + '%';
      ghost.style.top = ny + '%';
      clipToCanvas(ghost, canvasEl);
    }
  }

  // A real mouse/trackpad click almost never lands pointerdown and pointerup
  // at the exact same pixel — a couple of pixels of jitter is normal and, on
  // a captured pointer, used to unconditionally count as "the user is
  // dragging" here, which suppressed the trailing click (see below) even
  // though nothing actually moved. That silently ate ordinary taps-to-select
  // (the click event that would have fired was pre-emptively suppressed),
  // which reads as "tapping an image does nothing" — or, combined with
  // whatever it displaced getting deselected elsewhere, "tapping an image
  // deselects everything." A small dead zone (matching the resize handles'
  // own 3px one below) keeps a real click a click until the pointer has
  // actually moved enough to be a drag.
  const CLICK_MOVE_THRESHOLD = 4;

  wrap.addEventListener('pointermove', e => {
    // hasPointerCapture guards against a dropped/lost pointerup leaving
    // `dragging` stuck true — without it, the next hover-only pointermove
    // would move the box using the stale start point.
    if (!dragging || !wrap.hasPointerCapture(e.pointerId)) return;
    if (!moved) {
      const dx = e.clientX - startPX, dy = e.clientY - startPY;
      if (Math.hypot(dx, dy) < CLICK_MOVE_THRESHOLD) return;
      moved = true;
      suppressNextClick = true;
    }
    latestDragEvent = e;
    if (dragRaf == null) dragRaf = requestAnimationFrame(applyDragMove);
  });

  const stopDragging = (e, completed) => {
    if (!dragging) return;
    dragging = false;
    if (dragRaf != null) { cancelAnimationFrame(dragRaf); dragRaf = null; }
    if (moved) {
      hideAlignGuides(canvasEl);
      onCommit?.();
      return;
    }
    // Pointer never moved past the dead zone above. On a genuine release
    // (not a cancelled gesture) that means this was a tap, not a drag —
    // select right here instead of waiting on the browser's own trailing
    // click: once setPointerCapture is in play, that click is not reliable
    // (browsers can drop or misroute it), which is the actual mechanism
    // behind "tapping an image doesn't select it". Suppress the click below
    // in case the browser does still fire one for this same gesture, so
    // onClick doesn't run twice.
    if (!completed) return;
    suppressNextClick = true;
    onClick?.(e);
  };
  wrap.addEventListener('pointerup', e => stopDragging(e, true));
  wrap.addEventListener('pointercancel', e => stopDragging(e, false));

  // ── Resize ────────────────────────────────────────────────
  // Outward direction for each handle, used to project pointer movement onto
  // this handle's resize axis below — corners move on both axes, edge
  // midpoints (t/r/b/l) move on only one (the other component is 0, so
  // movement along the perpendicular axis has no effect).
  const RESIZE_DIR = {
    tl: [-1, -1], tr: [1, -1], bl: [-1, 1], br: [1, 1],
    t: [0, -1], b: [0, 1], l: [-1, 0], r: [1, 0],
  };
  corners.forEach(({ pos, el: handle }) => {
    const [dirX, dirY] = RESIZE_DIR[pos];
    let resizing = false, rStartClientX, rStartClientY, rStartW, rStartH, rDzW, rDzH;
    let rStartCenterPxX, rStartCenterPxY, rStartHalfPxW, rStartHalfPxH;
    // Same rAF-coalescing as the drag handler above: this fires on every raw
    // pointermove (which can outpace the screen's actual repaint rate) and
    // does a synchronous layout read (clipToCanvas) right after a style
    // write, so applying it once per event instead of once per frame is
    // what reads as "glitchy" resizing under fast movement.
    let resizeRaf = null, latestResizeEvent = null;

    function applyResizeMove() {
      resizeRaf = null;
      const e = latestResizeEvent;
      const dx = e.clientX - rStartClientX;
      const dy = e.clientY - rStartClientY;
      // dead-zone: ignore micro-movements
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      // Project the mouse displacement onto the box's fixed aspect-ratio
      // diagonal so the dragged point tracks the cursor 1:1. A naive per-axis
      // sum (dirX*rawDx + dirY*rawDy) double-counts corner handles, since
      // dragging along the box's own diagonal produces a dx AND a dy that
      // each independently imply the same width change.
      const boxW = rStartHalfPxW * 2;
      const boxH = rStartHalfPxH * 2;
      const denom = (dirX * dirX * boxW * boxW) + (dirY * dirY * boxH * boxH);
      let dwPx = denom ? boxW * (dx * dirX * boxW + dy * dirY * boxH) / denom : 0;
      // Cmd/Meta grows from the center (see below) instead of anchoring the
      // opposite point, so each edge only moves half as far as the total
      // width change — double it here so the dragged point still tracks the
      // cursor 1:1 in that mode too.
      if (e.metaKey) dwPx *= 2;
      const dw = dwPx / rDzW * 100;
      const nw = Math.max(minW, Math.min(maxW, rStartW + dw));
      const scale = rStartW > 0 ? nw / rStartW : 1;
      data.w = nw;
      wrap.style.width = nw + '%';
      if (ghost) ghost.style.width = nw + '%';
      // Only present when the wrap's height is explicit rather than the
      // default CSS height:auto (see the data.h doc above) — scale it by the
      // same factor as width so the box's own aspect ratio never changes.
      if (rStartH != null) {
        const nh = rStartH * scale;
        data.h = nh;
        wrap.style.height = nh + '%';
      }

      // Anchor the opposite point (corner, or edge midpoint) in place on
      // screen — height follows the image's own aspect ratio, so it scales
      // by the same factor as width. Cmd/Meta skips this and grows from the
      // center instead (x/y untouched).
      if (!e.metaKey && rStartW > 0) {
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
    }

    handle.addEventListener('pointerdown', e => {
      resizing = true;
      handle.setPointerCapture(e.pointerId);
      rStartClientX = e.clientX;
      rStartClientY = e.clientY;
      rStartW = data.w;
      rStartH = data.h;
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
      suppressNextClick = true;
      latestResizeEvent = e;
      if (resizeRaf == null) resizeRaf = requestAnimationFrame(applyResizeMove);
    });

    const stopResizing = () => {
      if (!resizing) return;
      resizing = false;
      if (resizeRaf != null) { cancelAnimationFrame(resizeRaf); resizeRaf = null; }
      onCommit?.();
    };
    handle.addEventListener('pointerup', stopResizing);
    handle.addEventListener('pointercancel', stopResizing);
  });

  wrap.addEventListener('click', e => {
    e.stopPropagation();
    if (suppressNextClick) { suppressNextClick = false; return; }
    onClick?.(e);
  });

  // Deferred so it runs after the caller has appended `wrap` to the live DOM
  // (always done synchronously, in the same tick, right after this returns)
  // — clipping now would only see a zero-size, not-yet-laid-out rect.
  requestAnimationFrame(() => { clipToCanvas(visual, canvasEl); if (ghost) clipToCanvas(ghost, canvasEl); });

  return wrap;
}
