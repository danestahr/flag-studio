// Public, no-login template picker — mounted on index.html both for
// anonymous visitors (the whole page) and signed-in users (behind a "Browse
// templates" toggle), plus the flag browse step on its own page
// (browse-flags.html). No auth/project-creation logic of its own - callers
// route into the login/event-info hand-off from whatever a card reports.
import { FLAGS } from './data.js';
import { loadAllFlags } from './svgLoader.js';
import { applyColors } from './render.js';
import { HS_TEMPLATES, HS_DEFAULT_TEMPLATES, emptyBanner, emptyTemplateLogos } from './hole-sign-data.js';
import { renderHoleSignInto } from './hole-sign-render.js';
import { esc } from './dom-utils.js';

// Same clean-slate state a built-in hole-sign template starts from in the
// in-editor onboarding picker (hs/design.js's HS_BUILTIN_DEFAULTS) — kept as
// an independent copy here rather than imported, so this public-facing page
// never pulls in the editor's stateful HS singleton.
const HS_PREVIEW_STATE = {
  background: { type: 'color', color: '#FFFFFF', imageUrl: null, storagePath: null },
  topText:    { text: 'Sponsored By', font: 'dm-serif', size: 300, color: '#111110' },
  bottomText: { text: '', font: 'dm-serif', size: 300, color: '#111110' },
  bannerTop: emptyBanner(),
  bannerBottom: emptyBanner(),
  templateLogos: emptyTemplateLogos(),
  textLayers: [],
};

// Mirrors order.js's buildFlagSvgHtml (renders a flag template at its
// default, unpicked colors) — kept local rather than imported since order.js
// pulls in unrelated intake-form logic. `colorOverride` lets a caller paint
// the zones something other than their real defaults (used for the hover
// preview swatch below) without touching applyColors' own default-fill logic.
function buildFlagSvgHtml(flag, colorOverride = null) {
  if (!flag?.svgContent) return '';
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.innerHTML = flag.svgContent;
  applyColors(svg, colorOverride || {}, flag.noColors, flag);
  return svg.outerHTML;
}

// Looks up a selected template's display name across both product types —
// used by the side selection panel (landing.js/gallery-side-panel.js) to
// label whatever was last clicked, without that module needing its own
// copies of FLAGS/HS_TEMPLATES/HS_DEFAULT_TEMPLATES.
export function templateName(type, templateId) {
  if (type === 'flag') return FLAGS.find(f => f.id === templateId)?.name || '';
  return (HS_TEMPLATES.find(t => t.id === templateId) || HS_DEFAULT_TEMPLATES.find(t => t.id === templateId))?.name || '';
}

// Renders a single selected template's preview into `el` — the same visual
// as its grid thumbnail, without the hover/"Start designing" chrome. FLAGS
// must already be loaded (renderTemplateGallery's grid render awaits this
// before any card is clickable, so by the time onSelect can fire this is
// already true).
export function renderSelectedThumb(el, type, templateId) {
  if (type === 'flag') {
    const flag = FLAGS.find(f => f.id === templateId);
    el.innerHTML = flag ? buildFlagSvgHtml(flag) : '';
    return;
  }
  const t = HS_TEMPLATES.find(x => x.id === templateId);
  if (t) { renderHoleSignInto(el, HS_PREVIEW_STATE, { templateId: t.id }); return; }
  const dt = HS_DEFAULT_TEMPLATES.find(x => x.id === templateId);
  if (dt) renderHoleSignInto(el, dt, { templateId: dt.templateStyle });
}

