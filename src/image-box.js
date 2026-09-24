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

// ── Cropped placed-image geometry ──────────────────────────────────────
// A cropped logo box (createImageBox's `cropped` option) shows a resizable/
// movable *window* (data.x/y/w/h, percent of zone, same as any other placed
// image) onto an image that has its OWN fixed size/position — imageBaseW/
// imageBaseH (percent of zone, set once and never touched again by a resize)
// and imageAbsX/imageAbsY (percent of zone, the image's center — moved
// rigidly along with the box on a plain drag, but otherwise untouched by a
// resize) and imageScale (percent, 100 = imageBaseW/H at 1:1, adjusted by
// the crop-edit wheel gesture). This is deliberately a different, simpler
// shape than the coverFitBox/clampPanPct/coverImgBox trio above: those
// recompute a fresh cover-fit from whatever the CURRENT container size is on
// every call (right for a background image, which has no independent size of
// its own), where this instead fixes the image's size/position so resizing
// or moving the crop window can never move or rescale the image itself —
// only pan (drag while in crop-edit mode) and zoom (wheel) do that.

// Seeds imageBaseW/imageBaseH/imageAbsX/imageAbsY/imageScale the first time a
// layer becomes cropped (a no-op once they exist) — a plain "cover the box
// as it's sized right now" default, sized from the image's natural aspect
// ratio. Reads the box's CURRENT data.w/data.h (percent of the zone's WIDTH/
// HEIGHT respectively — see cropImageRect below) once, at seed time only —
// never again afterward. zoneW/zoneH (the zone's real pixel size) are
// required to convert those two percent bases and natW/natH's raw pixel
// scale into one common unit before comparing them — data.w/data.h and
// natW/natH are otherwise NOT directly comparable numbers (a percent isn't a
// pixel, and "percent of width" isn't "percent of height" unless the zone
// happens to be square), so skipping this conversion silently produces a
// wildly wrong cover scale for any image/zone combination where those don't
// happen to already match up — most visible on a naturally wide/short
// logotype (many vector logos; a raster export is more often pre-padded
// close to square) forced into the square default below.
export function initCropImageGeometry(data, natW, natH, zoneW, zoneH) {
  if (data.imageBaseW != null && data.imageBaseH != null) return;
  const boxW = data.w / 100 * zoneW, boxH = data.h / 100 * zoneH;
  const scale = Math.max(boxW / natW, boxH / natH);
  data.imageBaseW = natW * scale / zoneW * 100;
  data.imageBaseH = natH * scale / zoneH * 100;
  data.imageAbsX = data.x;
  data.imageAbsY = data.y;
  data.imageScale = 100;
}

