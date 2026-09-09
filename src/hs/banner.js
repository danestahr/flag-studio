import { HS, UI, eyedropperBtn, getEffectiveState, getEffectiveVariation } from './state.js';
import { renderStep1, updateStep1Preview, stripSlotImages, repositionToolbar } from './design.js';
import { hideHsToolbar } from './logo-utils.js';
import { deselectTlSlots, ensureTlSlots, snapTlSlotsToDefaults, tlSource } from './template-logos.js';
import { beginQuickEdit, renderEditor } from './var-editor.js';
import { renderVariationPreview } from './var-canvas.js';
import { saveDraftInternal } from './draft.js';
import { HS_BANNER_DEFAULT_H, HS_BANNER_MAX_H, HS_BANNER_MIN_H, HS_BANNER_MIN_SPACING, HS_FONTS, HS_H, HS_MARGIN, HS_W, emptyBanner } from '../hole-sign-data.js';
import { bannerFitHeight, dockedLayerPositions, dockedLayers, getBannerRect, getLogoZone, getTemplateLogoSlots, getTextRegions, renderHoleSignInto } from '../hole-sign-render.js';
import { textLayerSource } from './text-layers.js';
import { uploadLogo } from '../supabase.js';
import { logoThumbHtml } from '../media-utils.js';
import { commitActiveCanvasEdit } from '../dom-utils.js';
import { clampPanToBg, layoutImgDragThumb, loadNaturalImgSize } from '../image-box.js';

// Clears a selected (not necessarily editing) band-caption zone — the
// reverse of deselectTlSlots(), called from design.js's template-logo
// onClick so a selected banner caption and a selected image stay mutually
// exclusive on this canvas. A plain `window.*` global, not an ES export,
// since design.js already gets imported by this module — importing this
// module back into design.js would be circular.
window.deselectBandZones = function () {
  document.getElementById('hsBandToolbar')?.remove();
  if (!UI.canvasSelectedKind) return;
  UI.canvasSelectedKind = null;
  document.querySelectorAll('.canvas-edit-zone').forEach(z => z.classList.remove('selected'));
};

// Debounced autosave for banner edits made directly on Step 1 (HS.bannerTop/
// HS.bannerBottom) — e.g. via the panel auto-opened by tapping a banner on
// the canvas. Only applies there: while a per-variation draft is being
// edited (HS.editingVarId/editingDraft), saveDraftInternal() wouldn't persist
// the draft anyway (see draft.js) — that path is committed explicitly via
// applyEditVar()/the full editor's own save, not autosaved here.
let bannerAutosaveTimer = null;
function scheduleBannerAutosave() {
  clearTimeout(bannerAutosaveTimer);
  bannerAutosaveTimer = setTimeout(() => {
    saveDraftInternal().then(() => {
      const el = document.getElementById('saveStatus');
      if (el) { el.textContent = 'Saved'; setTimeout(() => { el.textContent = ''; }, 1500); }
    }).catch(() => {});
  }, 600);
}

// ── Banner controls ───────────────────────────────────────
// Like tlSource(): Step 1 edits HS.bannerTop/HS.bannerBottom; the per-variation
// editor edits HS.editingDraft.bannerTop/bannerBottom.
// `which` is 'top' | 'bottom'.
export function bannerSource(which = 'top') {
  const key = which === 'bottom' ? 'bannerBottom' : 'bannerTop';
  if (HS.editingVarId && HS.editingDraft) {
    HS.editingDraft[key] = HS.editingDraft[key] || emptyBanner();
    return HS.editingDraft[key];
  }
  HS[key] = HS[key] || emptyBanner();
  return HS[key];
}

export function redrawBannerStructural() {
  // UI.hsFullEditorOpen distinguishes the full pencil-editor session from a
  // quick-edit draft (see beginQuickEdit in var-editor.js) — the latter also
  // sets HS.editingVarId but must not pop the side-panel editor open.
  if (UI.hsFullEditorOpen) { renderEditor(); renderVariationPreview(); }
  else if (HS.editingVarId) { renderVariationPreview(); }
  else { renderStep1(); scheduleBannerAutosave(); }
}
export function redrawBannerPreview() {
  if (HS.editingVarId) renderVariationPreview();
  else { updateStep1Preview(); scheduleBannerAutosave(); }
}

// Same list buildBackgroundSection() (design.js) offers for the main sign
// background image, mirrored here for banner background images.
const HS_BLEND_MODES = ['normal','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','color','luminosity'];

// The banner's true (sign-unit) container dimensions — full sign width x
// its current effective height. Used both for the drag/zoom preview's
// aspect ratio (so a drag there maps onto the same crop the real render
// produces) and, more importantly, as the exact clamp bounds for the image
// pan itself (see clampPanToBg/layoutImgDragThumb in image-box.js) — a
// rendered pixel measurement of the preview widget would do for the aspect
// ratio, but carries enough rounding error on a very short/wide banner to
// silently cut the clamp a hair short of the image's actual edge.
function bannerContainerDims(which) {
  const state = getEffectiveState(HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null);
  const rect = getBannerRect(state, which);
  return rect ? { w: rect.w, h: rect.h } : null;
}

export function renderBannerSection(which) {
  const b = bannerSource(which);
  const label = which === 'top' ? 'Top banner' : 'Bottom banner';
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  const enabled = !!b.enabled;
  const bannerRect = enabled ? bannerContainerDims(which) : null;

  const toggle = `
    <div class="hs-section">
      <div class="tl-row">
        <div class="hs-section-title">${label}</div>
        <label class="tl-switch"><input type="checkbox"${enabled ? ' checked' : ''} onchange="setBannerEnabled('${which}',this.checked)"><span class="tl-switch-slider"></span></label>
      </div>
    </div>`;
  if (!enabled) return toggle;

  const bg = b.bg || {};
  let bgControls;
  if (bg.type === 'image') {
    if (bg.imageUrl) {
      const imgOp = bg.imageOpacity ?? 100;
      const overlayOn = !!bg.overlayEnabled;
      const overlayColor = bg.overlayColor || '#000000';
      const overlayOp = bg.overlayOpacity ?? 50;
      const tintControls = `
        <div class="tl-row" style="margin-top:10px">
          <div class="tl-row-label">Opacity</div>
          <div class="tl-size-slider">
            <input type="range" min="0" max="100" value="${imgOp}" oninput="setBannerImgOpacity('${which}',this.value)">
            <span class="tl-size-value" id="hsBanner${cap}ImgOpLbl">${imgOp}%</span>
          </div>
        </div>
        <div class="tl-row">
          <div class="tl-row-label">Greyscale</div>
          <label class="tl-switch"><input type="checkbox"${bg.imageGreyscale ? ' checked' : ''} onchange="setBannerImgGreyscale('${which}',this.checked)"><span class="tl-switch-slider"></span></label>
        </div>
        <div class="tl-row" style="margin-top:10px">
          <div class="tl-row-label" style="font-size:12px;font-weight:600;color:var(--black)">Color overlay</div>
          <label class="tl-switch"><input type="checkbox"${overlayOn ? ' checked' : ''} onchange="setBannerOverlayEnabled('${which}',this.checked)"><span class="tl-switch-slider"></span></label>
        </div>
        ${overlayOn ? `
        <div class="color-row" style="margin-top:6px">
          <input type="color" class="hs-color-swatch" id="hsBanner${cap}OvColorSwatch" value="${overlayColor}" oninput="setBannerOverlayColor('${which}',this.value)">
          <input type="text" class="hexin" style="flex:1" maxlength="7" value="${overlayColor}" oninput="setBannerOverlayColorHex('${which}',this.value)" placeholder="#000000">
          ${eyedropperBtn('hsBanner' + cap + 'OvColorSwatch')}
        </div>
        <div class="tl-row">
          <div class="tl-row-label">Amount</div>
          <div class="tl-size-slider">
            <input type="range" min="0" max="100" value="${overlayOp}" oninput="setBannerOverlayOpacity('${which}',this.value)">
            <span class="tl-size-value" id="hsBanner${cap}OvOpLbl">${overlayOp}%</span>
          </div>
        </div>
        <div class="tl-row">
          <div class="tl-row-label">Blend</div>
          <select class="hs-editor-select" style="flex:1" onchange="setBannerOverlayBlend('${which}',this.value)">
            ${HS_BLEND_MODES.map(m => `<option value="${m}"${(bg.overlayBlend || 'normal') === m ? ' selected' : ''}>${m.charAt(0).toUpperCase() + m.slice(1).replace(/-/g,' ')}</option>`).join('')}
          </select>
        </div>` : ''}`;
      const bannerAspect = bannerRect ? `${bannerRect.w}/${bannerRect.h}` : `${HS_W}/${HS_BANNER_DEFAULT_H}`;
      bgControls = `
        <div class="hs-img-drag-wrap" id="bannerImgWrap${cap}" style="aspect-ratio:${bannerAspect}"
             onpointerdown="bannerImgDragStart(event,'${which}')"
             onwheel="bannerImgWheel(event,'${which}')">
          <div class="hs-img-drag-thumb" id="bannerImgThumb${cap}"
               style="background-image:url('${bg.imageUrl.replace(/'/g,'%27')}')"></div>
          <div class="hs-img-drag-hint">Drag to reposition · Scroll to scale</div>
        </div>
        <button class="btn sm" style="margin-top:6px" onclick="removeBannerImage('${which}')">Remove image</button>
        ${tintControls}`;
      // Deferred so the wrap has been inserted (and laid out via the
      // aspect-ratio above) by the time this reads its actual pixel size.
      // The onNaturalSizeLoaded callback only ever fires for an image
      // saved before natural-size capture existed (see layoutImgDragThumb)
      // — redraw once it backfills so the canvas picks up the image's real
      // pan range too, not just this thumb.
      {
        const dims = bannerRect || { w: HS_W, h: HS_BANNER_DEFAULT_H };
        requestAnimationFrame(() => layoutImgDragThumb(document.getElementById('bannerImgWrap' + cap), document.getElementById('bannerImgThumb' + cap), bg, dims.w, dims.h, redrawBannerPreview));
      }
    } else {
      bgControls = `
        <div style="margin-top:4px">
          <button class="btn sm" onclick="document.getElementById('hsBanner${cap}ImgFile').click()">Upload image</button>
          <input type="file" id="hsBanner${cap}ImgFile" accept="image/*" style="display:none" onchange="handleBannerImageUpload('${which}',event)">
        </div>`;
    }
  } else {
    bgControls = `
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="hsBanner${cap}BgSwatch" value="${bg.color || '#E5E5E5'}"
          oninput="setBannerBgColor('${which}',this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${bg.color || '#E5E5E5'}"
          oninput="setBannerBgColorHex('${which}',this.value)" placeholder="#000000">
        ${eyedropperBtn('hsBanner' + cap + 'BgSwatch')}
      </div>`;
  }

  const valign = b.valign || 'center';
  return `
    ${toggle}
    <div class="hs-section">
      <div class="hs-section-title">Background</div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${(bg.type || 'color') === 'color' ? ' active' : ''}" onclick="setBannerBgType('${which}','color')">Color</button>
        <button class="hs-tog-btn${bg.type === 'image' ? ' active' : ''}" onclick="setBannerBgType('${which}','image')">Image</button>
      </div>
      ${bgControls}
    </div>
    <div class="hs-section">
      <div class="hs-section-title">Text alignment <span class="hs-optional">(within the banner)</span></div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${valign === 'top' ? ' active' : ''}" onclick="setBannerValign('${which}','top')">Top</button>
        <button class="hs-tog-btn${valign === 'center' ? ' active' : ''}" onclick="setBannerValign('${which}','center')">Center</button>
        <button class="hs-tog-btn${valign === 'bottom' ? ' active' : ''}" onclick="setBannerValign('${which}','bottom')">Bottom</button>
      </div>
    </div>`;
}

