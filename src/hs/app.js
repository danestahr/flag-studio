import { HS, UI, mergeBanner } from './state.js';
import { renderStep1, updateStep1Preview } from './design.js';
import { renderStep2, renderVarList } from './variations.js';
import { cropSvgToArtwork } from './logo-utils.js';
import { renderGallery, saveDraftInternal } from './export.js';
import { emptyTemplateLogos } from '../hole-sign-data.js';
import { getFeedback, loadHoleSignConfig, loadLogosForProject, loadOrderIntake, loadProject, supabase, updateProject } from '../supabase.js';
import { requireAuth } from '../auth.js';

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Init ───────────────────────────────────────────────────
export async function init() {
  await requireAuth();
  const projectId = new URLSearchParams(window.location.search).get('project');
  if (!projectId) { window.location.href = '/'; return; }
  HS.projectId = projectId;

  try {
    const [project, hsCfg, logos] = await Promise.all([
      loadProject(projectId),
      loadHoleSignConfig(projectId),
      loadLogosForProject(projectId),
    ]);

    HS.projectName = project.name || '';
    HS.library = logos;

    if (!hsCfg) {
      UI.hsOnboarding = true;
    }

    if (hsCfg) {
      const c = hsCfg.colors || {};
      HS.templateStyle = hsCfg.template_style || 'hole-sign-1';
      if (c.background) HS.background = { ...HS.background, ...c.background };
      if (c.topText)    HS.topText    = { ...HS.topText,    ...c.topText };
      if (c.bottomText) HS.bottomText = { ...HS.bottomText, ...c.bottomText };
      // Migrate legacy single-banner format: c.banner used a position field.
      const legacyTop = c.banner?.position !== 'bottom' ? c.banner : null;
      const legacyBot = c.banner?.position === 'bottom' ? c.banner : null;
      if (c.bannerTop    || legacyTop) HS.bannerTop    = mergeBanner(c.bannerTop    || legacyTop);
      if (c.bannerBottom || legacyBot) HS.bannerBottom = mergeBanner(c.bannerBottom || legacyBot);
      if (c.templateLogos) {
        HS.templateLogos = { ...emptyTemplateLogos(), ...c.templateLogos };
        HS.templateLogos.slots = (c.templateLogos.slots || []).map(s => ({ ...s, logoSrcTight: undefined }));
        HS.templateLogos.slots.forEach(s => {
          if (s.logoSrc && s.logoArtworkBounds) {
            cropSvgToArtwork(s.logoSrc, s.logoArtworkBounds).then(t => {
              if (t) { s.logoSrcTight = t.url; s.logoAspect = t.aspect; updateStep1Preview(); }
            }).catch(() => {});
          }
        });
      }
      if (c.textLayers && c.textLayers.length) {
        HS.textLayers = c.textLayers.map(l => ({ ...l }));
      }
      if (hsCfg.one_offs && hsCfg.one_offs.length) {
        HS.defaults = hsCfg.one_offs;
      }
      if (hsCfg.variations && hsCfg.variations.length) {
        HS.variations = hsCfg.variations;
        HS.variations.forEach(v => {
          if (!v.templateId) v.templateId = HS.templateStyle;
          if (v.logoId && !v.logoSrc) {
            const lib = HS.library.find(l => l.id === v.logoId);
            if (lib) v.logoSrc = lib.src;
          }
          // Clear any persisted blob URL — blob URLs don't survive reload.
          // The renderer will fall back to v.logoSrc (the durable public URL)
          // until the async re-crop below resolves.
          v.logoSrcTight = undefined;
          if (v.logoSrc && v.logoArtworkBounds) {
            cropSvgToArtwork(v.logoSrc, v.logoArtworkBounds).then(tight => {
              if (tight) { v.logoSrcTight = tight.url; v.logoAspect = tight.aspect; }
            }).catch(() => {});
          }
          // Backward-compat migration: an earlier apply path snapshotted the
          // whole template state (including an empty templateLogos) into
          // v.template. That empty override now blocks the project default
          // from flowing through. Strip it so the variation re-inherits.
          if (v.template?.templateLogos) {
            const tl = v.template.templateLogos;
            const isEmpty = (tl.count ?? 0) === 0 && (!tl.slots || tl.slots.length === 0);
            if (isEmpty) delete v.template.templateLogos;
            if (v.template && Object.keys(v.template).filter(k => k !== 'sourceId').length === 0) {
              delete v.template;
            }
          }
        });
        HS.activeVarId = HS.variations[0].id;
      }
    }

    const nameInput = document.getElementById('projectNameInput');
    if (nameInput) nameInput.value = HS.projectName;
    loadOrderIntake(projectId).then(intake => {
      if (intake) renderCustomerSection(intake);
    }).catch(() => {});
    const refreshFeedback = () => {
      getFeedback(projectId, 'hole-signs').then(fb => {
        HS.feedback = fb || [];
        renderVarList();
      }).catch(() => {});
    };
    refreshFeedback();
    if (UI.hsFeedbackChannel) UI.hsFeedbackChannel.unsubscribe();
    UI.hsFeedbackChannel = supabase
      .channel('hs-feedback-' + projectId)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'variation_feedback', filter: `project_id=eq.${projectId}` },
        refreshFeedback,
      )
      .subscribe();
  } catch (err) {
    console.error('Could not load project', err);
  }

  updateSidebar();
  goStep(1);
}

