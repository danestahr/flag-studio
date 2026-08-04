import { HS, UI, eyedropperBtn, getEffectiveState, getEffectiveVariation } from './state.js';
import { renderStep1, updateStep1Preview, stripSlotImages, repositionToolbar } from './design.js';
import { hideHsToolbar } from './logo-utils.js';
import { ensureTlSlots, snapTlSlotsToDefaults, tlSource } from './template-logos.js';
import { renderEditor } from './var-editor.js';
import { renderVariationPreview } from './var-canvas.js';
import { HS_BANNER_MAX_H, HS_BANNER_MIN_H, HS_FONTS, HS_H, HS_MARGIN, HS_W, emptyBanner } from '../hole-sign-data.js';
import { dockedLayerPositions, dockedLayers, getBannerRect, getLogoZone, getTemplateLogoSlots, getTextRegions, renderHoleSignInto } from '../hole-sign-render.js';
import { uploadLogo } from '../supabase.js';
import { logoThumbHtml } from '../media-utils.js';

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
  if (HS.editingVarId) { renderEditor(); renderVariationPreview(); }
  else renderStep1();
}
export function redrawBannerPreview() {
  if (HS.editingVarId) renderVariationPreview();
  else updateStep1Preview();
}

export function renderBannerSection(which) {
  const b = bannerSource(which);
  const label = which === 'top' ? 'Top banner' : 'Bottom banner';
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  const enabled = !!b.enabled;

  const toggle = `
    <div class="hs-section">
      <div class="hs-section-title">${label} <span class="hs-optional">(full-width strip)</span></div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${enabled ? ' active' : ''}" onclick="setBannerEnabled('${which}',true)">On</button>
        <button class="hs-tog-btn${!enabled ? ' active' : ''}" onclick="setBannerEnabled('${which}',false)">Off</button>
      </div>
    </div>`;
  if (!enabled) return toggle;

  const heightPct = Math.round((b.height - HS_BANNER_MIN_H) / (HS_BANNER_MAX_H - HS_BANNER_MIN_H) * 100);
  const bg = b.bg || {};
  let bgControls;
  if (bg.type === 'image') {
    if (bg.imageUrl) {
      bgControls = `
        <div class="banner-img-drag-wrap" id="bannerImgWrap${cap}"
             onpointerdown="bannerImgDragStart(event,'${which}')"
             onwheel="bannerImgWheel(event,'${which}')">
          <div class="banner-img-drag-thumb" id="bannerImgThumb${cap}"
               style="background-image:url('${bg.imageUrl.replace(/'/g,'%27')}');background-position:${bg.imageX??50}% ${bg.imageY??50}%;background-size:${bg.imageScale??100}% auto;"></div>
          <div class="banner-img-drag-hint">Drag to reposition · Scroll to scale</div>
        </div>
        <button class="btn sm" style="margin-top:6px" onclick="removeBannerImage('${which}')">Remove image</button>`;
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
      <div class="hs-section-title">Height <span id="hsBanner${cap}HeightVal" class="hs-optional">${heightPct}%</span></div>
      <div class="hs-canvas-hint">Drag the line on the banner's edge in the canvas to resize.</div>
    </div>
    <div class="hs-section">
      <div class="hs-section-title">Text alignment <span class="hs-optional">(within the banner)</span></div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${valign === 'top' ? ' active' : ''}" onclick="setBannerValign('${which}','top')">Top</button>
        <button class="hs-tog-btn${valign === 'center' ? ' active' : ''}" onclick="setBannerValign('${which}','center')">Center</button>
        <button class="hs-tog-btn${valign === 'bottom' ? ' active' : ''}" onclick="setBannerValign('${which}','bottom')">Bottom</button>
      </div>
    </div>
    <div class="hs-section">
      <div class="hs-section-title">Background</div>
      <div class="hs-bg-toggle">
        <button class="hs-tog-btn${(bg.type || 'color') === 'color' ? ' active' : ''}" onclick="setBannerBgType('${which}','color')">Color</button>
        <button class="hs-tog-btn${bg.type === 'image' ? ' active' : ''}" onclick="setBannerBgType('${which}','image')">Image</button>
      </div>
      ${bgControls}
    </div>
    <div class="hs-section">
      <div class="hs-section-title">Text spacing <span id="hsBanner${cap}SpacingVal" class="hs-optional">${b.spacing || 0}</span></div>
      <div class="hs-canvas-hint">Drag a free text layer into this banner to dock it — drag the line between stacked layers in the canvas to adjust their spacing.</div>
    </div>`;
}

window.setBannerEnabled = function (which, on) { bannerSource(which).enabled = !!on; redrawBannerStructural(); };
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
    redrawBannerStructural();
  } catch (err) { console.error('Banner image upload failed', err); }
};
window.removeBannerImage = function (which) {
  const b = bannerSource(which);
  b.bg.imageUrl = null;
  b.bg.storagePath = null;
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
  const cap = which === 'bottom' ? 'Bottom' : 'Top';
  const wrap  = document.getElementById('bannerImgWrap'  + cap);
  const thumb = document.getElementById('bannerImgThumb' + cap);
  if (!wrap || !thumb) return;
  const b = bannerSource(which);
  if (!b.bg) b.bg = {};
  const bg = b.bg;
  const x0 = e.clientX, y0 = e.clientY;
  const ix0 = bg.imageX ?? 50, iy0 = bg.imageY ?? 50;
  wrap.setPointerCapture(e.pointerId);
  let raf = null;
  function onMove(ev) {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; });
    const dx = (ev.clientX - x0) / wrap.offsetWidth  * 100;
    const dy = (ev.clientY - y0) / wrap.offsetHeight * 100;
    bg.imageX = Math.max(0, Math.min(100, ix0 - dx));
    bg.imageY = Math.max(0, Math.min(100, iy0 - dy));
    thumb.style.backgroundPosition = `${bg.imageX}% ${bg.imageY}%`;
    if (HS.editingVarId) renderVariationPreview(); else updateStep1Preview();
  }
  function onUp() {
    wrap.removeEventListener('pointermove', onMove);
    wrap.removeEventListener('pointerup', onUp);
    if (HS.editingVarId) renderVariationPreview(); else updateStep1Preview();
  }
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
};

window.bannerImgWheel = function (e, which) {
  e.preventDefault();
  const cap = which === 'bottom' ? 'Bottom' : 'Top';
  const thumb = document.getElementById('bannerImgThumb' + cap);
  const b = bannerSource(which);
  if (!b.bg) b.bg = {};
  const bg = b.bg;
  const delta = e.deltaY > 0 ? -5 : 5;
  bg.imageScale = Math.max(100, Math.min(300, (bg.imageScale ?? 100) + delta));
  if (thumb) thumb.style.backgroundSize = `${bg.imageScale}% auto`;
  clearTimeout(window._bannerWheelT);
  window._bannerWheelT = setTimeout(() => {
    if (HS.editingVarId) renderVariationPreview(); else updateStep1Preview();
  }, 80);
};

window.setBannerValign = function (which, val) {
  bannerSource(which).valign = val;
  redrawBannerStructural();
};
window.setBannerSpacing = function (which, val) {
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  bannerSource(which).spacing = parseInt(val, 10) || 0;
  const lbl = document.getElementById('hsBanner' + cap + 'SpacingVal');
  if (lbl) lbl.textContent = parseInt(val, 10) || 0;
  redrawBannerPreview();
};

window.quickAdd = function (kind, position) {
  const editing = !!(HS.editingVarId && HS.editingDraft);
  if (kind === 'banner') {
    const openMenu = editing ? window.openHsVarMenu : window.openHsMenu;
    const b = bannerSource(position);  // position is 'top' | 'bottom'
    b.enabled = true;
    openMenu(position === 'bottom' ? 'bannerBottom' : 'bannerTop');
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
    const bgVar = (editingVar && !editingVar.logoSrc) ? getEffectiveVariation(editingVar) : null;
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
function syncLogoZone(previewEl, st) {
  const lz = getLogoZone(st, st.templateStyle);
  if (!lz) return;
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  previewEl.querySelectorAll('.dzone').forEach(dzone => {
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
// existing Shift-drag edge-snap threshold (design.js's snapNearest).
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

export function showDockHighlight(previewEl, state, which) {
  const rect = getBannerRect(state, which);
  if (!rect) { clearDockHighlight(previewEl); return; }
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  let el = previewEl.querySelector('.hs-dock-highlight');
  if (!el) {
    el = document.createElement('div');
    el.className = 'hs-dock-highlight band-drop-target active';
    el.style.cssText = 'position:absolute;left:0;width:100%;z-index:4;';
    previewEl.appendChild(el);
  }
  el.style.top = pct(rect.y, HS_H);
  el.style.height = pct(rect.h, HS_H);
}

export function clearDockHighlight(previewEl) {
  previewEl.querySelector('.hs-dock-highlight')?.remove();
}

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
    if (heightHandle && rect) {
      const edgeY = which === 'bottom' ? rect.y : rect.y + rect.h;
      heightHandle.style.top = pct(edgeY, HS_H);
    }
    const spacingHandle = previewEl.querySelector(`.hs-banner-spacing-handle[data-which="${which}"]`);
    if (spacingHandle && rect && banner) {
      const mid = dockGapMid(st, which);
      if (mid != null) spacingHandle.style.top = pct(mid, HS_H);
    }
  });
}

// Re-render just the background SVG in place (leaving DOM overlay handles
// untouched) so live drags get real layout feedback — same technique as
// beginBandSnap's reflowTo. Returns the fresh effective state so callers can
// reposition their own handle from it.
function reflowBannerSvg(previewEl, editingVar) {
  const st = getEffectiveState(editingVar);
  const bgVar = (editingVar && !editingVar.logoSrc) ? getEffectiveVariation(editingVar) : null;
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

// On-canvas drag handle for banner height — a small line at the banner's free
// edge (bottom edge for the top banner, top edge for the bottom banner) that
// drags the height directly, in place of the sidebar slider.
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
    handle.title = 'Drag to resize banner height';

    let startY, startHeight;
    handle.addEventListener('pointerdown', e => {
      e.stopPropagation();
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
      const dy = (e.clientY - startY) / sy;
      const b = bannerSource(which);
      b.spacing = Math.max(0, Math.min(500, Math.round(startSpacing + dy * 2)));
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

export function wireCanvasTextEditing(previewEl) {
  const editing = HS.editingVarId && HS.editingDraft;
  const state = getEffectiveState(editing ? HS.variations.find(v => v.id === HS.editingVarId) : null);
  // Keep the active text band alive even if its text is momentarily cleared,
  // so clearing the text doesn't dismiss the editor.
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
    const obj = editing ? HS.editingDraft : HS;
    const k = kind === 'top' ? 'topText' : 'bottomText';
    obj[k] = { ...obj[k], text: value };
    // Per-variation overrides (HS.editingDraft) aren't part of the Step-1
    // template-switch carry-over logic, so only the main design state counts.
    if (!editing) {
      const slot = kind === 'top' ? 'primary' : 'secondary';
      HS.captionsEdited[slot] = true;
    }
  };
  // Same idea as setText but for font/size/color/align — used by the on-canvas
  // toolbar (setText's text-only path stays separate since inline typing has
  // its own commit flow).
  const setProp = (kind, prop, value) => {
    const obj = editing ? HS.editingDraft : HS;
    const k = kind === 'top' ? 'topText' : 'bottomText';
    obj[k] = { ...obj[k], [prop]: value };
  };
  // Live: re-render the preview only (re-runs this wiring, which restores the
  // input below). Final: also refresh the side controls.
  const rerenderLive = () => { UI.canvasRerendering = true; if (editing) renderVariationPreview(); else updateStep1Preview(); UI.canvasRerendering = false; };
  const rerenderFinal = () => { if (editing) { renderEditor(); renderVariationPreview(); } else updateStep1Preview(); };

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
    input.style.cssText = `width:100%;height:100%;box-sizing:border-box;outline:none;display:flex;align-items:center;${fontStyle(kind)}caret-color:${textColor};`;
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
      rerenderFinal();
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
      setTimeout(() => {
        // A corner-handle drag or toolbar change can trigger a re-render (and
        // thus this same blur) synchronously; by the time this deferred check
        // runs, a newer edit session may have already replaced this input via
        // the "restore in-progress edit" logic below. Don't finalize a stale one.
        if (!input.isConnected) return;
        if (document.activeElement?.closest?.('#hsBandToolbar')) return;
        if (!UI.canvasRerendering) finalize();
      }, 100);
    });
  };

  Object.entries(regions).forEach(([kind, rect]) => {
    const t = textObj(kind);
    const hasText = !!(t.text && t.text.trim());
    const isActive = UI.canvasEdit?.kind === kind;
    const zone = document.createElement('div');
    // hs-tl-overlay reuses the free text-layer's hover/selected border + the
    // resize-corner hover-reveal CSS (same purple `--guides` selected color).
    zone.className = 'canvas-edit-zone hs-tl-overlay' + (isActive ? ' selected' : '');
    zone.dataset.kind = kind;
    // Empty text bands get a subtle grey background so the zone is visible.
    const zoneBg = !hasText ? 'background:rgba(0,0,0,0.05);border-radius:6px;' : '';
    // Zones match the text alignment so the hotspot / editor sits at the same
    // edge as the rendered SVG text.
    const zoneJc = alignJc(t.align || 'center');
    zone.style.cssText = `position:absolute;left:${pct(rect.x, HS_W)};top:${pct(rect.y, HS_H)};width:${pct(rect.w, HS_W)};height:${pct(rect.h, HS_H)};z-index:3;cursor:text;display:flex;align-items:center;justify-content:${zoneJc};${zoneBg}`;

    // Hotspot over the text. Top/bottom bands hide their SVG copy (see
    // hideText) and use this element as the only visual, so hover/idle/drag
    // states all show real text — needed for the corner-resize handles below
    // to scale it live. Empty bands show the "Write Here..." placeholder in a
    // muted grey.
    const hot = document.createElement('div');
    hot.className = 'canvas-edit-hotspot';
    const hotColor = hasText ? (t.color || '#111110') : 'rgba(0,0,0,0.28)';
    hot.style.cssText = `max-width:96%;cursor:text;${fontStyle(kind)}color:${hotColor};`;
    const phText = kind === 'top' ? 'Sponsored by…' : 'Club name, tagline…';
    hot.textContent = hasText ? t.text : phText;
    const startEdit = e => {
      e.stopPropagation();
      if (UI.tlJustDragged || zone.querySelector('.canvas-edit-input')) return;
      UI.canvasEdit = { kind, caret: null };
      enterEdit(zone, kind);
    };
    hot.addEventListener('pointerdown', e => e.stopPropagation());
    hot.addEventListener('click', startEdit);
    zone.appendChild(hot);
    // Clicking the empty area of the text band also edits it.
    zone.addEventListener('click', startEdit);

    // Edge handles — drag either side to adjust the box width. The box is
    // always centered within the sign's margins (there's no stored x position,
    // just a width), so both handles grow/shrink it symmetrically from the
    // center rather than sliding one edge independently — that way the live
    // drag preview lands exactly where the centered re-render will put it.
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
          const liveInput = zone.querySelector('.canvas-edit-input');
          if (liveInput) liveInput.style.fontSize = fsPx + 'px';

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

    previewEl.appendChild(zone);
  });

  // Restore an in-progress inline edit after a live re-render.
  if (UI.canvasEdit) {
    const zone = previewEl.querySelector(`.canvas-edit-zone[data-kind="${UI.canvasEdit.kind}"]`);
    if (zone) enterEdit(zone, UI.canvasEdit.kind);
    else UI.canvasEdit = null;
  }
}