// Turning a banner on can drop its colored strip right on top of free text
// that was previously just floating on the (empty) edge of the sign — dock
// any such overlapping text into the banner instead of leaving it stranded
// under/behind the new strip. Docked layers use the banner's own `spacing`
// field automatically, so this doesn't need to pick any spacing itself.
function autoDockOverlappingText(which) {
  const state = getEffectiveState(HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null);
  const rect = getBannerRect(state, which);
  if (!rect) return;
  const overlapping = textLayerSource().filter(l => {
    if (l.dock || !l.text || !l.text.trim()) return false;
    const w = l.w || Math.round(HS_W * 0.8);
    const h = (l.size || 200) * 1.1; // rough single-line estimate — good enough for an overlap test
    const cx = l.x + w / 2, cy = l.y + h / 2;
    return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
  });
  if (!overlapping.length) return;
  overlapping.sort((a, b) => a.y - b.y); // stack in the order they already read top-to-bottom
  let order = getDockedSiblings(state, which, null).length;
  overlapping.forEach(l => { l.dock = which; l.dockOrder = order++; });
}
window.setBannerEnabled = function (which, on) {
  const b = bannerSource(which);
  b.enabled = !!on;
  if (b.enabled) autoDockOverlappingText(which);
  redrawBannerStructural();
};
window.setBannerHeight = function (which, val) {
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  const b = bannerSource(which);
  b.height = Math.max(HS_BANNER_MIN_H, Math.min(HS_BANNER_MAX_H, parseInt(val, 10) || HS_BANNER_MIN_H));
  const lbl = document.getElementById('hsBanner' + cap + 'HeightVal');
  if (lbl) lbl.textContent = Math.round((b.height - HS_BANNER_MIN_H) / (HS_BANNER_MAX_H - HS_BANNER_MIN_H) * 100) + '%';
  redrawBannerPreview();
};
window.setBannerBgType = function (which, type) { bannerSource(which).bg.type = type; redrawBannerStructural(); };
window.setBannerBgColor = function (which, val) { bannerSource(which).bg.color = val; redrawBannerPreview(); };
window.setBannerBgColorHex = function (which, val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  bannerSource(which).bg.color = c;
  const s = document.getElementById('hsBanner' + cap + 'BgSwatch'); if (s) s.value = c;
  redrawBannerPreview();
};
window.handleBannerImageUpload = async function (which, e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !HS.projectId) return;
  try {
    const logo = await uploadLogo(HS.projectId, file);
    const b = bannerSource(which);
    b.bg.imageUrl = logo.src;
    b.bg.storagePath = logo.storagePath;
    // Captured once here (rather than derived on the fly) so the renderer
    // (hole-sign-render.js) and this drag control can both do a real
    // "cover" fit — knowing which axis actually has slack to pan through —
    // without either of them needing to load the image themselves.
    b.bg.imageNaturalW = null;
    b.bg.imageNaturalH = null;
    // The canvas render this triggers below runs before this resolves, so it
    // falls back to the old (locked-until-zoomed) box model — redraw once
    // natural size actually lands so the real pan range appears on its own,
    // without needing the user to nudge the image first to "unstick" it.
    loadNaturalImgSize(logo.src, (w, h) => {
      b.bg.imageNaturalW = w;
      b.bg.imageNaturalH = h;
      redrawBannerPreview();
    });
    redrawBannerStructural();
  } catch (err) { console.error('Banner image upload failed', err); }
};
window.removeBannerImage = function (which) {
  const b = bannerSource(which);
  b.bg.imageUrl = null;
  b.bg.storagePath = null;
  redrawBannerStructural();
};
window.setBannerImgOpacity = function (which, val) {
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  bannerSource(which).bg.imageOpacity = parseInt(val, 10);
  const lbl = document.getElementById('hsBanner' + cap + 'ImgOpLbl');
  if (lbl) lbl.textContent = val + '%';
  redrawBannerPreview();
};
window.setBannerImgGreyscale = function (which, on) {
  bannerSource(which).bg.imageGreyscale = !!on;
  redrawBannerPreview();
};
window.setBannerOverlayColor = function (which, val) {
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  bannerSource(which).bg.overlayColor = val;
  const hex = document.getElementById('hsBanner' + cap + 'OvColorSwatch');
  if (hex) hex.nextElementSibling.value = val;
  redrawBannerPreview();
};
window.setBannerOverlayColorHex = function (which, val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  bannerSource(which).bg.overlayColor = c;
  const swatch = document.getElementById('hsBanner' + cap + 'OvColorSwatch');
  if (swatch) swatch.value = c;
  redrawBannerPreview();
};
window.setBannerOverlayOpacity = function (which, val) {
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  bannerSource(which).bg.overlayOpacity = parseInt(val, 10);
  const lbl = document.getElementById('hsBanner' + cap + 'OvOpLbl');
  if (lbl) lbl.textContent = val + '%';
  redrawBannerPreview();
};
window.setBannerOverlayBlend = function (which, val) {
  bannerSource(which).bg.overlayBlend = val;
  redrawBannerPreview();
};
window.setBannerOverlayEnabled = function (which, on) {
  const b = bannerSource(which);
  b.bg.overlayEnabled = !!on;
  // Default the amount to 50% when first enabling so it's immediately visible.
  if (on && !(b.bg.overlayOpacity > 0)) b.bg.overlayOpacity = 50;
  redrawBannerStructural();
};
window.setBannerImagePos = function (which, key, val) {
  bannerSource(which).bg[key] = parseInt(val, 10);
  if (key === 'imageScale') {
    const cap = which === 'bottom' ? 'Bot' : 'Top';
    const lbl = document.getElementById('hsBanner' + cap + 'ScaleVal');
    if (lbl) lbl.textContent = (parseInt(val, 10) || 100) + '%';
  }
  redrawBannerPreview();
};
window.bannerImgDragStart = function (e, which) {
  e.preventDefault();
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  const wrap  = document.getElementById('bannerImgWrap'  + cap);
  const thumb = document.getElementById('bannerImgThumb' + cap);
  if (!wrap || !thumb) return;
  const b = bannerSource(which);
  if (!b.bg) b.bg = {};
  const bg = b.bg;
  const dims = bannerContainerDims(which) || { w: HS_W, h: HS_BANNER_DEFAULT_H };
  const x0 = e.clientX, y0 = e.clientY;
  const ix0 = bg.imageX ?? 50, iy0 = bg.imageY ?? 50;
  wrap.setPointerCapture(e.pointerId);
  let raf = null;
  function onMove(ev) {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; });
    const dx = (ev.clientX - x0) / wrap.offsetWidth  * 100;
    const dy = (ev.clientY - y0) / wrap.offsetHeight * 100;
    const p = clampPanToBg(dims.w, dims.h, bg, ix0 - dx, iy0 - dy);
    bg.imageX = p.x;
    bg.imageY = p.y;
    const redrawCanvas = () => { if (HS.editingVarId) renderVariationPreview(); else updateStep1Preview(); };
    layoutImgDragThumb(wrap, thumb, bg, dims.w, dims.h, redrawCanvas);
    redrawCanvas();
  }
  function onUp() {
    wrap.removeEventListener('pointermove', onMove);
    wrap.removeEventListener('pointerup', onUp);
    redrawBannerPreview();
  }
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
};