export function renderCustomerSection(intake) {
  const el = document.getElementById('customerSection');
  if (!el) return;
  const fmt = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
  const addr = [intake.address_line1, intake.address_line2, intake.city, intake.state_province, intake.postal_code, intake.country].filter(Boolean).map(escHtml).join(', ');
  const colors = Array.isArray(intake.flag_colors) ? intake.flag_colors : [];
  el.innerHTML = `
    <div class="sdivider"></div>
    <div class="cs-wrap">
      <div class="cs-header" onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.cs-toggle').classList.toggle('open')">
        <span class="cs-title">Customer</span>
        <span class="cs-toggle open">▾</span>
      </div>
      <div class="cs-body">
        <div class="cs-row">
          <span class="cs-label">Event</span>
          <span class="cs-value">${escHtml(intake.event_name)}${intake.event_date ? ' · ' + fmt(intake.event_date) : ''}</span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Contact</span>
          <span class="cs-value">${escHtml(intake.contact_name)}<br><span style="color:var(--gray-600)">${escHtml(intake.contact_email)}</span></span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Ship to</span>
          <span class="cs-value">${addr}</span>
        </div>
        <div class="cs-row">
          <span class="cs-label">Setup</span>
          <span class="cs-value">${intake.flag_setup === 'different' ? 'Different front &amp; back' : 'Same front &amp; back'}</span>
        </div>
        ${colors.length ? `<div class="cs-row"><span class="cs-label">Colors</span><div class="cs-colors">${colors.map(c => `<div class="cs-swatch" style="background:${escHtml(c.hex || c)}" title="${escHtml(c.name || c)}"></div>`).join('')}</div></div>` : ''}
        ${intake.design_notes ? `<div class="cs-row"><span class="cs-label">Notes</span><span class="cs-notes">${escHtml(intake.design_notes)}</span></div>` : ''}
      </div>
    </div>`;
  el.style.display = '';
}

// ── Nav ────────────────────────────────────────────────────
let _hsMaxStep = 1;

export function goStep(n) {
  _hsMaxStep = Math.max(_hsMaxStep, n);
  if (HS.projectId) saveDraftInternal().catch(() => {});

  document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('visible', i === n - 1));
  document.querySelectorAll('.step-item').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i === n - 1) s.classList.add('active');
    else if (i < n - 1) s.classList.add('done');
  });
  if (n === 1) { UI.hsMenu = null; UI.hsMenuAnimate = false; UI.qaLogosOpen = null; renderStep1(); }
  if (n === 2) renderStep2();
  if (n === 3) renderGallery();
  window.scrollTo(0, 0);
}

// Step-indicator nav: only allow visiting steps already reached (or going back).
// Forward-skip via the indicators is blocked; use the action buttons instead.
window.tryGoStep = (n) => { if (n <= _hsMaxStep) goStep(n); };

// ── Sidebar ────────────────────────────────────────────────
export function updateSidebar() {
  const vc = document.getElementById('sumVC');
  if (vc) {
    vc.textContent = HS.variations.length || '—';
    vc.style.color = HS.variations.length ? 'var(--black)' : 'var(--gray-400)';
  }
}

window.setProjectName = function (val) {
  HS.projectName = val;
  if (HS.projectId) updateProject(HS.projectId, { name: val || null }).catch(() => {});
};

// Expose goStep globally for inline step navigation.
window.goStep = goStep;