// Re-renders a flag's selected-template preview (see renderSelectedThumb
// above) with an optional color override and a logo composited on top -
// used by login.js right after a GolfStatus sync so the split-right preview
// already shows what the real editor will, instead of a plain colored
// shape. Purely visual: builds a data-URL <image> positioned with the same
// zone-relative math as the real renderer (render.js's makeSvg - centered,
// 80% of the zone's own width), rather than going through the actual
// upload/library/flag_config pipeline, since this can run before a project
// even exists. Flags only - hole signs have no equivalent preview surface
// here. No-ops quietly (leaving whatever's already rendered) if the
// template has no logo zone or logoSrc is falsy.
export async function overlayLogoOnThumb(el, templateId, logoSrc, colors = null) {
  const flag = FLAGS.find(f => f.id === templateId);
  const zone = flag?.logoZones?.[0];
  if (!flag || !zone || !logoSrc) return;

  el.innerHTML = buildFlagSvgHtml(flag, colors);
  const svg = el.querySelector('svg');
  if (!svg) return;

  const aspect = await new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1);
    img.onerror = () => resolve(1);
    img.src = logoSrc;
  });

  const logoW = zone.w * 0.8;
  const logoH = logoW / aspect;
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;
  const image = document.createElementNS('http://www.w3.org/2000/svg', 'image');
  image.setAttribute('href', logoSrc);
  image.setAttribute('x', cx - logoW / 2);
  image.setAttribute('y', cy - logoH / 2);
  image.setAttribute('width', logoW);
  image.setAttribute('height', logoH);
  image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.appendChild(image);
}

// Entry point: just the two picker tiles - nothing else on screen. Neither
// choice browses inline here anymore: Tournament Flags hands off to its own
// page (browse-flags.html, which calls renderFlagGallery below) so a
// specific template can be chosen there; Hole Signs has no browse step at
// all (the hole-sign editor's own onboarding picker, hs/design.js's
// HS_BUILTIN_DEFAULTS flow, is where that choice happens, after auth). This
// component only reports which type was picked - routing is the caller's
// job (landing.js). Text-only cards, no thumbnails - the placeholder art
// tried here didn't earn its keep (see login.js's own Standard-template
// placeholder for where that now lives instead).
export function renderTemplateGallery(container, { onSelectType }) {
  container.innerHTML = `
    <div class="tg-picker" id="tgPicker" role="radiogroup" aria-label="What are you looking for?">
      <div class="tg-picker-title">What are you looking for?</div>
      <div class="tg-picker-options">
        <button type="button" class="tg-picker-card" data-type="flag" role="radio" aria-checked="false">
          <div class="tg-picker-name">Tournament Flags</div>
          <div class="tg-picker-desc">Colored flags for tee boxes, greens, and sponsor recognition</div>
        </button>
        <button type="button" class="tg-picker-card" data-type="hole-sign" role="radio" aria-checked="false">
          <div class="tg-picker-name">Hole Signs</div>
          <div class="tg-picker-desc">Sponsor signage placed at each hole</div>
        </button>
      </div>
    </div>`;

  container.querySelectorAll('.tg-picker-card').forEach(card => {
    card.addEventListener('click', () => onSelectType(card.dataset.type));
  });
}

// The flag browse step (browse-flags.html) - its own page, separate from
// the type picker above. Awaits FLAGS' SVG content before rendering so every
// card is clickable/hoverable as soon as it appears. Renders the grid into
// its own nested .flag-tmpl-grid child (matching landing.css's
// `#templateGalleryRoot .flag-tmpl-grid` scoping) rather than putting that
// class on `container` itself, so callers can pass a plain wrapper div.
export async function renderFlagGallery(container, { onSelect }) {
  container.innerHTML = '<div class="flag-tmpl-grid"></div>';
  await loadAllFlags(FLAGS);
  renderFlagGrid(container.firstElementChild, onSelect);
}

function renderFlagGrid(el, onSelect) {
  el.innerHTML = FLAGS.map(flag => `
    <div class="flag-tmpl-card" data-flag-id="${esc(flag.id)}">
      <div class="flag-tmpl-thumb">
        <div class="flag-tmpl-thumb-img flag-tmpl-thumb-default">${buildFlagSvgHtml(flag)}</div>
        <div class="flag-tmpl-start-btn">Select Flag</div>
      </div>
      <div class="flag-tmpl-name">${esc(flag.name)}</div>
    </div>`).join('');
  el.querySelectorAll('.flag-tmpl-card').forEach(card => {
    card.addEventListener('click', () => onSelect('flag', card.dataset.flagId));
  });
}
