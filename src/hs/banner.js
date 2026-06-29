import { HS, UI, alignBtns, eyedropperBtn, fontSelect, getEffectiveState, getEffectiveVariation, syncAlignBtns } from './state.js';
import { renderStep1, updateStep1Preview, stripSlotImages } from './design.js';
import { hideHsToolbar } from './logo-utils.js';
import { closeTlSlotToolbar, ensureTlSlots, snapTlSlotsToDefaults, tlSource } from './template-logos.js';
import { renderEditor } from './var-editor.js';
import { renderVariationPreview } from './var-canvas.js';
import { HS_BANNER_MAX_H, HS_BANNER_MIN_H, HS_FONTS, HS_H, HS_TEMPLATES, HS_W, emptyBanner, emptyTemplateLogos } from '../hole-sign-data.js';
import { escXml, getTemplateLogoSlots, getTextRegions, renderHoleSignInto } from '../hole-sign-render.js';
import { uploadLogo } from '../supabase.js';

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

export function renderBannerTextControls(which, key, label, t) {
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  return `
    <div class="hs-section">
      <div class="hs-section-title">${label} <span class="hs-optional">(optional)</span></div>
      <input class="hexin" style="width:100%" placeholder="${key === 'topText' ? 'Sponsored by…' : 'Subtitle…'}" value="${escXml(t.text)}"
        oninput="setBannerTextProp('${which}','${key}','text',this.value)">
      ${fontSelect(`setBannerTextProp('${which}','${key}','font',this.value)`, t.font)}
      ${alignBtns(t.align, `setBannerTextProp('${which}','${key}','align'`)}
      <div style="display:flex;align-items:center;gap:8px">
        <input type="range" min="80" max="1000" value="${t.size}"
          oninput="setBannerTextProp('${which}','${key}','size',this.value)" style="flex:1">
        <span id="hsBanner${cap}${key}SizeLabel" style="font-size:12px;color:var(--gray-600);min-width:50px">${t.size}pt</span>
      </div>
      <div class="color-row">
        <input type="color" class="hs-color-swatch" id="hsBanner${cap}${key}Swatch" value="${t.color}"
          oninput="setBannerTextProp('${which}','${key}','color',this.value)">
        <input type="text" class="hexin" style="flex:1" maxlength="7" value="${t.color}"
          oninput="setBannerTextColorHex('${which}','${key}',this.value)">
        ${eyedropperBtn('hsBanner' + cap + key + 'Swatch')}
      </div>
    </div>`;
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

  return `
    ${toggle}
    <div class="hs-section">
      <div class="hs-section-title">Height</div>
      <div class="tl-row">
        <div class="tl-row-label">Height</div>
        <div class="tl-size-slider">
          <input type="range" min="${HS_BANNER_MIN_H}" max="${HS_BANNER_MAX_H}" step="10" value="${b.height}" oninput="setBannerHeight('${which}',this.value)">
          <span class="tl-size-value" id="hsBanner${cap}HeightVal">${heightPct}%</span>
        </div>
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
    ${renderBannerTextControls(which, 'topText', 'Title', b.topText)}
    <div class="hs-section">
      <div class="hs-section-title">Text spacing</div>
      <div class="tl-row">
        <div class="tl-size-slider">
          <input type="range" min="0" max="500" step="10" value="${b.spacing || 0}"
            oninput="setBannerSpacing('${which}',this.value)">
          <span class="tl-size-value" id="hsBanner${cap}SpacingVal">${b.spacing || 0}</span>
        </div>
      </div>
    </div>
    ${renderBannerTextControls(which, 'subText', 'Sub-text', b.subText)}`;
}

export function renderBannerControls() {
  return renderBannerSection('top') + '<div class="sdivider"></div>' + renderBannerSection('bottom');
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

window.setBannerSpacing = function (which, val) {
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  bannerSource(which).spacing = parseInt(val, 10) || 0;
  const lbl = document.getElementById('hsBanner' + cap + 'SpacingVal');
  if (lbl) lbl.textContent = parseInt(val, 10) || 0;
  redrawBannerPreview();
};

window.setBannerTextProp = function (which, key, prop, val) {
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  const obj = bannerSource(which)[key];
  if (prop === 'size') {
    obj.size = parseInt(val, 10);
    const lbl = document.getElementById('hsBanner' + cap + key + 'SizeLabel');
    if (lbl) lbl.textContent = obj.size + 'pt';
    redrawBannerPreview();
  } else if (prop === 'font') {
    obj.font = val;
    redrawBannerPreview();
  } else {
    obj[prop] = val;
    redrawBannerPreview();
    if (prop === 'align') syncAlignBtns(val);
  }
};
window.setBannerTextColorHex = function (which, key, val) {
  const c = val.startsWith('#') ? val : '#' + val;
  if (!/^#[0-9A-Fa-f]{6}$/.test(c)) return;
  const cap = which === 'bottom' ? 'Bot' : 'Top';
  bannerSource(which)[key].color = c;
  const s = document.getElementById('hsBanner' + cap + key + 'Swatch'); if (s) s.value = c;
  redrawBannerPreview();
};

// ── Hover quick-add ───────────────────────────────────────
// Hovering near the top or bottom edge of a preview reveals a small toolbar
// offering what can be placed in that band (banner / text / logos), so the
// available options are discoverable directly on the template.
// Which band (top/bottom) currently has its inline logo-count selector expanded.

export function quickAddTemplateInfo() {
  const editing = !!(HS.editingVarId && HS.editingDraft);
  const tid = editing ? HS.editingDraft.templateStyle : HS.templateStyle;
  const tmpl = HS_TEMPLATES.find(t => t.id === tid) || HS_TEMPLATES[0];
  return { supportsText: tmpl.supportsText, allowsLogos: tid !== 'hole-sign-logo-only' };
}

export function currentTemplateLogos() {
  return (HS.editingVarId && HS.editingDraft)
    ? (HS.editingDraft.templateLogos || emptyTemplateLogos())
    : (HS.templateLogos || emptyTemplateLogos());
}

export function currentBannerFor(which) {
  const key = which === 'bottom' ? 'bannerBottom' : 'bannerTop';
  return (HS.editingVarId && HS.editingDraft) ? (HS.editingDraft[key] || emptyBanner()) : (HS[key] || emptyBanner());
}
export function currentText(which) {
  const src = (HS.editingVarId && HS.editingDraft) ? HS.editingDraft : HS;
  return which === 'bottom' ? src.bottomText : src.topText;
}

export function buildQuickAddBar(position) {
  const { supportsText, allowsLogos } = quickAddTemplateInfo();
  const chips = [];

  // Banner: show a chip for each position that doesn't yet have an active banner.
  const banner = currentBannerFor(position);
  if (!banner.enabled) chips.push(`<button class="qa-chip" onclick="quickAdd('banner','${position}')">+ Banner</button>`);

  // Text: hide the option for a band that already has text.
  if (supportsText) {
    const hasText = !!(currentText(position).text || '').trim();
    if (!hasText) chips.push(`<button class="qa-chip" onclick="quickAdd('text','${position}')">+ ${position === 'bottom' ? 'Bottom ' : ''}Text</button>`);
  }

  // Logos: when this band already has logos, show only the 1/2/3 count + Remove.
  if (allowsLogos) {
    const tl = currentTemplateLogos();
    const logosHere = tl.count > 0 && tl.vAlign === position;
    if (logosHere || UI.qaLogosOpen === position) {
      const cur = logosHere ? tl.count : 1;
      const nums = [1, 2, 3].map(n =>
        `<button class="qa-num${cur === n ? ' active' : ''}" onclick="quickAddLogosCount('${position}',${n})">${n}</button>`).join('');
      chips.push(`<span class="qa-bar-label">Logos</span><span class="qa-nums">${nums}</span><button class="qa-chip qa-remove" onclick="quickAddLogosRemove('${position}')">Remove</button>`);
    } else {
      chips.push(`<button class="qa-chip" onclick="quickAddLogos('${position}')">+ Logos</button>`);
    }
  }

  chips.push(`<button class="qa-chip" onclick="addTextLayer()">+ Text layer</button>`);
  const label = chips.length ? `<span class="qa-bar-label">Add to ${position}</span>` : '';
  return `<div class="qa-bar qa-${position}">${label}${chips.join('')}</div>`;
}

export function wireQuickAddHover(previewEl) {
  if (!previewEl) return;
  ['top', 'bottom'].forEach(pos => {
    const wrap = document.createElement('div');
    wrap.innerHTML = buildQuickAddBar(pos);
    previewEl.appendChild(wrap.firstElementChild);
  });
  const topBar = previewEl.querySelector('.qa-top');
  const botBar = previewEl.querySelector('.qa-bottom');
  // Assign (not addEventListener) so re-renders overwrite rather than stack.
  previewEl.onmousemove = e => {
    const r = previewEl.getBoundingClientRect();
    const ry = (e.clientY - r.top) / r.height;
    if (topBar) topBar.classList.toggle('show', ry < 0.28);
    if (botBar) botBar.classList.toggle('show', ry > 0.72);
  };
  previewEl.onmouseleave = () => {
    if (topBar) topBar.classList.remove('show');
    if (botBar) botBar.classList.remove('show');
  };
}

window.quickAdd = function (kind, position) {
  const editing = !!(HS.editingVarId && HS.editingDraft);
  const openMenu = editing ? window.openHsVarMenu : window.openHsMenu;
  if (kind === 'banner') {
    const b = bannerSource(position);  // position is 'top' | 'bottom'
    b.enabled = true;
    openMenu(position === 'bottom' ? 'bannerBottom' : 'bannerTop');
  } else if (kind === 'text') {
    openMenu(position === 'bottom' ? 'bottom' : 'top');
  }
};

export function quickAddRedraw() {
  if (HS.editingVarId) renderVariationPreview();
  else updateStep1Preview();
}

// "+ Logos" tap: expand the inline count selector and place one logo by default.
window.quickAddLogos = function (position) {
  const tl = tlSource();
  if (!tl.count) { tl.count = 1; ensureTlSlots(); }
  tl.vAlign = position;
  snapTlSlotsToDefaults(tl);
  UI.qaLogosOpen = position;
  quickAddRedraw();
};

// Picking a number in the inline selector updates how many logo slots there are.
window.quickAddLogosCount = function (position, n) {
  const tl = tlSource();
  tl.count = n;
  ensureTlSlots();
  tl.vAlign = position;
  snapTlSlotsToDefaults(tl);
  UI.qaLogosOpen = position;
  quickAddRedraw();
};

// Remove all template logos from the band.
window.quickAddLogosRemove = function () {
  const tl = tlSource();
  tl.count = 0;
  ensureTlSlots();
  UI.tlSelectedIdx = null;
  UI.qaLogosOpen = null;
  closeTlSidePanel();
  closeTlSlotToolbar();
  quickAddRedraw();
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
      ? `<div class="band-ghost-logos">${slots.map(s => `<img src="${escXml(s.logoSrcTight || s.logoSrc)}">`).join('')}</div>`
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
    renderHoleSignInto(tmp, stripSlotImages(st), bgVar);
    const newSvg = tmp.querySelector('svg');
    const oldSvg = previewEl.querySelector('svg');
    if (newSvg && oldSvg) {
      newSvg.setAttribute('style', oldSvg.getAttribute('style') || '');
      oldSvg.replaceWith(newSvg);
    }
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
  // Keep the active text band alive even if its text is momentarily cleared.
  const forceText = (UI.canvasEdit && (UI.canvasEdit.kind === 'top' || UI.canvasEdit.kind === 'bottom')) ? [UI.canvasEdit.kind] : [];
  const regions = getTextRegions(state, state.templateStyle, forceText);
  const sc = (previewEl.clientHeight || HS_H) / HS_H;
  const fam = id => (HS_FONTS.find(f => f.id === id)?.family) || "'DM Sans', sans-serif";
  const pct = (v, total) => (v / total * 100).toFixed(4) + '%';
  const textObj = kind =>
    kind === 'bannerTopTitle' ? state.bannerTop.topText
    : kind === 'bannerTopSub' ? state.bannerTop.subText
    : kind === 'bannerBotTitle' ? state.bannerBottom.topText
    : kind === 'bannerBotSub'   ? state.bannerBottom.subText
    : kind === 'top' ? state.topText : state.bottomText;
  const setText = (kind, value) => {
    if      (kind === 'bannerTopTitle') bannerSource('top').topText.text    = value;
    else if (kind === 'bannerTopSub')   bannerSource('top').subText.text    = value;
    else if (kind === 'bannerBotTitle') bannerSource('bottom').topText.text = value;
    else if (kind === 'bannerBotSub')   bannerSource('bottom').subText.text = value;
    else {
      const obj = editing ? HS.editingDraft : HS;
      const k = kind === 'top' ? 'topText' : 'bottomText';
      obj[k] = { ...obj[k], text: value };
    }
  };
  // Live: re-render the preview only (re-runs this wiring, which restores the
  // input below). Final: also refresh the side controls.
  const rerenderLive = () => { UI.canvasRerendering = true; if (editing) renderVariationPreview(); else updateStep1Preview(); UI.canvasRerendering = false; };
  const rerenderFinal = () => { if (editing) { renderEditor(); renderVariationPreview(); } else updateStep1Preview(); };

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
    input.dataset.ph = kind === 'top' ? 'Sponsored by…'
      : kind === 'bottom' ? 'Club name, tagline…'
      : kind === 'bannerTopTitle' || kind === 'bannerBotTitle' ? 'Sponsored by…'
      : 'Subtitle…';
    input.textContent = t.text || '';
    // The input is transparent — the SVG text stays visible as the display layer.
    // Only the cursor and selection highlight come from the HTML side.
    const textColor = textObj(kind).color || '#111110';
    input.style.cssText = `width:100%;height:100%;box-sizing:border-box;outline:none;display:flex;align-items:center;${fontStyle(kind)}color:transparent;caret-color:${textColor};`;
    // The SVG text for this band is hidden while editing (no halo), so the live
    // editor sits over the band background without needing an opaque cover.
    zone.innerHTML = '';
    zone.appendChild(input);
    input.focus();
    const caret = (UI.canvasEdit && UI.canvasEdit.kind === kind) ? UI.canvasEdit.caret : null;
    if (caret != null) setCaret(input, caret); else selectAll(input);

    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      UI.canvasEdit = null;
      setText(kind, input.textContent);
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
    input.addEventListener('blur', () => { if (!UI.canvasRerendering) finalize(); });
  };

  Object.entries(regions).forEach(([kind, rect]) => {
    const t = textObj(kind);
    const isBanner = kind.startsWith('banner');
    const hasText = !!(t.text && t.text.trim());
    const zone = document.createElement('div');
    zone.className = 'canvas-edit-zone' + (isBanner ? ' is-banner' : '');
    zone.dataset.kind = kind;
    // Banner band is draggable → grab hand on the empty box; text bands are
    // purely editable → text cursor across the band.
    // Empty text bands get a subtle grey background so the zone is visible.
    const zoneBg = (!isBanner && !hasText) ? 'background:rgba(0,0,0,0.05);border-radius:6px;' : '';
    // Banners always center their content; body text zones match the text alignment
    // so the hotspot / editor sits at the same edge as the rendered SVG text.
    const zoneJc = isBanner ? 'center' : alignJc(t.align || 'center');
    zone.style.cssText = `position:absolute;left:${pct(rect.x, HS_W)};top:${pct(rect.y, HS_H)};width:${pct(rect.w, HS_W)};height:${pct(rect.h, HS_H)};z-index:3;cursor:${isBanner ? 'default' : 'text'};display:flex;align-items:center;justify-content:${zoneJc};${zoneBg}`;
    if (isBanner) zone.addEventListener('click', e => {
      if (!e.target.closest('.canvas-edit-hotspot')) {
        const menuKey = kind.startsWith('bannerTop') ? 'bannerTop' : 'bannerBottom';
        if (!editing) window.openHsMenuSection?.(menuKey);
      }
    });

    // Hotspot over the text: I-beam cursor + click to edit.
    // When the band has text, it's transparent so the SVG text shows through.
    // When empty, show the "Write Here..." placeholder in a muted grey.
    const hot = document.createElement('div');
    hot.className = 'canvas-edit-hotspot';
    const hotColor = (!isBanner && !hasText) ? 'rgba(0,0,0,0.28)' : 'transparent';
    hot.style.cssText = `max-width:96%;cursor:text;${fontStyle(kind)}color:${hotColor};`;
    const phText = kind === 'top' ? 'Sponsored by…'
      : kind === 'bottom' ? 'Club name, tagline…'
      : kind === 'bannerTopTitle' || kind === 'bannerBotTitle' ? 'Sponsored by…'
      : 'Subtitle…';
    hot.textContent = hasText ? t.text : phText;
    const startEdit = e => {
      e.stopPropagation();
      if (UI.tlJustDragged || zone.querySelector('.canvas-edit-input')) return;
      UI.canvasEdit = { kind, caret: null };
      if (!editing) window.openHsMenuSection?.(isBanner ? (kind.startsWith('bannerTop') ? 'bannerTop' : 'bannerBottom') : kind);
      // The SVG text stays visible (no hideText). The HTML input is transparent
      // so there is no halo — just place the editor directly.
      enterEdit(zone, kind);
    };
    hot.addEventListener('pointerdown', e => e.stopPropagation());
    hot.addEventListener('click', startEdit);
    zone.appendChild(hot);
    // Clicking the empty area of a (non-draggable) text band also edits it.
    if (!isBanner) zone.addEventListener('click', startEdit);

    previewEl.appendChild(zone);
  });

  // Restore an in-progress inline edit after a live re-render.
  if (UI.canvasEdit) {
    const zone = previewEl.querySelector(`.canvas-edit-zone[data-kind="${UI.canvasEdit.kind}"]`);
    if (zone) enterEdit(zone, UI.canvasEdit.kind);
    else UI.canvasEdit = null;
  }
}