window.bannerImgWheel = function (e, which) {
  e.preventDefault();
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  const wrap  = document.getElementById('bannerImgWrap'  + cap);
  const thumb = document.getElementById('bannerImgThumb' + cap);
  const b = bannerSource(which);
  if (!b.bg) b.bg = {};
  const bg = b.bg;
  const dims = bannerContainerDims(which) || { w: HS_W, h: HS_BANNER_DEFAULT_H };
  const delta = e.deltaY > 0 ? -5 : 5;
  bg.imageScale = Math.max(100, Math.min(300, (bg.imageScale ?? 100) + delta));
  // Zooming out can shrink the valid pan range below the current position —
  // re-clamp now rather than leaving a gap until the next drag touches it.
  const p = clampPanToBg(dims.w, dims.h, bg, bg.imageX, bg.imageY);
  bg.imageX = p.x;
  bg.imageY = p.y;
  layoutImgDragThumb(wrap, thumb, bg, dims.w, dims.h, redrawBannerPreview);
  clearTimeout(window._bannerWheelT);
  window._bannerWheelT = setTimeout(redrawBannerPreview, 80);
};

window.setBannerValign = function (which, val) {
  bannerSource(which).valign = val;
  redrawBannerStructural();
};
window.setBannerSpacing = function (which, val) {
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  const b = bannerSource(which);
  b.spacing = Math.max(HS_BANNER_MIN_SPACING, parseInt(val, 10) || HS_BANNER_MIN_SPACING);
  const lbl = document.getElementById('hsBanner' + cap + 'SpacingVal');
  if (lbl) lbl.textContent = b.spacing;
  redrawBannerPreview();
};

window.quickAdd = function (kind, position) {
  const editing = !!(HS.editingVarId && HS.editingDraft);
  if (kind === 'banner') {
    const key = position === 'bottom' ? 'bannerBottom' : 'bannerTop';
    if (editing) {
      // Navigate (and snapshot the section's pre-mutation state, for that
      // section's own Cancel — see openHsVarMenu in var-editor.js) *before*
      // enabling the banner below, not after — otherwise the snapshot would
      // already carry enabled:true, and Cancel right after a fresh quick-add
      // would have nothing to revert to (the banner would stick around).
      window.openHsVarMenu(key);
      const b = bannerSource(position);
      b.enabled = true;
      autoDockOverlappingText(position);
      // openHsVarMenu only repaints the sidebar's #hsVarList, not the
      // separate #hsSignPreview canvas — without these, the just-enabled
      // banner wouldn't actually show up (or become editable) on the sign
      // until some other action happened to trigger a preview repaint.
      renderEditor();
      renderVariationPreview();
    } else {
      const b = bannerSource(position);  // position is 'top' | 'bottom'
      b.enabled = true;
      autoDockOverlappingText(position);
      window.openHsMenu(key); // rebuilds the whole Step-1 panel, canvas included
    }
  }
};

