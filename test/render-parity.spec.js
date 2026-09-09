import { test, expect } from '@playwright/test';

// Guards the invariant documented at the top of src/hole-sign-render.js: every
// consumer of a hole-sign's visual content — the interactive canvas, the
// Variations sidebar thumbnail, and the shared renderer used directly by the
// Gallery grid/print export/customer review page — must show the project's
// template-logo/banner dressing identically, regardless of what kind of
// content (a placed logo vs. a full "Custom Design" artboard upload) a given
// variation carries. This is a regression test for two real bugs: an artboard
// upload painting over the template logo everywhere except the live canvas,
// and the sidebar thumbnail skipping frame content entirely for artboards.
//
// It drives the actual src/hs/ modules (imported live from the dev server)
// against a hand-built fixture state, rather than reimplementing the render
// logic — so it breaks the moment a caller special-cases a content type
// instead of going through makeHoleSignSvg/renderHoleSignInto.

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('template-logo frame content shows identically across canvas, sidebar thumbnail, and shared renderer for both logo and artboard variations', async ({ page }) => {
  await page.goto('/test/render-parity.html');

  const result = await page.evaluate(async (PIXEL) => {
    const { HS, UI, getEffectiveState, getEffectiveVariation } = await import('/src/hs/state.js');
    const { renderHoleSignInto } = await import('/src/hole-sign-render.js');
    const { renderVariationPreview } = await import('/src/hs/var-canvas.js');
    const { renderVarList } = await import('/src/hs/variations.js');

    document.body.innerHTML = `
      <div id="hsSignPreview" style="position:relative;width:400px;height:600px"></div>
      <div id="hsVarList"></div>
      <div id="a-logo"></div>
      <div id="a-artboard"></div>
    `;

    Object.assign(HS, {
      projectId: 'test-project',
      templateStyle: 'hole-sign-1',
      background: { type: 'color', color: '#ffffff' },
      topText: { text: '', font: 'dm-serif', size: 200, color: '#111' },
      bottomText: { text: '', font: 'dm-serif', size: 200, color: '#111' },
      bannerTop: { enabled: false },
      bannerBottom: { enabled: false },
      templateLogos: { count: 1, size: 140, hAlign: 'center', vAlign: 'bottom', slots: [{ logoSrc: PIXEL, ratio: '1:1' }] },
      textLayers: [],
      library: [],
      defaults: [],
      feedback: [],
      editingVarId: null,
      editingDraft: null,
    });
    HS.variations = [
      { id: 'v-logo', name: 'Logo Var', logos: [{ id: 'l1', logoId: null, logoSrc: PIXEL, x: 50, y: 50, w: 90 }] },
      { id: 'v-artboard', name: 'Artboard Var', artboardSrc: PIXEL, logos: [] },
    ];

    // Path A: the shared renderer — exactly what the Gallery grid, print
    // export, and (after the fix) the sidebar thumbnail all call directly.
    function renderShared(varId, containerId) {
      const v = HS.variations.find(x => x.id === varId);
      renderHoleSignInto(document.getElementById(containerId), getEffectiveState(v), getEffectiveVariation(v));
    }
    renderShared('v-logo', 'a-logo');
    renderShared('v-artboard', 'a-artboard');

    // Frame content (template logo) must paint AFTER the variation's own
    // content in SVG source order — SVG paints later elements on top, so
    // this is what "the template logo shows over the sponsor content"
    // actually cashes out to, for both a plain logo and a full artboard.
    const paintOrder = svg => Array.from(svg.querySelectorAll('image'))
      .map(img => (img.closest('.hs-frame') ? 'frame' : 'content'));

    const svgLogoA = document.getElementById('a-logo').querySelector('svg');
    const svgArtboardA = document.getElementById('a-artboard').querySelector('svg');

    // Path B: the interactive canvas — renders through the same builder,
    // then re-parents .hs-frame into its own DOM overlay (see var-canvas.js).
    // Any active variation (whether just selected — the Variations page's
    // default "quick-edit" locked mode — or actually in the full pencil
    // editor) strips the frame's slot image out of the SVG copy in favor of
    // an interactive DOM overlay (locked = plain `.tl-slot` box, click-to-
    // swap only; unlocked = the same shared image-box.js `.dz-logo-wrap`
    // component flag/variation logos use, also draggable/resizable) — the
    // content must never silently go missing from the canvas in either state.
    const frameOrSlotImage = () =>
      document.querySelector('#hsSignPreview .dz-frame-overlay image, #hsSignPreview .tl-slot img, #hsSignPreview .dz-logo-wrap .tl-slot-img');

    HS.activeVarId = 'v-logo';
    renderVariationPreview();
    const quickEditLogoHasImage = !!frameOrSlotImage();

    HS.activeVarId = 'v-artboard';
    renderVariationPreview();
    const quickEditArtboardHasImage = !!frameOrSlotImage();

    // Same two variations, but now in the full pencil-editor session (as if
    // the user clicked the pencil) — still shows the template logo via a
    // `.tl-slot` DOM overlay (this time with drag/resize handles too), since
    // an active variation always strips the frame's slot image out of the
    // SVG copy in favor of *some* interactive overlay — locked or unlocked.
    UI.hsFullEditorOpen = true;

    HS.activeVarId = 'v-logo';
    HS.editingVarId = 'v-logo';
    HS.editingDraft = getEffectiveState(HS.variations[0]);
    renderVariationPreview();
    const fullEditLogoHasImage = !!frameOrSlotImage();

    HS.activeVarId = 'v-artboard';
    HS.editingVarId = 'v-artboard';
    HS.editingDraft = getEffectiveState(HS.variations[1]);
    renderVariationPreview();
    const fullEditArtboardHasImage = !!frameOrSlotImage();

    HS.editingVarId = null;
    HS.editingDraft = null;
    UI.hsFullEditorOpen = false;

    // Path C: the Variations sidebar thumbnail list.
    renderVarList();
    const thumbLogo = document.getElementById('hsvt-v-logo');
    const thumbArtboard = document.getElementById('hsvt-v-artboard');

    return {
      paintOrderLogoA: paintOrder(svgLogoA),
      paintOrderArtboardA: paintOrder(svgArtboardA),
      quickEditLogoHasImage,
      quickEditArtboardHasImage,
      fullEditLogoHasImage,
      fullEditArtboardHasImage,
      thumbLogoHasFrameImage: !!thumbLogo?.querySelector('.hs-frame image'),
      thumbArtboardHasFrameImage: !!thumbArtboard?.querySelector('.hs-frame image'),
    };
  }, PIXEL);

  // Path A: shared renderer — frame (template logo) paints after content.
  expect(result.paintOrderLogoA).toEqual(['content', 'frame']);
  expect(result.paintOrderArtboardA).toEqual(['content', 'frame']);

  // Path B, default quick-edit (locked) viewing state: canvas shows the
  // template logo for both content types, via whichever DOM structure that
  // state uses.
  expect(result.quickEditLogoHasImage).toBe(true);
  expect(result.quickEditArtboardHasImage).toBe(true);

  // Path B, full pencil-editor session: canvas shows the template logo for
  // both content types too.
  expect(result.fullEditLogoHasImage).toBe(true);
  expect(result.fullEditArtboardHasImage).toBe(true);

  // Path C: sidebar thumbnail shows the template logo for both content types.
  expect(result.thumbLogoHasFrameImage).toBe(true);
  expect(result.thumbArtboardHasFrameImage).toBe(true);
});

