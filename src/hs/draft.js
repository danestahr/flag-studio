import { HS } from './state.js';
import { emptyTemplateLogos } from '../hole-sign-data.js';
import { saveHoleSignConfig, updateProject } from '../supabase.js';

// Split out of export.js so the design/variations steps (1-2) don't have to
// pull in pdf-lib/jszip just to autosave — those are only needed for step 3
// export, which loads export.js dynamically (see hs/app.js goStep()).

export async function saveDraftInternal() {
  if (!HS.projectId) return;
  // Strip blob: URLs from logoSrcTight before persisting — they're regenerable
  // from logoArtworkBounds + logoSrc on load and would otherwise be dead refs.
  const variations = HS.variations.map(v => {
    const { logoSrcTight, ...rest } = v;
    return rest;
  });
  // Strip blob URLs from template-logo slots before persisting; they're regenerable
  // from logoArtworkBounds + logoSrc on load.
  const tplLogos = HS.templateLogos ? {
    ...HS.templateLogos,
    slots: (HS.templateLogos.slots || []).map(({ logoSrcTight, ...rest }) => rest),
  } : emptyTemplateLogos();
  await saveHoleSignConfig(HS.projectId, {
    templateStyle: HS.templateStyle,
    colors: {
      background: HS.background,
      topText:    HS.topText,
      bottomText: HS.bottomText,
      bannerTop:    HS.bannerTop,
      bannerBottom: HS.bannerBottom,
      templateLogos: tplLogos,
      textLayers:    HS.textLayers || [],
      captionsEdited: HS.captionsEdited,
    },
    variations,
    defaults: HS.defaults,
  });
  if (HS.projectName) {
    await updateProject(HS.projectId, { name: HS.projectName });
  }
}

window.saveDraft = async function () {
  const btn = document.getElementById('saveDraftBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await saveDraftInternal();
    if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { btn.textContent = 'Save draft'; btn.disabled = false; }, 2000); }
  } catch (err) {
    console.error(err);
    if (btn) { btn.textContent = 'Save failed'; setTimeout(() => { btn.textContent = 'Save draft'; btn.disabled = false; }, 2000); }
  }
};