// ── Drag-to-snap (banner + logo block) ────────────────────
// Press a band element in the preview and drag up/down; the nearest edge
// highlights and the element snaps to top or bottom on release. `kind` is
// 'banner' (sets banner.position) or 'logos' (sets templateLogos.vAlign).
export function bandRectFor(kind, state) {
  const slots = getTemplateLogoSlots(state, state.templateStyle);
  if (!slots.length) return null;
  const x0 = Math.min(...slots.map(s => s.x)), y0 = Math.min(...slots.map(s => s.y));
  const x1 = Math.max(...slots.map(s => s.x + s.w)), y1 = Math.max(...slots.map(s => s.y + s.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function applyBandPosition(kind, pos) {
  if (kind !== 'logos') return;
  { const tl = tlSource(); tl.vAlign = pos; snapTlSlotsToDefaults(tl); }
  if (HS.editingVarId) { renderEditor(); renderVariationPreview(); }
  else renderStep1();
}

// Shared snap-drag. Shows top/bottom drop targets and, only if the pointer
// actually moved, snaps `kind` to the nearest edge on release — so a plain
// click (e.g. on a logo slot) still falls through to its select/add handler.
export function beginBandSnap(previewEl, kind, e, captureEl) {
  if (e.button != null && e.button !== 0) return;
  e.preventDefault();
  captureEl.setPointerCapture?.(e.pointerId);
  const pctV = (v, total) => (v / total * 100).toFixed(4) + '%';
  const state = getEffectiveState(HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null);
  const rect = bandRectFor(kind, state);
  const bandH = rect ? rect.h : HS_H * 0.2;
  const mk = atTop => {
    const t = document.createElement('div');
    t.className = 'band-drop-target';
    t.style.cssText = `position:absolute;left:0;width:100%;height:${pctV(bandH, HS_H)};${atTop ? 'top:0;' : 'bottom:0;'}z-index:5;`;
    previewEl.appendChild(t);
    return t;
  };
  const topT = mk(true), botT = mk(false);

  // A ghost of the section follows the cursor so the move is visible.
  const ghost = document.createElement('div');
  ghost.className = 'band-ghost';
  ghost.style.cssText = `position:absolute;left:${pctV(rect ? rect.x : 0, HS_W)};width:${pctV(rect ? rect.w : HS_W, HS_W)};height:${pctV(bandH, HS_H)};z-index:7;display:none;`;
  {
    const slots = (state.templateLogos?.slots || []).filter(s => s?.logoSrc);
    ghost.innerHTML = slots.length
      ? `<div class="band-ghost-logos">${slots.map(s => logoThumbHtml(s.logoSrcTight || s.logoSrc)).join('')}</div>`
      : `<span class="band-ghost-label">Logos</span>`;
  }
  previewEl.appendChild(ghost);

  // Live preview: while dragging, re-render only the background SVG with the
  // tentative position so the layout behind the band reflows in place — the user
  // sees exactly what the drop will produce. Overlays/ghost are left untouched
  // so the pointer drag keeps working.
  const editingVar = HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null;
  let reflowedPos = state.templateLogos?.vAlign || 'top';
  const reflowTo = p => {
    if (p === reflowedPos) return;
    reflowedPos = p;
    tlSource().vAlign = p;
    const st = getEffectiveState(editingVar);
    const bgVar = (editingVar && !editingVar.logos?.length) ? getEffectiveVariation(editingVar) : null;
    const tmp = document.createElement('div');
    // Strip free text layers + top/bottom text from the SVG the same way the
    // main render does — otherwise, since their DOM overlays stay on top
    // throughout the drag, this reflow would show a duplicate SVG copy behind
    // them (the halo).
    const bgState = { ...stripSlotImages(st), hideTextLayers: (st.textLayers || []).map(l => l.id), hideText: ['top', 'bottom'] };
    renderHoleSignInto(tmp, bgState, bgVar);
    const newSvg = tmp.querySelector('svg');
    const oldSvg = previewEl.querySelector('svg');
    if (newSvg && oldSvg) {
      newSvg.setAttribute('style', oldSvg.getAttribute('style') || '');
      oldSvg.replaceWith(newSvg);
    }
    syncTextZones(previewEl, st);
    syncLogoZone(previewEl, st);
    syncBannerHandles(previewEl, st);
    syncDockedLayerOverlays(previewEl, st);
  };

  const startY = e.clientY;
  let pos = reflowedPos, moved = false;
  const onMove = ev => {
    if (Math.abs(ev.clientY - startY) > 4) moved = true;
    const r = previewEl.getBoundingClientRect();
    pos = (ev.clientY - r.top) / r.height < 0.5 ? 'top' : 'bottom';
    topT.classList.toggle('active', pos === 'top');
    botT.classList.toggle('active', pos === 'bottom');
    if (moved) {
      previewEl.classList.add('band-dragging');
      ghost.style.display = '';
      const hPx = bandH / HS_H * r.height;
      const topPx = Math.max(0, Math.min(r.height - hPx, (ev.clientY - r.top) - hPx / 2));
      ghost.style.top = (topPx / r.height * 100) + '%';
      reflowTo(pos);
    }
  };
  const onUp = () => {
    captureEl.removeEventListener('pointermove', onMove);
    captureEl.removeEventListener('pointerup', onUp);
    topT.remove(); botT.remove(); ghost.remove();
    previewEl.classList.remove('band-dragging');
    if (moved) {
      UI.tlJustDragged = true;              // suppress the synthetic click
      setTimeout(() => { UI.tlJustDragged = false; }, 0);
      applyBandPosition(kind, pos);
    }
  };
  captureEl.addEventListener('pointermove', onMove);
  captureEl.addEventListener('pointerup', onUp);
  onMove(e);
}

export function wireElementDrag(previewEl, kind) {
  const state = getEffectiveState(HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null);
  const rect = bandRectFor(kind, state);
  if (!rect) return;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  const ov = document.createElement('div');
  ov.className = 'band-drag';
  ov.style.cssText = `position:absolute;left:${pct(rect.x, HS_W)};top:${pct(rect.y, HS_H)};width:${pct(rect.w, HS_W)};height:${pct(rect.h, HS_H)};cursor:grab;z-index:2;`;
  ov.title = `Drag to move ${kind === 'banner' ? 'banner' : 'logos'} to top or bottom`;
  ov.addEventListener('pointerdown', e => { ov.style.cursor = 'grabbing'; beginBandSnap(previewEl, kind, e, ov); });
  previewEl.appendChild(ov);
}

// A banner's height changes the y-position of the top/bottom sponsor-text
// bands (they sit right after the banner + margin) — those bands have no SVG
// copy of their own (see hideText above), so their .canvas-edit-zone overlay
// is the ONLY visual for that text. Left at its pre-drag position while the
// live SVG reflows around it, the text visually detaches from the growing/
// shrinking banner — reads as a stray leftover copy. Keep every zone's box in
// sync with the live layout on every reflow so it moves with the banner.
function syncTextZones(previewEl, st) {
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  const regions = getTextRegions(st, st.templateStyle);
  previewEl.querySelectorAll('.canvas-edit-zone').forEach(zone => {
    const r = regions[zone.dataset.kind];
    if (!r) return;
    zone.style.left = pct(r.x, HS_W);
    zone.style.top = pct(r.y, HS_H);
    zone.style.width = pct(r.w, HS_W);
    zone.style.height = pct(r.h, HS_H);
  });
}

// Same idea as syncTextZones, for the logo zone: growing/shrinking a banner
// (or its text) shrinks/grows the space left for the sponsor logo, so both the
// Step-1 "Variation logo" placeholder and the Variations step's live drop
// zone need to resize with it in real time, not just snap into place once the
// drag ends.
export function syncLogoZone(previewEl, st) {
  const lz = getLogoZone(st, st.templateStyle);
  if (!lz) return;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  previewEl.querySelectorAll('.dzone').forEach(dzone => {
    dzone.classList.remove('hs-logo-zone-previewing');
    dzone.style.left = pct(lz.x, HS_W);
    dzone.style.top = pct(lz.y, HS_H);
    dzone.style.width = pct(lz.w, HS_W);
    dzone.style.height = pct(lz.h, HS_H);
  });
}

// Preview variant of syncLogoZone for design.js's free-text-layer drag: while
// hovering within HS_BANNER_EDGE_PX of an edge whose banner isn't enabled
// yet, simulate turning that banner on at its default height so the sponsor
// logo zone eases into the same shrink it'll actually get once the drop
// enables the banner — without touching the real (not-yet-committed) state.
export function previewLogoZoneShrink(previewEl, state, which) {
  const key = which === 'bottom' ? 'bannerBottom' : 'bannerTop';
  const preview = { ...state, [key]: { ...(state[key] || emptyBanner()), enabled: true, height: HS_BANNER_DEFAULT_H } };
  const lz = getLogoZone(preview, preview.templateStyle);
  if (!lz) return;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  previewEl.querySelectorAll('.dzone').forEach(dzone => {
    dzone.classList.add('hs-logo-zone-previewing');
    dzone.style.left = pct(lz.x, HS_W);
    dzone.style.top = pct(lz.y, HS_H);
    dzone.style.width = pct(lz.w, HS_W);
    dzone.style.height = pct(lz.h, HS_H);
  });
}

// ── Docking: free text layers can be dragged into a banner's rect ──────────
// A banner is a dock zone, not a fixed title/sub slot — any number of ordinary
// free text layers (HS.textLayers) can dock to it via their own `dock`/
// `dockOrder` fields (see hole-sign-data.js/hole-sign-render.js). `which` is
// 'top' | 'bottom' throughout.

// Sign-coord hysteresis margin: once a layer is already docked to a zone, the
// pointer must travel this far past the zone's edge before it undocks, so
// hovering right at the boundary doesn't flicker in and out. Matches the
// existing Shift-drag edge-snap threshold (design.js's findAxisSnap call).
const DOCK_HYSTERESIS = 200;

export function getDockedSiblings(state, which, excludeId) {
  return dockedLayers(state, which).filter(l => l.id !== excludeId);
}

// Point-in-rect test against a banner's zone. `stickyTo` is the layer's
// current dock (or null) — when it matches a zone, that zone's rect is
// expanded by DOCK_HYSTERESIS so undocking needs real intent, not just
// grazing the pixel edge.
export function hitTestDockZone(state, cx, cy, stickyTo) {
  for (const which of ['top', 'bottom']) {
    const rect = getBannerRect(state, which);
    if (!rect) continue;
    const sticky = stickyTo === which;
    const y0 = sticky ? rect.y - DOCK_HYSTERESIS : rect.y;
    const y1 = sticky ? rect.y + rect.h + DOCK_HYSTERESIS : rect.y + rect.h;
    if (cx >= rect.x && cx <= rect.x + rect.w && cy >= y0 && cy <= y1) return which;
  }
  return null;
}

// Screen-pixel depth the dragged box's edge must overlap into an already-
// enabled banner's rect before design.js's free-text-layer drag treats it as
// docked — and, symmetrically, the overlap it must drop back below to
// undock. A simpler, symmetric alternative to hitTestDockZone's center-point
// + one-sided hysteresis test, used only for that drag's live dock/reflow
// trigger (see dockOverlapHit).
export const HS_DOCK_OVERLAP_PX = 8;

// `boxY`/`boxH` are the dragged box's vertical extent in sign coords; `sy` is
// the sign-to-screen scale factor (screen px per sign unit), used to convert
// HS_DOCK_OVERLAP_PX into sign-space units. Banners always span the full
// sign width (see getBannerRect), so unlike hitTestDockZone this only needs
// to check vertical overlap depth, not a horizontal bound too.
//
// `stickyTo`/`layerId`: when this layer is already docked to a zone, that
// zone's overlap is measured against the layer's OWN current stacked slot
// (from dockedLayerPositions), not the whole banner rect. The banner rect
// can be much taller than this one line of text — a manually-set banner
// height, or other docked siblings padding it out — so testing against the
// full rect makes undocking feel like it "takes a while" (still plenty of
// overlap left even once the box has visibly left its own slot). Entering a
// zone this layer isn't already in still tests against the full rect, since
// there's no slot of its own to compare against yet.
export function dockOverlapHit(state, boxY, boxH, sy, stickyTo, layerId) {
  const thresh = HS_DOCK_OVERLAP_PX / sy;
  for (const which of ['top', 'bottom']) {
    const rect = stickyTo === which ? dockedLayerPositions(state, which)[layerId] : getBannerRect(state, which);
    if (!rect) continue;
    const overlap = Math.min(boxY + boxH, rect.y + rect.h) - Math.max(boxY, rect.y);
    if (overlap >= thresh) return which;
  }
  return null;
}

// Fakes a smooth collapse of the banner's colored background band when a
// docked layer leaves it (design.js's free-text-layer drag) — shrinking the
// band, or killing it outright if that was the last docked layer. reflowBannerSvg
// already commits the new, correct layout for everything else (remaining
// docked siblings, logo zone, template logos) via a full SVG replace, so
// rather than also trying to interpolate all of that, this lays a plain
// colored div over where the OLD (taller) band used to be and eases it down
// to the NEW rect (or to zero height, anchored at the banner's own edge, if
// it was killed) — the already-final content underneath is revealed exactly
// as the ghost shrinks away from it. `oldRect`/`newRect` are getBannerRect's
// results from just before/after the layer left; `newRect` is null when the
// banner was killed.
export function showBannerShrinkGhost(previewEl, which, oldRect, newRect, color) {
  if (!oldRect) return;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  previewEl.querySelectorAll(`.hs-banner-shrink-ghost[data-which="${which}"]`).forEach(el => el.remove());
  const el = document.createElement('div');
  el.className = 'hs-banner-shrink-ghost';
  el.dataset.which = which;
  el.style.cssText = 'position:absolute;left:0;width:100%;z-index:3;pointer-events:none;';
  el.style.background = color;
  el.style.top = pct(oldRect.y, HS_H);
  el.style.height = pct(oldRect.h, HS_H);
  previewEl.appendChild(el);
  const targetY = newRect ? newRect.y : (which === 'bottom' ? HS_H : 0);
  const targetH = newRect ? newRect.h : 0;
  // Double rAF: the first lets the browser paint the "old" box (so it has a
  // real prior state to transition from instead of animating in from
  // nothing), the second then sets the target the CSS transition eases to.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.top = pct(targetY, HS_H);
    el.style.height = pct(targetH, HS_H);
  }));
  el.addEventListener('transitionend', () => el.remove(), { once: true });
  // Belt-and-suspenders: a full re-render can remove/replace previewEl's
  // children before transitionend ever fires, so also clear it on a timer.
  setTimeout(() => el.remove(), 400);
}

