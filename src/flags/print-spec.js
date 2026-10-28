// Vendor print spec (GOL07). All geometry is in SVG units at 300 units/inch.
// Additive only: nothing imports this until the v2 print path is wired in, and
// legacy projects never opt in (see printSpecOf).

export const UNITS_PER_INCH = 300;

// Which print pipeline new projects get. 'legacy' = today's single-artboard
// export; 'v2' = vendor front/back print frames. Flip back to 'legacy' to stop
// new projects using v2 (existing v2 projects keep exporting via v2).
export const PRINT_SPEC_DEFAULT = 'legacy';

// Visible finished flag area, identical on both faces: 20" x 13.5".
export const ART = { w: 6000, h: 4050 };

// Per-face print frame: 26" x 15.5" front (5" pole-wrap on the left),
// 21.5" x 15.5" back. art{X,Y} is where the art box sits inside the frame.
export const PRINT_FRAMES = {
  front: { w: 7800, h: 4650, artX: 1500, artY: 300 },
  back:  { w: 6450, h: 4650, artX: 300,  artY: 300 },
};

// Ids the user-authored print SVGs must use (public/flags/print/<flag>.svg).
export const PRINT_FRAME_IDS = { front: 'Front - Print', back: 'Back - Print' };

// Flags that ship hand-named print frames (public/flags/print/<name> - Front.svg
// and "<name> - Back.svg"). Vendor-layout flags are declared in
// print-manifest.js instead. Listing a flag here or there also stops the
// loader requesting files that were never authored.
export const PRINT_FLAGS = ['test'];

// Spec for a brand-new project (no saved config yet). Normally the default;
// opening the designer with ?printSpec=v2 starts that new project on v2 so it
// can be tested without flipping the default for everyone. Only ever read for
// projects with no config row - existing projects keep their pinned spec.
export function newProjectPrintSpec() {
  try {
    const q = new URLSearchParams(location.search).get('printSpec');
    if (q === 'v2' || q === 'legacy') return q;
  } catch { /* no location (non-browser) */ }
  return PRINT_SPEC_DEFAULT;
}

// A project's pinned spec. Missing/null (every pre-existing project) is legacy.
export function printSpecOf(config) {
  return config?.print_spec === 'v2' ? 'v2' : 'legacy';
}

// True when v2 applies: project pinned to v2 AND the flag ships print frames.
export function usesV2Print(config, flag) {
  return printSpecOf(config) === 'v2' && !!flag?.print;
}

// viewBox string cropping a print frame to the customer-facing art box.
export function artViewBox(face) {
  const f = PRINT_FRAMES[face === 'back' ? 'back' : 'front'];
  return `${f.artX} ${f.artY} ${ART.w} ${ART.h}`;
}

// Pole preview: customer-facing views add a 400-unit pole beside the art box
// (left on the front, right on the back - the back's sits outside its print
// file). Purely a preview element: print exports use frameViewBox/fullFrame and
// never include it. The artwork is public/flags/print/pole__<layout>.svg (see
// flags/pole.js).
export const POLE_W = 400;

export function poleViewBox(face) {
  const f = PRINT_FRAMES[face === 'back' ? 'back' : 'front'];
  return `${face === 'back' ? f.artX : f.artX - POLE_W} ${f.artY} ${ART.w + POLE_W} ${ART.h}`;
}

export function frameViewBox(face) {
  const f = PRINT_FRAMES[face === 'back' ? 'back' : 'front'];
  return `0 0 ${f.w} ${f.h}`;
}

// Physical size strings for exported SVG width/height attributes.
export function frameInches(face) {
  const f = PRINT_FRAMES[face === 'back' ? 'back' : 'front'];
  return { w: f.w / UNITS_PER_INCH, h: f.h / UNITS_PER_INCH };
}
