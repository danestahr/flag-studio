import { HS, UI, defaultCaptionsEdited, mergeBanner } from './state.js';
import { mergeLibraries } from '../state.js';
import { renderStep1, updateStep1Preview, applyBuiltInDefaults, flushCustomTemplateForkSave } from './design.js';
import { renderStep2, renderVarList, updateHsEditRequestsBanner } from './variations.js';
import { cropSvgToArtwork, migrateVariationLogos } from './logo-utils.js';
import { saveDraftInternal } from './draft.js';
import { emptyTemplateLogos, migrateBannerCaptions, HS_TEMPLATES, HS_DEFAULT_TEMPLATES } from '../hole-sign-data.js';
import { getFeedback, loadHoleSignConfig, loadLogosForProject, listUserLogos, loadProject, supabase } from '../supabase.js';
import { requireAuth } from '../auth.js';
import { renderSidebar, setSidebarProjectName } from '../sidebar.js';

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
    const project = await loadProject(projectId);
    const [hsCfg, logos, sharedLogos] = await Promise.all([
      loadHoleSignConfig(projectId),
      loadLogosForProject(projectId),
      listUserLogos(project.created_by),
    ]);

    HS.projectName = project.name || '';
    // This design's own status (hole_sign_config.status), not the whole
    // project - flags on the same project can be at a different stage. A
    // brand-new hsCfg (still null, nothing saved yet) is trivially editable.
    HS.projectStatus = hsCfg?.status || 'draft';
    HS.shareToken = project.share_token || null;
    HS.library = mergeLibraries(logos, sharedLogos);

    // Customers can only edit while draft/needs_changes - once this design
    // is submitted/under review/approved, Gallery & export stays viewable
    // but Design/Variations are off limits (see goStep()). Staff/admin are
    // never blocked. UI-convenience only - RLS is the real boundary.
    UI.hsLocked = !UI.isStaffOrAdmin && !['draft', 'needs_changes'].includes(HS.projectStatus);

    renderSidebar(document.getElementById('sidebar'), {
      projectType: 'Hole Signs',
      activeStep: 1,
      logosTile: true,
      projectId,
      completedSteps: HS.projectStatus === 'sent_to_print' ? [3] : [],
      steps: [
        { id: 'navDesign', label: 'Templates', desc: 'Background & text', ...(UI.hsLocked ? {} : { onClick: () => window.goStep(1) }) },
        { id: 'navVariations', label: 'Hole Signs', desc: 'Sponsor logos', ...(UI.hsLocked ? {} : { onClick: () => window.goStep(2) }) },
        { id: 'navGallery', label: 'Review', desc: 'Review & download', onClick: () => window.goStep(3) },
      ],
    });
    if (UI.hsLocked) {
      ['navDesign', 'navVariations'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.cssText += 'opacity:.45;cursor:default';
      });
    }

    if (!hsCfg) {
      // Arrived from the public template gallery / event-info step with a
      // template already chosen there (?template=<id>) - skip the in-app
      // onboarding picker and apply it directly, same as clicking that card
      // would (pickOnboardingTemplate/pickOnboardingDefaultTemplate below).
      const templateParam = new URLSearchParams(window.location.search).get('template');
      if (templateParam && HS_TEMPLATES.some(t => t.id === templateParam)) {
        HS.templateStyle = templateParam;
        applyBuiltInDefaults();
      } else if (templateParam && HS_DEFAULT_TEMPLATES.some(t => t.id === templateParam)) {
        window.applyDefaultTemplate(templateParam);
      } else {
        UI.hsOnboarding = true;
      }
    }

    if (hsCfg) {
      const c = hsCfg.colors || {};
      HS.templateStyle = hsCfg.template_style || 'hole-sign-1';
      if (c.background) HS.background = { ...HS.background, ...c.background };
      if (c.topText)    HS.topText    = { ...HS.topText,    ...c.topText };
      if (c.bottomText) HS.bottomText = { ...HS.bottomText, ...c.bottomText };
      HS.captionsEdited = { ...defaultCaptionsEdited(), ...(c.captionsEdited || {}) };
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
      // Legacy banner topText/subText (removed from the banner shape — see
      // emptyBanner in hole-sign-data.js) become docked free text layers.
      // Reads the raw pre-merge legacy banner object, so this only ever
      // produces entries for old-shape saved data — a no-op once the project
      // has been re-saved in the new shape.
      [['top', c.bannerTop || legacyTop], ['bottom', c.bannerBottom || legacyBot]].forEach(([which, legacyBanner]) => {
        migrateBannerCaptions(legacyBanner, which).forEach(spec => {
          HS.textLayers.push({ ...spec, id: 'tl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) });
        });
      });
      if (hsCfg.one_offs && hsCfg.one_offs.length) {
        HS.defaults = hsCfg.one_offs;
      }
      if (hsCfg.variations && hsCfg.variations.length) {
        HS.variations = hsCfg.variations;
        HS.variations.forEach(v => {
          if (!v.templateId) v.templateId = HS.templateStyle;
          // Old saved projects still have the single-logo shape — fold it
          // into a one-element `logos` array before anything else touches it.
          migrateVariationLogos(v);
          (v.logos || []).forEach(layer => {
            if (layer.logoId && !layer.logoSrc) {
              const lib = HS.library.find(l => l.id === layer.logoId);
              if (lib) layer.logoSrc = lib.src;
            }
            // Clear any persisted blob URL — blob URLs don't survive reload.
            // The renderer will fall back to layer.logoSrc (the durable public
            // URL) until the async re-crop below resolves.
            layer.logoSrcTight = undefined;
            if (layer.logoSrc && layer.logoArtworkBounds) {
              cropSvgToArtwork(layer.logoSrc, layer.logoArtworkBounds).then(tight => {
                if (tight) { layer.logoSrcTight = tight.url; layer.logoAspect = tight.aspect; }
              }).catch(() => {});
            }
          });
          // Same legacy banner-caption migration as the global config above,
          // scoped to this variation's own override. Falls back to a clone of
          // the global textLayers array if the variation doesn't have its own
          // yet, matching getEffectiveState()'s inheritance rule (state.js).
          if (v.template?.bannerTop || v.template?.bannerBottom) {
            const specs = [
              ...migrateBannerCaptions(v.template.bannerTop, 'top'),
              ...migrateBannerCaptions(v.template.bannerBottom, 'bottom'),
            ];
            if (specs.length) {
              if (!Array.isArray(v.textLayers)) v.textLayers = (HS.textLayers || []).map(l => ({ ...l }));
              specs.forEach(spec => {
                v.textLayers.push({ ...spec, id: 'tl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) });
              });
            }
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

    setSidebarProjectName(HS.projectName, HS.projectId);
    const refreshFeedback = () => {
      getFeedback(projectId, 'hole-signs').then(fb => {
        HS.feedback = fb || [];
        renderVarList();
        updateHsEditRequestsBanner();
        // Gallery (step 3) paints its own copy of these badges and isn't
        // repainted by renderVarList() above — if it's the visible panel,
        // repaint it too so it doesn't sit stale until the user re-navigates.
        if (_hsCurrentStep === 3) import('./export.js').then(({ renderGallery }) => renderGallery());
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
  // Deep-link support for project.html's numbered section-jump links
  // (?panel=1|2|3) - falls back to Design like before when absent/invalid.
  const requestedPanel = Number(new URLSearchParams(window.location.search).get('panel'));
  goStep(UI.hsLocked ? 3 : ([1, 2, 3].includes(requestedPanel) ? requestedPanel : 1));
}

export function renderCustomerSection(intake) {
  const el = document.getElementById('customerSection');
  if (!el) return;
  const fmt = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
  const addr = [intake.address_line1, intake.address_line2, intake.city, intake.state_province, intake.postal_code, intake.country].filter(Boolean).map(escHtml).join(', ');
  // flag_colors is either a legacy bare array (old orders) or { zones, gsTag, gsTagMode } (see order.js)
  const colors = Array.isArray(intake.flag_colors) ? intake.flag_colors : (intake.flag_colors?.zones || []);
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
        ${intake.design_notes ? `<div class="cs-row"><span class="cs-label">Design Description</span><span class="cs-notes">${escHtml(intake.design_notes)}</span></div>` : ''}
        ${intake.front_design_notes ? `<div class="cs-row"><span class="cs-label">Front Notes</span><span class="cs-notes">${escHtml(intake.front_design_notes)}</span></div>` : ''}
        ${intake.back_design_notes ? `<div class="cs-row"><span class="cs-label">Back Notes</span><span class="cs-notes">${escHtml(intake.back_design_notes)}</span></div>` : ''}
      </div>
    </div>`;
  el.style.display = '';
}

// ── Nav ────────────────────────────────────────────────────
let _hsMaxStep = 1;
let _hsCurrentStep = 1;

export function goStep(n) {
  if (UI.hsLocked && n !== 3) n = 3;
  _hsMaxStep = Math.max(_hsMaxStep, n);
  _hsCurrentStep = n;
  flushCustomTemplateForkSave();
  if (HS.projectId && !UI.hsOnboarding && !UI.hsLocked) saveDraftInternal().catch(() => {});

  document.querySelectorAll('.panel').forEach((p, i) => p.classList.toggle('visible', i === n - 1));
  document.querySelectorAll('.step-item').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i === n - 1) s.classList.add('active');
    if (i < n - 1 || (s.id === 'navGallery' && HS.projectStatus === 'sent_to_print')) s.classList.add('done');
  });
  if (n === 1) { UI.hsMenu = null; UI.hsMenuAnimate = false; renderStep1(); }
  if (n === 2) renderStep2();
  // Dynamically imported: export.js pulls in pdf-lib + jszip (~200KB gzip),
  // only needed once the user actually reaches the export step.
  if (n === 3) import('./export.js').then(({ renderGallery }) => renderGallery());
  window.scrollTo(0, 0);
}

// Step-indicator nav: only allow visiting steps already reached (or going back).
// Forward-skip via the indicators is blocked; use the action buttons instead.
window.tryGoStep = (n) => { if (n <= _hsMaxStep) goStep(n); };

// ── Sidebar ────────────────────────────────────────────────
export function updateSidebar() {
  // Summary section removed — nothing to sync
}

// Expose goStep globally for inline step navigation.
window.goStep = goStep;