// Temporary "ghost" banner strip shown while a free text layer is dragged
// within HS_BANNER_EDGE_PX of the top/bottom edge on a side whose banner
// isn't enabled yet (see design.js's free-text-layer drag handler) — previews
// where it'll land (and that the banner will switch on) if dropped there.
export function showBannerPreview(previewEl, which) {
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  let el = previewEl.querySelector('.hs-banner-preview');
  if (!el) {
    el = document.createElement('div');
    el.className = 'hs-banner-preview band-drop-target active';
    el.style.cssText = 'position:absolute;left:0;width:100%;z-index:4;';
    previewEl.appendChild(el);
  }
  el.style.top = which === 'bottom' ? pct(HS_H - HS_BANNER_DEFAULT_H, HS_H) : '0%';
  el.style.height = pct(HS_BANNER_DEFAULT_H, HS_H);
}

export function clearBannerPreview(previewEl) {
  previewEl.querySelector('.hs-banner-preview')?.remove();
}

// Pixel (screen) distance from the top/bottom canvas edge within which
// dragging a free text layer previews + drops it into that side's banner,
// enabling the banner if it wasn't already on. See design.js.
export const HS_BANNER_EDGE_PX = 16;

// Repositions every currently-docked layer's DOM overlay to match
// dockedLayerPositions() — called from reflowBannerSvg/beginBandSnap's
// reflowTo so docked layers live-follow a banner height/spacing/valign drag
// instead of lagging behind until the next full render.
export function syncDockedLayerOverlays(previewEl, st) {
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  ['top', 'bottom'].forEach(which => {
    const positions = dockedLayerPositions(st, which);
    Object.entries(positions).forEach(([id, r]) => {
      const el = previewEl.querySelector(`.hs-tl-overlay[data-tl-id="${id}"]`);
      if (!el) return;
      el.style.left = pct(r.x, HS_W);
      el.style.top = pct(r.y, HS_H);
      el.style.width = pct(r.w, HS_W);
    });
  });
}

// Midpoint (sign coords) between the first two docked, non-empty layers'
// stacked boxes in `which` — every adjacent gap uses the same banner.spacing
// value, so any one pair is representative for positioning the spacing handle.
// Returns null when fewer than 2 docked layers have real text.
function dockGapMid(state, which) {
  const siblings = dockedLayers(state, which).filter(l => l.text && l.text.trim());
  if (siblings.length < 2) return null;
  const positions = dockedLayerPositions(state, which);
  const first = positions[siblings[0].id];
  const second = positions[siblings[1].id];
  if (!first || !second) return null;
  return (first.y + first.h + second.y) / 2;
}

// Dragging either the height handle or the spacing handle can move the
// other one too (growing the banner shifts the gap's midpoint; widening the
// gap can grow the banner past its stored height) — reposition BOTH handles,
// for both banners, on every reflow so neither lags behind the one actually
// being dragged.
function syncBannerHandles(previewEl, st) {
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  ['top', 'bottom'].forEach(which => {
    const banner = which === 'bottom' ? st.bannerBottom : st.bannerTop;
    const rect = getBannerRect(st, which);
    const heightHandle = previewEl.querySelector(`.hs-banner-height-handle[data-which="${which}"]`);
    if (heightHandle) {
      if (rect) {
        heightHandle.classList.remove('hs-banner-handle-hidden');
        const edgeY = which === 'bottom' ? rect.y : rect.y + rect.h;
        heightHandle.style.top = pct(edgeY, HS_H);
      } else {
        // Banner just went away (its last docked layer left, or it never had
        // one) — fade the handle out instead of leaving it stranded at its
        // last position, since nothing below updates it again until the next
        // full render (see wireBannerHeightHandles's own !banner?.enabled
        // guard, which only runs on that next render, not live).
        heightHandle.classList.add('hs-banner-handle-hidden');
      }
    }
    const spacingHandle = previewEl.querySelector(`.hs-banner-spacing-handle[data-which="${which}"]`);
    if (spacingHandle && rect && banner) {
      const mid = dockGapMid(st, which);
      if (mid != null) { spacingHandle.classList.remove('hs-banner-handle-hidden'); spacingHandle.style.top = pct(mid, HS_H); }
      else spacingHandle.classList.add('hs-banner-handle-hidden');
    } else if (spacingHandle) {
      spacingHandle.classList.add('hs-banner-handle-hidden');
    }
  });
}

// Re-render just the background SVG in place (leaving DOM overlay handles
// untouched) so live drags get real layout feedback — same technique as
// beginBandSnap's reflowTo. Returns the fresh effective state so callers can
// reposition their own handle from it.
export function reflowBannerSvg(previewEl, editingVar) {
  const st = getEffectiveState(editingVar);
  const bgVar = (editingVar && !editingVar.logos?.length) ? getEffectiveVariation(editingVar) : null;
  const tmp = document.createElement('div');
  // Strip free text layers (including any docked to a banner) + top/bottom
  // text from the SVG the same way the main render does — their DOM overlays
  // stay on top throughout the drag, so without this the reflow would show a
  // duplicate SVG copy behind them (the halo).
  const bgState = { ...stripSlotImages(st), hideTextLayers: (st.textLayers || []).map(l => l.id), hideText: ['top', 'bottom'] };
  renderHoleSignInto(tmp, bgState, bgVar);
  const newSvg = tmp.querySelector('svg');
  const oldSvg = previewEl.querySelector('svg');
  if (newSvg && oldSvg) {
    newSvg.setAttribute('style', oldSvg.getAttribute('style') || '');
    oldSvg.replaceWith(newSvg);
  }
  syncTextZones(previewEl, st);
  syncLogoZone(previewEl, st);
  syncBannerHandles(previewEl, st);
  syncDockedLayerOverlays(previewEl, st);
  return st;
}

// Manual dblclick detection, keyed per which — same rationale as design.js's
// checkWidthHandleDblClick: a plain click's pointerup calls redrawBannerStructural(),
// which fully re-renders the overlay tree and replaces this handle's DOM node,
// so a native 'dblclick' listener would rarely see both clicks land on the
// same element. Module-level (not per-render) so the timestamp survives that
// re-render.
const hsBannerHeightDblClickAt = { top: 0, bottom: 0 };
function checkHeightHandleDblClick(which) {
  const now = Date.now();
  const prev = hsBannerHeightDblClickAt[which];
  if (prev && now - prev < 400) { hsBannerHeightDblClickAt[which] = 0; return true; }
  hsBannerHeightDblClickAt[which] = now;
  return false;
}

// On-canvas drag handle for banner height — a small line at the banner's free
// edge (bottom edge for the top banner, top edge for the bottom banner) that
// drags the height directly, in place of the sidebar slider. Double-clicking
// it instead collapses the banner to "hug" its docked text content (see
// bannerFitHeight).
export function wireBannerHeightHandles(previewEl) {
  const editingVar = HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';

  ['top', 'bottom'].forEach(which => {
    const state = getEffectiveState(editingVar);
    const banner = which === 'bottom' ? state.bannerBottom : state.bannerTop;
    if (!banner?.enabled) return;
    const rect = getBannerRect(state, which);
    if (!rect) return;
    const cap = which === 'bottom' ? 'Bot' : 'Top';
    const edgeY = which === 'bottom' ? rect.y : rect.y + rect.h;

    const handle = document.createElement('div');
    handle.className = 'hs-banner-height-handle';
    handle.dataset.which = which;
    handle.style.top = pct(edgeY, HS_H);
    handle.title = 'Drag to resize · double-click to hug content';

    let startY, startHeight;
    handle.addEventListener('pointerdown', e => {
      e.stopPropagation();
      if (checkHeightHandleDblClick(which)) {
        e.preventDefault();
        bannerSource(which).height = bannerFitHeight(getEffectiveState(editingVar), which);
        redrawBannerStructural();
        return;
      }
      handle.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startHeight = bannerSource(which).height || 0;
      handle.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const sy = previewEl.offsetHeight / HS_H;
      const dy = (e.clientY - startY) / sy;
      const delta = which === 'bottom' ? -dy : dy;
      const b = bannerSource(which);
      b.height = Math.max(HS_BANNER_MIN_H, Math.min(HS_BANNER_MAX_H, Math.round(startHeight + delta)));
      const lbl = document.getElementById('hsBanner' + cap + 'HeightVal');
      if (lbl) lbl.textContent = Math.round((b.height - HS_BANNER_MIN_H) / (HS_BANNER_MAX_H - HS_BANNER_MIN_H) * 100) + '%';
      reflowBannerSvg(previewEl, editingVar); // also repositions this handle + the spacing handle
    });
    handle.addEventListener('pointerup', () => {
      document.body.style.cursor = '';
      handle.classList.remove('dragging');
      redrawBannerStructural();
    });
    previewEl.appendChild(handle);
  });
}