// The image's absolute rect in whatever consistent unit `unitW`/`unitH`
// (percent-of-zone converted into) represent — px for the live canvas
// (zoneRect.width/height), sign/viewBox units for the SVG exporters (zone.w/
// zone.h) — same "percent of zone, converted by the caller" convention
// data.x/data.y/data.w/data.h already use for the box itself.
export function cropImageRect(data, unitW, unitH) {
  const scale = (data.imageScale ?? 100) / 100;
  const w = (data.imageBaseW ?? 0) / 100 * unitW * scale;
  const h = (data.imageBaseH ?? 0) / 100 * unitH * scale;
  const cx = (data.imageAbsX ?? 50) / 100 * unitW;
  const cy = (data.imageAbsY ?? 50) / 100 * unitH;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
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
    // cropped: the box's w/h independently of the image's own aspect ratio
    // (unlike the default locked-image-aspect sizing), and the image inside
    // it has its OWN fixed geometry (imageBaseW/imageBaseH/imageAbsX/
    // imageAbsY/imageScale — see initCropImageGeometry/cropImageRect below).
    // Resizing the box behaves differently depending on whether the box is
    // currently in crop-edit mode (double-click, or the crop hover button —
    // see enterCropEdit further down):
    //   - IN crop-edit mode, each axis resizes independently (an edge handle
    //     only touches its own axis) and the image's geometry is untouched —
    //     this is what actually redefines the crop, revealing more/less of a
    //     visually fixed image.
    //   - NOT in crop-edit mode — the crop is already dialed in — resizing
    //     instead scales the WHOLE cropped picture as one rigid unit (locked
    //     aspect, same diagonal-projected math as a plain image box), moving
    //     the image's geometry in lockstep so nothing re-crops.
    // Only an explicit pan (drag) or zoom (wheel) while IN crop-edit mode
    // otherwise changes the image's geometry. This is deliberately NOT the
    // same model as the hole-sign background/banner cover-fit pan/zoom
    // (coverFitBox/clampPanPct/coverImgBox above), which recomputes fresh
    // from the CURRENT container size on every call — right for a
    // background (nothing to "resize" independently of its container), but
    // for a crop box it would mean the image rescales/reflows every time the
    // box itself is resized, instead of staying fixed while a different
    // amount of it shows through the crop window. onCropChange fires after
    // every pan/zoom/scale-in-lockstep adjustment so the caller can
    // markDirty/redraw. onEnableCrop fires on a double-click of a NOT-yet-
    // cropped image — the caller's job is to set data.cropped = true and
    // re-render (createImageBox can't switch a box from the plain <img>
    // visual to the cropbox one after the fact); see enterCropEditOn below
    // for resuming straight into crop-edit mode on the fresh box.
    cropped = false, zoneSignW, zoneSignH, onCropChange, onEnableCrop,
  } = opts;

  const wrap = document.createElement('div');
  wrap.className = 'dz-logo-wrap' + (aboveFrame ? ' above-frame' : '');
  wrap.style.left = data.x + '%';
  wrap.style.top = data.y + '%';
  wrap.style.width = data.w + '%';
  // A square percent box (data.h = data.w) is just a placeholder until the
  // image's natural size is known — see the `cropped` branch below, which
  // corrects it (before the user ever sees it, when cached; in the very next
  // paint otherwise) to actually match the image's aspect ratio, so entering
  // crop mode never itself resizes/zooms the image.
  let pendingSquareHeight = false;
  if (cropped && data.h == null) { data.h = data.w; pendingSquareHeight = true; }
  if (data.h != null) wrap.style.height = data.h + '%';

  let visual, ghost = null, layoutCrop = null, cropRo = null;
  let editingCrop = false, enterCropEdit = null;
  // Set by the pan gesture in the shared pointerdown handler below, cleared
  // there on pointerup — exitCropEditLocal reaches into these (not local to
  // that handler) so exiting mid-drag (e.g. via Escape) actually cancels an
  // in-progress pan instead of leaving a stale listener updating data.
  // imageAbsX/imageAbsY after the box has visually left crop-editing.
  let panMoveFn = null, panUpFn = null;
  if (visualEl) {
    wrap.appendChild(visualEl);
    visual = visualEl;
  } else if (isDisplayableImage(src) && cropped) {
    // A src change (e.g. the "Replace" toolbar action swapping in a
    // different logo) invalidates any cached natural size AND the crop
    // geometry derived from it — otherwise the new image would render
    // cropped using the old logo's framing until something else happened to
    // clear it.
    if (data.imageUrl && data.imageUrl !== src) {
      data.imageNaturalW = null;
      data.imageNaturalH = null;
      data.imageBaseW = null;
      data.imageBaseH = null;
    }
    data.imageUrl = src;
    const cropbox = document.createElement('div');
    cropbox.className = 'dz-logo-cropbox';
    const thumb = document.createElement('img');
    thumb.className = 'dz-logo-crop-thumb';
    thumb.alt = '';
    thumb.draggable = false;
    thumb.src = src;
    cropbox.appendChild(thumb);
    wrap.appendChild(cropbox);
    visual = cropbox;

    // Bleed layer — a full, dimmed copy of the SAME image at its actual
    // position/size, shown ONLY in crop-edit mode (see enterCropEdit below)
    // so the part that will be clipped away is still visible while adjusting
    // (the classic "picture extends past its frame" crop-tool look). Lives
    // as its own absolutely-positioned <img>, sized/positioned identically
    // to `thumb` but outside the cropbox's overflow:hidden, specifically so
    // it CAN paint past the crop window.
    const bleedWrap = document.createElement('div');
    bleedWrap.className = 'dz-logo-crop-bleed';
    const bleedImg = document.createElement('img');
    bleedImg.alt = '';
    bleedImg.draggable = false;
    bleedImg.src = src;
    bleedWrap.appendChild(bleedImg);
    wrap.appendChild(bleedWrap);

    // Lays out `thumb`/`bleedImg` in px, relative to `wrap`'s own box, from
    // the image's fixed geometry (data.imageAbsX/imageAbsY/imageBaseW/
    // imageBaseH/imageScale, all percent-of-zone — same convention as data.x/
    // data.y/data.w already use) — NOT from the box's current size, which is
    // exactly what keeps a box resize from moving/rescaling the image (see
    // the `cropped` doc above). Reads real layout rects (zone/wrap) rather
    // than assuming any fixed px-per-percent, same as applyDragMove already
    // does elsewhere in this function.
    layoutCrop = () => {
      if (!data.imageBaseW || !data.imageBaseH || !wrap.isConnected) return;
      const zoneRect = zone.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      if (!zoneRect.width || !zoneRect.height) return;
      const rect = cropImageRect(data, zoneRect.width, zoneRect.height);
      const left = rect.x - (wrapRect.left - zoneRect.left);
      const top = rect.y - (wrapRect.top - zoneRect.top);
      [thumb, bleedImg].forEach(img => {
        img.style.left = left + 'px';
        img.style.top = top + 'px';
        img.style.width = rect.w + 'px';
        img.style.height = rect.h + 'px';
      });
    };
    // The image's fixed geometry doesn't exist yet on a freshly-cropped
    // layer — seed it once (a plain "cover the box as it's sized right now"
    // default) from the image's natural aspect ratio, backfilling that
    // aspect ratio itself first if this is also the first time this image's
    // size has ever been needed (mirrors loadNaturalImgSize's use elsewhere
    // in this file for the exact same "not captured yet" case).
    //
    // If the box's height was only just defaulted to a square (see
    // pendingSquareHeight above), replace it here with the height that
    // actually matches the image's aspect ratio — through the zone's real
    // pixel size, same as initCropImageGeometry itself needs (data.w/data.h
    // are percent of the zone's width/height respectively, not a common
    // scale) — so the box the user sees always matches the image's own
    // shape at the moment crop is first enabled, instead of an arbitrary
    // square that the (dimensionally-corrected) cover-fit would then have to
    // zoom dramatically to fill.
    const fixPendingHeight = (natW, natH, zoneRect) => {
      if (!pendingSquareHeight) return;
      data.h = data.w * (zoneRect.width / zoneRect.height) * (natH / natW);
      wrap.style.height = data.h + '%';
    };
    // Seeding needs the ZONE's real pixel size (see initCropImageGeometry),
    // but this whole box (and often its ancestor zone/svg too) is still
    // being built off-document at this point in a fresh render — `wrap` and
    // `zone` don't become part of the live, laid-out DOM until the caller
    // appends the tree this box is part of, sometime after createImageBox
    // returns. Seeding here regardless (using whatever getBoundingClientRect
    // reports right now — reliably all-zero while disconnected) would bake
    // in a divide-by-zero NaN forever, since initCropImageGeometry only ever
    // seeds once (data.imageBaseW/H != null short-circuits every later
    // call). So try seeding immediately (succeeds if this happens to be a
    // re-render of an already-connected box), and otherwise let the
    // ResizeObserver below retry once `wrap` actually gets connected and
    // laid out — which, same as any ResizeObserver callback, still lands
    // before the next paint, so there's nothing to visibly flash even
    // though the seed didn't land on the very first attempt.
    let geometrySeeded = false;
    const seedGeometryIfReady = () => {
      if (geometrySeeded || !data.imageNaturalW || !data.imageNaturalH) return;
      const zoneRect = zone.getBoundingClientRect();
      if (!zoneRect.width || !zoneRect.height) return;
      geometrySeeded = true;
      fixPendingHeight(data.imageNaturalW, data.imageNaturalH, zoneRect);
      initCropImageGeometry(data, data.imageNaturalW, data.imageNaturalH, zoneRect.width, zoneRect.height);
      layoutCrop();
      onCropChange?.();
    };
    if (!data.imageNaturalW || !data.imageNaturalH) {
      loadNaturalImgSize(src, (natW, natH) => {
        data.imageNaturalW = natW;
        data.imageNaturalH = natH;
        seedGeometryIfReady();
      });
    }
    seedGeometryIfReady();
    // Catches container-size changes this box's own resize handles didn't
    // cause (an editor zoom-level change, a window resize), AND is what
    // actually completes the geometry seed above on a fresh (first-ever)
    // crop, once `wrap` is connected and has a real size — the resize
    // handlers below already call layoutCrop() directly after their own
    // moves, same as clipToCanvas/refreshImageBoxClips do for the clip-path.
    cropRo = new ResizeObserver(() => { seedGeometryIfReady(); layoutCrop(); });
    cropRo.observe(wrap);

    // ── Crop-edit mode ──────────────────────────────────────────────────
    // Double-click enters/exits it (see the dblclick listener further
    // below); while active, dragging directly on the image pans it within
    // the fixed crop window (Option/Alt+drag instead moves the whole box+
    // image together, same as a plain non-crop drag) and Option/Alt+wheel
    // zooms it (a plain wheel is left alone, so the canvas's own ⌘+scroll
    // zoom still works normally over an active crop box) — same math as the
    // box-move/resize handlers elsewhere in this function, just targeting
    // imageX/imageY/imageScale instead of data.x/y/w. The resize handles
    // keep working unchanged throughout (they're wired on the handle
    // elements, not on wrap), so the box's own corners double as the crop's
    // bounding-box handles the whole time; hold Shift on a handle to resize
    // without changing the box's own aspect ratio.
    const exitCropEditLocal = () => {
      editingCrop = false;
      wrap.classList.remove('crop-editing');
      if (panMoveFn) { wrap.removeEventListener('pointermove', panMoveFn); panMoveFn = null; }
      if (panUpFn) { wrap.removeEventListener('pointerup', panUpFn); panUpFn = null; }
    };
    enterCropEdit = () => {
      exitCropEdit();
      editingCrop = true;
      wrap.classList.add('crop-editing');
      layoutCrop();
      _activeCropEdit = { wrap, exit: exitCropEditLocal };
    };
    wrap._enterCropEdit = enterCropEdit;
    ensureCropEditDocListener();

    wrap.addEventListener('wheel', e => {
      // Only Option/Alt+wheel zooms the image — a plain wheel (or ⌘+wheel,
      // the canvas's own zoom gesture) is left untouched and unpreventDefault-
      // ed so it reaches whatever handles canvas zoom normally, even while
      // this box happens to be in crop-edit mode underneath the cursor.
      if (!editingCrop || !e.altKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -5 : 5;
      data.imageScale = Math.max(20, Math.min(400, (data.imageScale ?? 100) + delta));
      layoutCrop();
      onCropChange?.();
    });

    wrap.addEventListener('dblclick', e => {
      if (isCorner(e.target) || e.target.closest('.dz-logo-hover-actions')) return;
      e.stopPropagation();
      e.preventDefault();
      if (editingCrop) exitCropEdit();
      else enterCropEdit();
    });
  } else if (isDisplayableImage(src)) {
    const img = document.createElement('img');
    img.className = 'placed-img';
    img.src = src;
    img.alt = alt;
    img.draggable = false;
    // The natural size (and so the rendered height, since height:auto) isn't
    // known until the image loads — clipping any earlier would use a stale
    // (often zero) rect.
    img.addEventListener('load', () => {
      clipToCanvas(img, canvasEl); if (ghost) clipToCanvas(ghost, canvasEl);
      // Opportunistically cache the natural size on `data` while this image
      // is shown plain (uncropped) — if crop is enabled on this same layer
      // later (see the `cropped` branch above, and its data.imageNaturalW/H
      // check), it can seed the crop geometry synchronously instead of
      // loading the image a second time. Without this, that second load is
      // async, so the freshly-cropped box first paints with a placeholder
      // square (see pendingSquareHeight above) and only snaps to the
      // image's real aspect ratio/position once that load resolves — a
      // visible flash/jump right as crop mode is entered. Always overwrite
      // (not just when unset) so a "Replace" that swaps `src` while the
      // layer is still uncropped can't leave the previous image's now-stale
      // size cached for whenever crop eventually gets enabled.
      data.imageNaturalW = img.naturalWidth;
      data.imageNaturalH = img.naturalHeight;
    });
    wrap.appendChild(img);
    visual = img;

    if (onEnableCrop) {
      wrap.addEventListener('dblclick', e => {
        e.stopPropagation();
        e.preventDefault();
        onEnableCrop();
      });
    }

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

  if (onRemove || enterCropEdit) {
    const actions = document.createElement('div');
    actions.className = 'dz-logo-hover-actions';
    if (enterCropEdit) {
      // Same as double-clicking the image — an explicit, discoverable
      // affordance for the same in-place crop-edit mode.
      const cropBtn = document.createElement('button');
      cropBtn.type = 'button';
      cropBtn.className = 'dz-logo-mini-btn dz-logo-mini-crop';
      cropBtn.title = 'Adjust crop';
      cropBtn.innerHTML = '<i class="fa-solid fa-crop-simple" aria-hidden="true"></i>';
      cropBtn.addEventListener('click', e => { e.stopPropagation(); enterCropEdit(); });
      actions.appendChild(cropBtn);
    }
    if (onRemove) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'dz-logo-mini-btn dz-logo-mini-remove';
      removeBtn.title = 'Remove';
      removeBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
      removeBtn.addEventListener('click', e => { e.stopPropagation(); onRemove(); });
      actions.appendChild(removeBtn);
    }
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
  // Only used when `cropped` — the image's own abs position at drag-start,
  // so applyDragMove can carry it along by the box's exact applied delta
  // (post-snap/clamp), keeping image and box moving as one rigid unit
  // instead of the image staying fixed in the zone while the box slides
  // over it (that's what a *resize* does instead — see the resize handler).
  let dragImageAbsX0, dragImageAbsY0;
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

    // Crop-edit mode redefines what dragging on the image does — a plain
    // drag pans the image within the fixed crop window (the resize handles
    // are what redefines the window itself; Option/Alt+wheel is what zooms
    // the image within it), while Option/Alt+drag instead moves the box AND
    // the image together, as one rigid unit, same as a plain non-cropped
    // drag would. Both are usable in the same crop-edit session this way,
    // without switching gestures or leaving crop-edit mode in between. A
    // totally separate gesture from the drag-to-move below (its own pointer
    // capture/move/up), since the two are mutually exclusive for the
    // duration of one pointerdown.
    if (editingCrop) {
      suppressNextClick = true;
      wrap.setPointerCapture(e.pointerId);
      const x0 = e.clientX, y0 = e.clientY;
      const ix0 = data.imageAbsX ?? data.x, iy0 = data.imageAbsY ?? data.y;
      const bx0 = data.x, by0 = data.y;
      // Percent-of-ZONE (same convention as data.imageAbsX/Y and data.x/y
      // themselves) — not percent-of-box, which would make the drag
      // distance depend on the crop box's own current size.
      const zoneRect = zone.getBoundingClientRect();
      const onPanMove = ev => {
        const dx = (ev.clientX - x0) / zoneRect.width * 100;
        const dy = (ev.clientY - y0) / zoneRect.height * 100;
        if (ev.altKey) {
          // Move the whole cropped picture (box + image) together, same as
          // a plain non-crop drag — the image's own delta is carried along
          // by the box's ACTUAL applied delta (post-clamp), same idea as
          // applyDragMove's cropped branch for a plain move.
          const bounds = canvasBoundsInZonePct(zone, canvasEl);
          const nx = Math.max(bounds.minX, Math.min(bounds.maxX, bx0 + dx));
          const ny = Math.max(bounds.minY, Math.min(bounds.maxY, by0 + dy));
          data.imageAbsX = ix0 + (nx - bx0);
          data.imageAbsY = iy0 + (ny - by0);
          data.x = nx;
          data.y = ny;
          wrap.style.left = nx + '%';
          wrap.style.top = ny + '%';
        } else {
          // Plain drag: pan the image within the box — the box itself
          // (data.x/data.y) never moves, only what the fixed window shows.
          data.imageAbsX = ix0 + dx;
          data.imageAbsY = iy0 + dy;
        }
        layoutCrop();
        clipToCanvas(visual, canvasEl);
        onCropChange?.();
      };
      const onPanUp = () => {
        wrap.removeEventListener('pointermove', onPanMove);
        wrap.removeEventListener('pointerup', onPanUp);
        panMoveFn = null;
        panUpFn = null;
      };
      panMoveFn = onPanMove;
      panUpFn = onPanUp;
      wrap.addEventListener('pointermove', onPanMove);
      wrap.addEventListener('pointerup', onPanUp);
      return;
    }

    dragging = true;
    moved = false;
    wrap.setPointerCapture(e.pointerId);
    startPX = e.clientX; startPY = e.clientY;
    startX = data.x; startY = data.y;
    dragImageAbsX0 = data.imageAbsX; dragImageAbsY0 = data.imageAbsY;
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
    // Carry the image along by the box's ACTUAL applied delta (post-snap/
    // clamp, not the raw pointer delta) — this is a plain reposition of the
    // whole placed logo, not a resize, so image and box move as one rigid
    // unit. layoutCrop() only needs to recompute the DOM px position here
    // (not the image's own data), since dragging never changes anything
    // about the box's size that the layout math depends on.
    if (data.imageBaseW != null) {
      data.imageAbsX = dragImageAbsX0 + (nx - startX);
      data.imageAbsY = dragImageAbsY0 + (ny - startY);
      layoutCrop?.();
    }
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
      // Fired only now (not on pointerdown) so it stays symmetric with
      // onCommit below, which likewise only fires when a drag actually
      // happened — onStart hides the toolbar for the duration of a real
      // drag, and a plain tap/click (no onStart call) never hides it, so
      // there's nothing selecting-only code needs to undo.
      onStart?.();
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
    // Only used when cropped and NOT in crop-edit mode — see the scale-in-
    // lockstep branch in applyResizeMove below.
    let rStartImageScale, rStartImageAbsX, rStartImageAbsY;
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

      if (cropped && editingCrop) {
        // Only while actively in crop-edit mode does resizing redefine the
        // crop window itself — each axis resizes independently instead of
        // being projected onto a locked diagonal (an edge handle only ever
        // touches its own axis), and the image's own geometry is left alone
        // (see the cropped doc above), so a bigger/smaller box just reveals
        // more/less of the same fixed image. Outside crop-edit mode (the
        // `cropped` branch further below, sharing the default locked-aspect
        // path with template-logo slots) resizing instead scales the WHOLE
        // already-cropped picture as one unit — no more independent-axis
        // resize once the crop itself is dialed in and confirmed.
        let dwPx = dirX !== 0 ? dirX * dx : 0;
        let dhPx = dirY !== 0 ? dirY * dy : 0;
        if (e.metaKey) { dwPx *= 2; dhPx *= 2; }
        let nw, nh;
        if (e.shiftKey && rStartW > 0 && rStartH > 0) {
          // Preserve the box's own aspect ratio instead of resizing each
          // axis independently — a corner handle drives both axes at once,
          // so use whichever one the pointer actually moved further to
          // decide the scale (the other axis, driven by dirX/dirY === 0 on
          // an edge handle, always contributes 0 here and just falls out).
          const scaleW = 1 + (dwPx / rDzW * 100) / rStartW;
          const scaleH = 1 + (dhPx / rDzH * 100) / rStartH;
          const scale = Math.abs(dwPx) >= Math.abs(dhPx) ? scaleW : scaleH;
          nw = Math.max(minW, Math.min(maxW, rStartW * scale));
          nh = Math.max(minW, Math.min(maxW, rStartH * scale));
        } else {
          nw = Math.max(minW, Math.min(maxW, rStartW + dwPx / rDzW * 100));
          nh = Math.max(minW, Math.min(maxW, rStartH + dhPx / rDzH * 100));
        }
        data.w = nw;
        data.h = nh;
        wrap.style.width = nw + '%';
        wrap.style.height = nh + '%';
        if (!e.metaKey) {
          const halfPxW = (nw / 100 * rDzW) / 2;
          const halfPxH = (nh / 100 * rDzH) / 2;
          const cx = rStartCenterPxX + dirX * (halfPxW - rStartHalfPxW);
          const cy = rStartCenterPxY + dirY * (halfPxH - rStartHalfPxH);
          const bounds = canvasBoundsInZonePct(zone, canvasEl);
          data.x = Math.max(bounds.minX, Math.min(bounds.maxX, (cx / rDzW) * 100));
          data.y = Math.max(bounds.minY, Math.min(bounds.maxY, (cy / rDzH) * 100));
          wrap.style.left = data.x + '%';
          wrap.style.top = data.y + '%';
        }
        layoutCrop?.();
        clipToCanvas(visual, canvasEl);
        return;
      }
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
      // Cropped, but NOT in crop-edit mode (that path returned early above)
      // — the crop itself is already dialed in, so resizing now scales the
      // whole already-cropped picture as one rigid unit instead of
      // redefining what's visible: the image's own size (imageScale) scales
      // by the exact same factor as the box, and its center is scaled away
      // from/toward the same anchor point the box itself resizes from (the
      // fixed opposite corner/edge, or the box's own center under Cmd/Meta),
      // so image and box move together exactly as they visually appear to.
      if (cropped) {
        const anchorPxX = e.metaKey ? rStartCenterPxX : rStartCenterPxX - dirX * rStartHalfPxW;
        const anchorPxY = e.metaKey ? rStartCenterPxY : rStartCenterPxY - dirY * rStartHalfPxH;
        const imgCenterPxX0 = (rStartImageAbsX / 100) * rDzW;
        const imgCenterPxY0 = (rStartImageAbsY / 100) * rDzH;
        data.imageAbsX = (anchorPxX + (imgCenterPxX0 - anchorPxX) * scale) / rDzW * 100;
        data.imageAbsY = (anchorPxY + (imgCenterPxY0 - anchorPxY) * scale) / rDzH * 100;
        data.imageScale = Math.max(10, Math.min(2000, rStartImageScale * scale));
        layoutCrop?.();
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
      rStartImageScale = data.imageScale;
      rStartImageAbsX = data.imageAbsX;
      rStartImageAbsY = data.imageAbsY;
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

  // Arrow-key nudge — moves the box by a real on-screen pixel delta (not a
  // fixed percent), converting through the zone's live rect the same way
  // applyDragMove does, and clamped to the same canvas bounds. Unlike a drag,
  // each call is already one complete, discrete step, so it commits (and
  // carries the crop image along, same as applyDragMove) immediately rather
  // than waiting for a separate pointerup.
  wrap._nudge = function nudgeBox(dxPx, dyPx) {
    const zoneRect = zone.getBoundingClientRect();
    if (!zoneRect.width || !zoneRect.height) return;
    const bounds = canvasBoundsInZonePct(zone, canvasEl);
    const nx = Math.max(bounds.minX, Math.min(bounds.maxX, data.x + dxPx / zoneRect.width * 100));
    const ny = Math.max(bounds.minY, Math.min(bounds.maxY, data.y + dyPx / zoneRect.height * 100));
    const dxPct = nx - data.x, dyPct = ny - data.y;
    data.x = nx; data.y = ny;
    wrap.style.left = nx + '%';
    wrap.style.top = ny + '%';
    if (data.imageBaseW != null) {
      data.imageAbsX += dxPct;
      data.imageAbsY += dyPct;
      layoutCrop?.();
    }
    clipToCanvas(visual, canvasEl);
    if (ghost) {
      ghost.style.left = nx + '%';
      ghost.style.top = ny + '%';
      clipToCanvas(ghost, canvasEl);
    }
    onCommit?.();
  };

  return wrap;
}

// ── Crop-edit mode (in-place, on-canvas) ────────────────────────────────
// Only one box is ever in crop-edit mode at a time. A single module-level
// document listener (guarded so it's only ever registered once, no matter
// how many cropped boxes get created/torn down across re-renders) closes
// whichever one is active on an outside click, Escape, or Enter — see
// createImageBox's cropped-mode dblclick handler for how a box enters it.
let _activeCropEdit = null;
let _cropEditDocListenerAdded = false;

function exitCropEdit() {
  _activeCropEdit?.exit();
  _activeCropEdit = null;
}

function ensureCropEditDocListener() {
  if (_cropEditDocListenerAdded) return;
  _cropEditDocListenerAdded = true;
  document.addEventListener('pointerdown', e => {
    if (_activeCropEdit && !_activeCropEdit.wrap.contains(e.target)) exitCropEdit();
  }, true);
  document.addEventListener('keydown', e => {
    if (!_activeCropEdit) return;
    // Enter "saves" the crop (same as double-clicking again or clicking
    // away — there's nothing to actually commit beyond exiting, since every
    // pan/zoom/resize during the gesture already wrote straight to `data`).
    // Guarded like the rest of the app's global Delete/Backspace handling so
    // Enter still submits an open text field instead of being hijacked here.
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    if (document.activeElement?.closest?.('input, textarea, select, [contenteditable]')) return;
    exitCropEdit();
  });
}

// Resumes crop-edit mode on a freshly re-rendered box — for the "double-click
// a not-yet-cropped image" path, where the caller has to set data.cropped =
// true and rebuild the whole box (createImageBox can't switch a live box's
// visual from a plain <img> to the cropbox one) before there's anything to
// enter edit mode on. Call this with the new box's wrap right after that
// rebuild; a no-op on any wrap that wasn't built with `cropped: true`.
export function enterCropEditOn(wrapEl) {
  wrapEl?._enterCropEdit?.();
}