test('clip-path/filter ids do not collide across multiple hole-sign SVGs rendered into the same document', async ({ page }) => {
  await page.goto('/test/render-parity.html');

  const result = await page.evaluate(async (PIXEL) => {
    const { renderHoleSignInto } = await import('/src/hole-sign-render.js');

    document.body.innerHTML = '<div id="one"></div><div id="two"></div>';

    // Two instances of the SAME state — e.g. two sidebar thumbnails, or a
    // thumbnail alongside the canvas — is the normal case, not an edge case.
    const state = {
      templateStyle: 'hole-sign-1',
      background: { type: 'color', color: '#fff', imageUrl: PIXEL, imageGreyscale: true },
      topText: { text: '', size: 100 },
      bottomText: { text: '', size: 100 },
      bannerTop: { enabled: true, height: 100, bg: { color: '#eee' } },
      bannerBottom: { enabled: false },
      templateLogos: { count: 1, size: 140, hAlign: 'center', vAlign: 'top', slots: [{ logoSrc: PIXEL, ratio: '1:1' }] },
      textLayers: [],
    };
    const variation = { logos: [{ id: 'l1', logoSrc: PIXEL, x: 50, y: 50, w: 90 }] };
    renderHoleSignInto(document.getElementById('one'), state, variation);
    renderHoleSignInto(document.getElementById('two'), state, variation);

    const idsIn = root => Array.from(root.querySelectorAll('[id]')).map(n => n.id);
    const oneIds = idsIn(document.getElementById('one'));
    const twoIds = idsIn(document.getElementById('two'));

    // Every clip-path/filter reference must resolve to an element that is
    // actually inside the SAME svg it's used from — not merely "some element
    // with this id exists somewhere on the page" (which is the exact failure
    // mode of the original bug: url(#tlc0) silently resolving to a sibling
    // instance's clipPath instead of its own).
    const selfContained = root => {
      const svg = root.querySelector('svg');
      return Array.from(svg.querySelectorAll('[clip-path], [filter]')).every(el => {
        const attr = el.getAttribute('clip-path') || el.getAttribute('filter');
        const id = attr.match(/url\(#([^)]+)\)/)[1];
        return !!svg.querySelector('#' + CSS.escape(id));
      });
    };

    return {
      overlap: oneIds.filter(id => twoIds.includes(id)),
      oneSelfContained: selfContained(document.getElementById('one')),
      twoSelfContained: selfContained(document.getElementById('two')),
    };
  }, PIXEL);

  expect(result.overlap).toEqual([]);
  expect(result.oneSelfContained).toBe(true);
  expect(result.twoSelfContained).toBe(true);
});

test('a variation can carry multiple independent logo layers, and old single-logo saved data migrates cleanly', async ({ page }) => {
  await page.goto('/test/render-parity.html');

  const result = await page.evaluate(async (PIXEL) => {
    const { renderHoleSignInto } = await import('/src/hole-sign-render.js');
    const { migrateVariationLogos } = await import('/src/hs/logo-utils.js');

    document.body.innerHTML = '<div id="multi"></div>';

    const state = {
      templateStyle: 'hole-sign-1',
      background: { type: 'color', color: '#fff' },
      topText: { text: '' }, bottomText: { text: '' },
      bannerTop: { enabled: false }, bannerBottom: { enabled: false },
      templateLogos: { count: 0, slots: [] },
      textLayers: [],
    };
    const variation = {
      logos: [
        { id: 'l1', logoSrc: PIXEL, x: 30, y: 50, w: 40 },
        { id: 'l2', logoSrc: PIXEL, x: 70, y: 50, w: 40, aboveFrame: true },
      ],
    };
    renderHoleSignInto(document.getElementById('multi'), state, variation);
    const images = Array.from(document.getElementById('multi').querySelectorAll('svg image'));

    // Legacy single-logo shape (pre-array) should fold into a one-element array.
    const legacy = { logoId: 'lib-1', logoSrc: PIXEL, logoData: { x: 20, y: 60, w: 80 }, aboveFrame: true };
    migrateVariationLogos(legacy);

    // A variation with no logo content at all should just end up with an empty array.
    const empty = {};
    migrateVariationLogos(empty);

    return {
      imageCount: images.length,
      imageXs: images.map(img => Number(img.getAttribute('x'))),
      legacyLogos: legacy.logos,
      legacyLeftoverFields: ['logoId', 'logoSrc', 'logoData', 'logoAspect', 'logoArtworkBounds']
        .filter(k => k in legacy),
      emptyLogos: empty.logos,
    };
  }, PIXEL);

  // Two distinct logo layers, each rendered at its own x position.
  expect(result.imageCount).toBe(2);
  expect(new Set(result.imageXs).size).toBe(2);

  // Legacy fields fold into one array entry, carrying over id/src/position/tier...
  expect(result.legacyLogos).toHaveLength(1);
  expect(result.legacyLogos[0]).toMatchObject({ logoId: 'lib-1', logoSrc: PIXEL, x: 20, y: 60, w: 80, aboveFrame: true });
  // ...and the old top-level fields are gone once migrated.
  expect(result.legacyLeftoverFields).toEqual([]);

  expect(result.emptyLogos).toEqual([]);
});