// On-canvas drag handle for the gap between adjacent docked text layers —
// only shown when 2+ are docked with real text — in place of the sidebar's
// "Text spacing" slider.
export function wireBannerSpacingHandles(previewEl) {
  const editingVar = HS.editingVarId ? HS.variations.find(v => v.id === HS.editingVarId) : null;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';

  ['top', 'bottom'].forEach(which => {
    const state = getEffectiveState(editingVar);
    const key = which === 'bottom' ? 'bannerBottom' : 'bannerTop';
    const banner = state[key];
    if (!banner?.enabled) return;
    const mid = dockGapMid(state, which);
    if (mid == null) return;

    const rect = getBannerRect(state, which);
    if (!rect) return;
    const cap = which === 'bottom' ? 'Bot' : 'Top';

    const handle = document.createElement('div');
    handle.className = 'hs-banner-spacing-handle';
    handle.dataset.which = which;
    handle.style.top = pct(mid, HS_H);
    handle.title = 'Drag to adjust spacing between docked text layers';

    let startY, startSpacing;
    handle.addEventListener('pointerdown', e => {
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startSpacing = bannerSource(which).spacing || 0;
      handle.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const sy = previewEl.offsetHeight / HS_H;
      // Bottom banner's stack sits against the sign's bottom edge, so dragging
      // toward that edge (down) should read as squeezing the gap shut, and
      // dragging away from it (up) as pulling it open — the opposite sign from
      // the top banner, whose stack sits against the top edge instead.
      const dir = which === 'bottom' ? -1 : 1;
      const dy = (e.clientY - startY) / sy * dir;
      const b = bannerSource(which);
      b.spacing = Math.max(HS_BANNER_MIN_SPACING, Math.min(500, Math.round(startSpacing + dy * 2)));
      const lbl = document.getElementById('hsBanner' + cap + 'SpacingVal');
      if (lbl) lbl.textContent = b.spacing;
      reflowBannerSvg(previewEl, editingVar); // also repositions this handle + the height handle
    });
    handle.addEventListener('pointerup', () => {
      document.body.style.cursor = '';
      handle.classList.remove('dragging');
      redrawBannerStructural();
    });
    previewEl.appendChild(handle);
  });
}

// Inline canvas text editing: tap a text band to edit it in place. The input
// is styled to match (font, color, size scaled from sign coords) and covers the
// SVG text with the band's background; committing on blur/Enter re-renders.

// Caret helpers for the contenteditable inline editor (plain single-text-node).
export function caretOffset(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  const r = sel.getRangeAt(0);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}
export function setCaret(el, offset) {
  const sel = window.getSelection();
  const range = document.createRange();
  const node = el.firstChild;
  if (node && node.nodeType === 3) range.setStart(node, Math.max(0, Math.min(offset, node.textContent.length)));
  else range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
export function selectAll(el) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function wireCanvasTextEditing(previewEl, { locked = false } = {}) {
  const editing = HS.editingVarId && HS.editingDraft;
  // `editing` above is a snapshot at wire-time, fine for the read-only layout
  // math below; writes (setText/setProp) need the live value since locked
  // mode's first click starts a draft (beginQuickEdit) *after* this function
  // has already been wired, mid-interaction.
  const isNowEditing = () => !!(HS.editingVarId && HS.editingDraft);
  // Locked (quick-edit) mode hasn't necessarily started a draft yet (that only
  // happens on the first click, via beginQuickEdit in startEdit below) — until
  // then, read this variation's already-merged effective state (template +
  // its own overrides) via HS.activeVarId, not the empty global template.
  const stateVarId = editing ? HS.editingVarId : (locked ? HS.activeVarId : null);
  const state = getEffectiveState(stateVarId ? HS.variations.find(v => v.id === stateVarId) : null);
  // Keep the active text band alive while it's being typed into, even if that
  // leaves it momentarily empty, so clearing the text mid-edit doesn't dismiss
  // the editor out from under the user. Deleting via the toolbar/Delete key
  // while merely *selected* (not editing) is deliberately not forced here —
  // that should kill the band immediately, not leave an empty placeholder.
  const forceableKinds = ['top', 'bottom'];
  const forceText = (UI.canvasEdit && forceableKinds.includes(UI.canvasEdit.kind)) ? [UI.canvasEdit.kind] : [];
  const regions = getTextRegions(state, state.templateStyle, forceText);
  const sc = (previewEl.clientHeight || HS_H) / HS_H;
  const fam = id => (HS_FONTS.find(f => f.id === id)?.family) || "'DM Sans', sans-serif";
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  // Available span a text box's width can grow into — matches fitTextBox() in
  // hole-sign-render.js so the live drag preview lines up with the re-render.
  const innerW = HS_W - 2 * HS_MARGIN;
  const textObj = kind => kind === 'top' ? state.topText : state.bottomText;
  // Recompute a 'top'/'bottom' band's box (x/y/w/h) via the same layout math
  // the SVG uses, given a live in-drag size/width — so edge/corner drags can
  // grow the box's height too (more lines wrap in) instead of only its width,
  // and always land exactly where the eventual re-render will put it.
  const recomputeBox = (targetKind, overrides) => {
    const merged = { ...textObj(targetKind), ...overrides };
    const liveState = { ...state, [targetKind === 'top' ? 'topText' : 'bottomText']: merged };
    return getTextRegions(liveState, liveState.templateStyle, forceText)[targetKind];
  };
  const setText = (kind, value) => {
    const obj = isNowEditing() ? HS.editingDraft : HS;
    const k = kind === 'top' ? 'topText' : 'bottomText';
    obj[k] = { ...obj[k], text: value };
    // Per-variation overrides (HS.editingDraft) aren't part of the Step-1
    // template-switch carry-over logic, so only the main design state counts.
    if (!isNowEditing()) {
      const slot = kind === 'top' ? 'primary' : 'secondary';
      HS.captionsEdited[slot] = true;
    }
  };
  // Same idea as setText but for font/size/color/align — used by the on-canvas
  // toolbar (setText's text-only path stays separate since inline typing has
  // its own commit flow).
  const setProp = (kind, prop, value) => {
    const obj = isNowEditing() ? HS.editingDraft : HS;
    const k = kind === 'top' ? 'topText' : 'bottomText';
    obj[k] = { ...obj[k], [prop]: value };
  };
  // Live: re-render the preview only (re-runs this wiring, which restores the
  // input below). Final: also refresh the side controls — except in locked
  // (quick-edit) mode, which has no side panel to refresh.
  const rerenderLive = () => { UI.canvasRerendering = true; if (locked || isNowEditing()) renderVariationPreview(); else updateStep1Preview(); UI.canvasRerendering = false; };
  const rerenderFinal = () => { if (locked) renderVariationPreview(); else if (isNowEditing()) { renderEditor(); renderVariationPreview(); } else updateStep1Preview(); };

  // ── On-canvas toolbar (font/size/color/align/remove) ─────────────────────
  // Mirrors the free text-layer toolbar (`.hs-tl-toolbar`, same CSS) so band
  // text (top/bottom sponsor text, banner title/sub-text) gets the same
  // grow/scale + styling controls while it's being edited on the canvas.
  function closeBandToolbar() {
    document.getElementById('hsBandToolbar')?.remove();
  }

  function openBandToolbar(kind, anchorEl) {
    // A live re-render (triggered by the slider/color drag itself, or by typing)
    // restores the in-progress edit via enterEdit(), which calls back in here.
    // If the toolbar for this same kind is already open, leave its DOM alone —
    // rebuilding it would replace the slider/color <input> mid-drag, which
    // kills the browser's native drag gesture and makes it look like the
    // control only responds to discrete taps instead of a smooth drag.
    const existing = document.getElementById('hsBandToolbar');
    if (existing && existing.dataset.kind === kind) return;
    closeBandToolbar();
    const t = textObj(kind);
    const tb = document.createElement('div');
    tb.className = 'hs-tl-toolbar';
    tb.id = 'hsBandToolbar';
    tb.dataset.kind = kind;
    const align = t.align || 'center';
    const fontOpts = HS_FONTS.map(f =>
      `<option value="${f.id}"${t.font === f.id ? ' selected' : ''}>${f.name}</option>`
    ).join('');
    tb.innerHTML = `
      <select class="hs-tl-tb-select" id="hsBandFont">${fontOpts}</select>
      <div class="hs-tl-tb-sep"></div>
      <div class="hs-tl-tb-size-row">
        <input type="range" class="hs-tl-tb-slider" id="hsBandSizeSlider" min="80" max="1000" step="10" value="${t.size}">
        <span class="hs-tl-tb-size-val" id="hsBandSizeVal">${t.size}</span>
      </div>
      <div class="hs-tl-tb-sep"></div>
      <input type="color" class="hs-tl-tb-color" id="hsBandColor" value="${t.color || '#111110'}" title="Color">
      <div class="hs-tl-tb-sep"></div>
      <button class="hs-tl-tb-btn${align === 'left'   ? ' active' : ''}" data-align="left"   title="Left">
        <i class="fa-solid fa-align-left" aria-hidden="true"></i>
      </button>
      <button class="hs-tl-tb-btn${align === 'center' ? ' active' : ''}" data-align="center" title="Center">
        <i class="fa-solid fa-align-center" aria-hidden="true"></i>
      </button>
      <button class="hs-tl-tb-btn${align === 'right'  ? ' active' : ''}" data-align="right"  title="Right">
        <i class="fa-solid fa-align-right" aria-hidden="true"></i>
      </button>
      <div class="hs-tl-tb-sep"></div>
      <button class="hs-tl-tb-btn hs-tl-tb-delete" title="Remove">Remove</button>`;
    document.body.appendChild(tb);

    // Buttons shouldn't steal focus from the contenteditable band; inputs/selects
    // are exempted so they still work normally.
    tb.addEventListener('mousedown', e => {
      if (!['INPUT', 'SELECT'].includes(e.target.tagName)) e.preventDefault();
    });

    tb.querySelector('#hsBandFont').addEventListener('change', e => { setProp(kind, 'font', e.target.value); rerenderFinal(); });
    const slider = tb.querySelector('#hsBandSizeSlider');
    const sizeVal = tb.querySelector('#hsBandSizeVal');
    slider.addEventListener('input', e => {
      const n = parseInt(e.target.value, 10);
      sizeVal.textContent = n;
      setProp(kind, 'size', n);
      rerenderFinal();
    });
    tb.querySelector('#hsBandColor').addEventListener('input', e => { setProp(kind, 'color', e.target.value); rerenderFinal(); });
    tb.querySelectorAll('[data-align]').forEach(btn => {
      btn.addEventListener('click', () => {
        tb.querySelectorAll('[data-align]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setProp(kind, 'align', btn.dataset.align);
        rerenderFinal();
      });
    });
    tb.querySelector('.hs-tl-tb-delete').addEventListener('click', () => {
      setText(kind, '');
      rerenderFinal();
    });

    tb.style.position = 'fixed';
    repositionToolbar(anchorEl, 'hsBandToolbar');
  }

  // Map text alignment to both text-align and justify-content so the flex
  // container positions the text block at the correct edge rather than always
  // centering it (which would override left/right alignment visually).
  const alignJc = a => a === 'left' ? 'flex-start' : a === 'right' ? 'flex-end' : 'center';
  const fontStyle = kind => {
    const t = textObj(kind);
    const align = t.align || 'center';
    return `text-align:${align};justify-content:${alignJc(align)};overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap;line-height:1.1;color:${t.color || '#111110'};font-family:${fam(t.font)};font-size:${Math.max(9, Math.round((t.size || 200) * sc))}px;`;
  };

  const enterEdit = (zone, kind) => {
    hideHsToolbar();
    const t = textObj(kind);
    // contenteditable (flex-centered) so the text wraps and stays vertically
    // centered in place — it doesn't jump to the top the way a textarea would.
    const input = document.createElement('div');
    input.className = 'canvas-edit-input';
    input.contentEditable = 'true';
    input.dataset.ph = kind === 'top' ? 'Sponsored by…' : 'Club name, tagline…';
    input.textContent = t.text || '';
    // The SVG copy of this band is hidden while editing (no halo), so the
    // input itself must show the real text color.
    const textColor = textObj(kind).color || '#111110';
    input.style.cssText = `width:100%;height:100%;box-sizing:border-box;outline:none;cursor:text;display:flex;align-items:center;${fontStyle(kind)}caret-color:${textColor};`;
    input.dataset.baseSize = t.size || 200;
    // The SVG text for this band is hidden while editing (no halo), so the live
    // editor sits over the band background without needing an opaque cover.
    // Only the hotspot is replaced — the resize-corner handles are siblings
    // that must survive entering edit mode.
    zone.querySelector('.canvas-edit-hotspot')?.remove();
    zone.appendChild(input);
    input.focus();
    const caret = (UI.canvasEdit && UI.canvasEdit.kind === kind) ? UI.canvasEdit.caret : null;
    if (caret != null) setCaret(input, caret); else selectAll(input);
    openBandToolbar(kind, zone);

    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      UI.canvasEdit = null;
      setText(kind, input.textContent);
      closeBandToolbar();
      // Locked (quick-edit) mode: persist straight to this variation's
      // override and drop back out of the draft — applyEditVar() already
      // re-renders the canvas, so no separate rerenderFinal() call.
      if (locked) window.applyEditVar();
      else rerenderFinal();
    };
    input.addEventListener('input', () => {
      UI.canvasEdit = { kind, caret: caretOffset(input) };
      setText(kind, input.textContent);
      rerenderLive(); // text adapts immediately; input is re-created + re-focused
    });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); finalize(); return; }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (ev.shiftKey) {
          // Soft return: insert \n at cursor; white-space:pre-wrap renders it.
          const sel = window.getSelection();
          if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const node = document.createTextNode('\n');
            range.insertNode(node);
            range.setStartAfter(node);
            range.setEndAfter(node);
            sel.removeAllRanges();
            sel.addRange(range);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else {
          finalize();
        }
      }
    });
    input.addEventListener('blur', e => {
      // Don't commit if focus moved to the floating toolbar — the user is
      // changing font/size/color/align while still editing.
      if (e.relatedTarget?.closest?.('#hsBandToolbar')) return;
      // Commit synchronously, not deferred: finalize()'s rerender needs to land
      // *before* the click that caused this blur reaches its own target, so that
      // click re-hits the freshly rebuilt element instead of one about to be torn
      // down. A deferred commit was landing after the user had already selected
      // something else, clobbering that selection and forcing a second click.
      // isConnected/canvasRerendering are still meaningful checked synchronously:
      // a corner-handle drag's live rerender removes+replaces this input (firing
      // this same blur) *before* control returns here, so a stale input is
      // already disconnected and UI.canvasRerendering already true by this point.
      if (!input.isConnected) return;
      if (document.activeElement?.closest?.('#hsBandToolbar')) return;
      if (!UI.canvasRerendering) finalize();
    });

    // Belt-and-suspenders for the blur handler above: plenty of other canvas
    // surfaces (a logo's empty drop zone, a template-logo slot, the
    // background quick-swap zone) aren't focusable, so clicking them never
    // fires a native blur on this input at all — nothing then commits the
    // edit, leaving HS.editingDraft dangling. From then on getEffectiveState
    // keeps preferring that stale draft over the variation's real saved
    // content on every future read, which is what looks like text
    // "reverting to the template" and the band staying highlighted forever.
    // A capture-phase outside click always fires regardless of what (if
    // anything) the clicked element's own handler does, so use it as the
    // catch-all commit point instead of chasing every call site.
    setTimeout(() => {
      const outsideCommit = ev => {
        if (ev.target.closest?.('.canvas-edit-input, #hsBandToolbar')) return;
        document.removeEventListener('click', outsideCommit, true);
        if (!UI.canvasRerendering) finalize();
      };
      document.addEventListener('click', outsideCommit, true);
    }, 0);
  };

  Object.entries(regions).forEach(([kind, rect]) => {
    const t = textObj(kind);
    const hasText = !!(t.text && t.text.trim());
    const isEditingThis = UI.canvasEdit?.kind === kind;
    const isActive = isEditingThis || UI.canvasSelectedKind === kind;
    const zone = document.createElement('div');
    // hs-tl-overlay reuses the free text-layer's hover/selected border + the
    // resize-corner hover-reveal CSS (same purple `--guides` selected color).
    zone.className = 'canvas-edit-zone hs-tl-overlay' + (isActive ? ' selected' : '');
    zone.dataset.kind = kind;
    // Empty text bands get a subtle grey background so the zone is visible —
    // but not while actively being typed into: hasText flips true/false with
    // every keystroke as the field empties/fills, which would otherwise flash
    // the background on and off as you type.
    const zoneBg = (!hasText && !isEditingThis) ? 'background:rgba(0,0,0,0.05);border-radius:6px;' : '';
    // Zones match the text alignment so the hotspot / editor sits at the same
    // edge as the rendered SVG text.
    const zoneJc = alignJc(t.align || 'center');
    zone.style.cssText = `position:absolute;left:${pct(rect.x, HS_W)};top:${pct(rect.y, HS_H)};width:${pct(rect.w, HS_W)};height:${pct(rect.h, HS_H)};z-index:3;cursor:pointer;display:flex;align-items:center;justify-content:${zoneJc};${zoneBg}`;

    // Hotspot over the text. Top/bottom bands hide their SVG copy (see
    // hideText) and use this element as the only visual, so hover/idle/drag
    // states all show real text — needed for the corner-resize handles below
    // to scale it live. Empty bands show the "Write Here..." placeholder in a
    // muted grey.
    const hot = document.createElement('div');
    hot.className = 'canvas-edit-hotspot';
    const hotColor = hasText ? (t.color || '#111110') : 'rgba(0,0,0,0.28)';
    hot.style.cssText = `max-width:96%;cursor:pointer;${fontStyle(kind)}color:${hotColor};`;
    hot.dataset.baseSize = t.size || 200;
    const phText = kind === 'top' ? 'Sponsored by…' : 'Club name, tagline…';
    hot.textContent = hasText ? t.text : phText;
    const startEdit = e => {
      e.stopPropagation();
      // A free text layer's own pointerdown preventDefaults (for its custom
      // drag), which suppresses the browser's native click-elsewhere blur —
      // so an in-progress free-text edit wouldn't otherwise notice this click.
      commitActiveCanvasEdit(zone);
      deselectTlSlots();
      hideHsToolbar();
      if (UI.activeTextLayerId) {
        UI.activeTextLayerId = null;
        document.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.remove('selected'));
        window.closeTextLayerToolbar?.();
      }
      // Fire even when this zone is already mid-edit (the early-returns below
      // skip everything else on a repeat click) — a sidebar section opened by
      // clicking a different canvas element in between (e.g. a template logo)
      // still needs to close, since a lingering inline text editor here means
      // this element was never actually deselected.
      if (!locked && !isNowEditing()) window.closeHsMenuSection?.(true);
      if (UI.tlJustDragged || zone.querySelector('.canvas-edit-input')) return;
      if (locked && !isNowEditing()) {
        const v = HS.variations.find(v => v.id === HS.activeVarId);
        if (v) beginQuickEdit(v);
      }
      UI.canvasSelectedKind = null;
      UI.canvasEdit = { kind, caret: null };
      enterEdit(zone, kind);
    };
    // Unlocked (full pencil editor): mirrors the free text-layer overlay —
    // a single click/tap anywhere in the zone (the box, not just the glyphs,
    // since the hotspot doesn't cover the full padded box) just selects and
    // highlights it; a second, double-click drops into inline editing.
    // Locked (quick-edit, Variations page): no drag/select step at all, same
    // as the free text-layer's locked mode — a single tap edits immediately.
    const selectZone = e => {
      e.stopPropagation();
      if (UI.tlJustDragged || zone.querySelector('.canvas-edit-input')) return;
      // Tapping an already-selected zone again (not a fast double-click, just
      // a second separate tap) drops into edit mode with the text highlighted
      // — enterEdit's default (no remembered caret) selects all of it.
      if (UI.canvasSelectedKind === kind) { startEdit(e); return; }
      // See startEdit's matching call: a free text layer's own edit doesn't
      // blur on its own when this zone is clicked instead.
      commitActiveCanvasEdit(zone);
      deselectTlSlots();
      hideHsToolbar();
      if (UI.activeTextLayerId) {
        UI.activeTextLayerId = null;
        document.querySelectorAll('.hs-tl-overlay').forEach(el => el.classList.remove('selected'));
        window.closeTextLayerToolbar?.();
      }
      window.closeHsMenuSection?.(true);
      document.querySelectorAll('.canvas-edit-zone').forEach(z => z.classList.remove('selected'));
      zone.classList.add('selected');
      UI.canvasSelectedKind = kind;
      openBandToolbar(kind, zone);
      setTimeout(() => {
        const close = ev => {
          if (ev.target.closest('#hsBandToolbar') || ev.target.closest('.canvas-edit-zone')) return;
          closeBandToolbar();
          UI.canvasSelectedKind = null;
          document.querySelectorAll('.canvas-edit-zone').forEach(z => z.classList.remove('selected'));
          document.removeEventListener('click', close, true);
        };
        document.addEventListener('click', close, true);
      }, 0);
    };
    hot.addEventListener('pointerdown', e => e.stopPropagation());
    zone.appendChild(hot);
    if (locked) {
      hot.addEventListener('click', startEdit);
      zone.addEventListener('click', startEdit);
    } else {
      hot.addEventListener('click', selectZone);
      zone.addEventListener('click', selectZone);
      hot.addEventListener('dblclick', startEdit);
      zone.addEventListener('dblclick', startEdit);
    }

    // Edge handles — drag either side to adjust the box width. The box is
    // always centered within the sign's margins (there's no stored x position,
    // just a width), so both handles grow/shrink it symmetrically from the
    // center rather than sliding one edge independently — that way the live
    // drag preview lands exactly where the centered re-render will put it.
    // Skipped entirely in locked mode: positions/sizes stay fixed there.
    if (!locked) {
    const makeEdge = (cls, sign) => {
      const eh = document.createElement('div');
      eh.className = `hs-tl-resize-${cls}`;
      let ehStartX, ehStartW;
      eh.addEventListener('pointerdown', e => {
        e.stopPropagation();
        eh.setPointerCapture(e.pointerId);
        ehStartX = e.clientX; ehStartW = rect.w;
        document.body.style.cursor = 'ew-resize';
        e.preventDefault();
      });
      eh.addEventListener('pointermove', e => {
        if (!eh.hasPointerCapture(e.pointerId)) return;
        const sx = previewEl.offsetWidth / HS_W;
        const dx = (e.clientX - ehStartX) / sx * sign;
        const newW = Math.max(t.size, Math.min(innerW, Math.round(ehStartW + dx * 2)));
        setProp(kind, 'w', newW);
        const newBox = recomputeBox(kind, { w: newW });
        if (newBox) {
          zone.style.left   = pct(newBox.x, HS_W);
          zone.style.top    = pct(newBox.y, HS_H);
          zone.style.width  = pct(newBox.w, HS_W);
          zone.style.height = pct(newBox.h, HS_H);
        }
      });
      eh.addEventListener('pointerup', () => { document.body.style.cursor = ''; rerenderFinal(); });
      return eh;
    };
    zone.appendChild(makeEdge('l', -1));
    zone.appendChild(makeEdge('r',  1));

    // Corner handles — drag outward to grow font size (and the box width in
    // the same proportion), inward to shrink. Same mechanic (and CSS) as the
    // free text-layer resize corners; only revealed on hover/selected via the
    // shared .hs-tl-overlay CSS.
    {
      const makeCorner = (cls, xSign, ySign) => {
        const ch = document.createElement('div');
        ch.className = `hs-tl-resize-corner ${cls}`;
        let chStartX, chStartY, chStartSize, chStartW;
        ch.addEventListener('pointerdown', e => {
          e.stopPropagation();
          ch.setPointerCapture(e.pointerId);
          chStartX = e.clientX; chStartY = e.clientY; chStartSize = textObj(kind).size;
          chStartW = rect.w;
          document.body.style.cursor = getComputedStyle(ch).cursor || 'nwse-resize';
          e.preventDefault();
        });
        ch.addEventListener('pointermove', e => {
          if (!ch.hasPointerCapture(e.pointerId)) return;
          const dx = (e.clientX - chStartX) * xSign;
          const dy = (e.clientY - chStartY) * ySign;
          const outward = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
          const newSize = Math.max(80, Math.min(1000, Math.round(chStartSize + outward * 1.5)));
          setProp(kind, 'size', newSize);
          const fsPx = Math.max(9, Math.round(newSize * sc));
          hot.style.fontSize = fsPx + 'px';
          hot.dataset.baseSize = newSize;
          const liveInput = zone.querySelector('.canvas-edit-input');
          if (liveInput) { liveInput.style.fontSize = fsPx + 'px'; liveInput.dataset.baseSize = newSize; }

          // Scale the box width along with the font size (same ratio, centered),
          // and recompute the box height via the same layout math the SVG uses
          // — a bigger font may wrap onto more lines, so the box needs to grow
          // taller too, not just wider.
          const ratio = newSize / chStartSize;
          const newW = Math.max(newSize, Math.min(innerW, Math.round(chStartW * ratio)));
          setProp(kind, 'w', newW);
          const newBox = recomputeBox(kind, { size: newSize, w: newW });
          if (newBox) {
            zone.style.left   = pct(newBox.x, HS_W);
            zone.style.top    = pct(newBox.y, HS_H);
            zone.style.width  = pct(newBox.w, HS_W);
            zone.style.height = pct(newBox.h, HS_H);
          }

          const slider = document.getElementById('hsBandSizeSlider');
          const val = document.getElementById('hsBandSizeVal');
          if (slider) slider.value = newSize;
          if (val) val.textContent = newSize;
        });
        ch.addEventListener('pointerup', () => {
          document.body.style.cursor = '';
          rerenderFinal();
        });
        return ch;
      };
      zone.appendChild(makeCorner('tl', -1, -1));
      zone.appendChild(makeCorner('tr',  1, -1));
      zone.appendChild(makeCorner('bl', -1,  1));
      zone.appendChild(makeCorner('br',  1,  1));
    }
    }

    previewEl.appendChild(zone);
  });

  // Restore an in-progress inline edit, or a plain selection (box highlighted,
  // toolbar open, not yet editing), after a live re-render. Mutually exclusive.
  if (UI.canvasEdit) {
    const zone = previewEl.querySelector(`.canvas-edit-zone[data-kind="${UI.canvasEdit.kind}"]`);
    if (zone) enterEdit(zone, UI.canvasEdit.kind);
    else UI.canvasEdit = null;
  } else if (UI.canvasSelectedKind) {
    const zone = previewEl.querySelector(`.canvas-edit-zone[data-kind="${UI.canvasSelectedKind}"]`);
    if (zone) openBandToolbar(UI.canvasSelectedKind, zone);
    else { UI.canvasSelectedKind = null; closeBandToolbar(); }
  }
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
// Mirrors the free text-layer's Delete/Backspace handling (text-layers.js) —
// a selected-but-not-editing band clears its text the same way a free layer
// removes itself. The toolbar's own "Remove" button (built in
// wireCanvasTextEditing, above) does the exact same setText('')+rerender via
// its own closure; reusing that button here (rather than re-deriving the
// closure) keeps the two triggers guaranteed in sync — the toolbar only
// exists while UI.canvasSelectedKind is set, via selectZone/the restore block
// above.
document.addEventListener('keydown', e => {
  if (!UI.canvasSelectedKind) return;
  if (document.activeElement?.closest?.('.canvas-edit-input, #hsBandToolbar, [contenteditable]')) return;
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  e.preventDefault();
  document.querySelector('#hsBandToolbar .hs-tl-tb-delete')?.click();
});
