// Fetches SVG files, extracts logo zones from the logo-placement group,
// hides that group so the fill doesn't show, and populates each flag object.

import { PRINT_FLAGS, PRINT_FRAMES } from './flags/print-spec.js';
import { fetchPoleText } from './flags/pole.js';

// Bounding box of a straight-line SVG path (M/L/H/V/Z, absolute commands only —
// covers the tapered/notched flag outlines used for custom placement areas;
// curves aren't needed for those shapes).
function pathBBox(d) {
  const cmdRe = /([MLHVZ])([^MLHVZ]*)/gi;
  let curX = 0, curY = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  let m;
  while ((m = cmdRe.exec(d))) {
    const cmd = m[1].toUpperCase();
    const nums = (m[2].match(/-?[\d.]+(?:e-?\d+)?/gi) || []).map(Number);
    if (cmd === 'M' || cmd === 'L') {
      for (let i = 0; i < nums.length; i += 2) { curX = nums[i]; curY = nums[i + 1]; visit(curX, curY); }
    } else if (cmd === 'H') {
      nums.forEach(n => { curX = n; visit(curX, curY); });
    } else if (cmd === 'V') {
      nums.forEach(n => { curY = n; visit(curX, curY); });
    }
  }
  return isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

// Custom (non-rectangular) placement areas — e.g. a pennant's tapered point or a
// swallow-tail's notch — are authored as one or more path/polygon shapes instead
// of a rect. Union their bounding boxes into a single zone (multiple paths are
// typically the same outline drawn again for fill+stroke, not separate zones).
function customShapeZone(g) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y, w, h) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  };
  g.querySelectorAll('path').forEach(p => {
    const bb = pathBBox(p.getAttribute('d') || '');
    if (bb) grow(bb.x, bb.y, bb.w, bb.h);
  });
  g.querySelectorAll('polygon').forEach(p => {
    const nums = (p.getAttribute('points') || '').match(/-?[\d.]+(?:e-?\d+)?/gi)?.map(Number) || [];
    let px = Infinity, py = Infinity, pmx = -Infinity, pmy = -Infinity;
    for (let i = 0; i < nums.length; i += 2) {
      px = Math.min(px, nums[i]); pmx = Math.max(pmx, nums[i]);
      py = Math.min(py, nums[i + 1]); pmy = Math.max(pmy, nums[i + 1]);
    }
    if (isFinite(px)) grow(px, py, pmx - px, pmy - py);
  });
  if (!isFinite(minX)) return null;
  // Prefer the inner shape's own id (e.g. "Area") over the group's — the group
  // is typically just "logo-placement"/"#logo-placement", not a useful label.
  const innerId = g.querySelector('[id]')?.getAttribute('id');
  const label = (innerId && !/logo-placement/i.test(innerId)) ? innerId : 'Logo';
  return { id: 'lz-' + label.toLowerCase().replace(/\s+/g, '-'), label, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function parseZoneRect(rect, index) {
  const label = rect.getAttribute('id') || `Logo ${index + 1}`;
  const id = 'lz-' + label.toLowerCase().replace(/\s+/g, '-');
  let x = parseFloat(rect.getAttribute('x') || 0);
  let y = parseFloat(rect.getAttribute('y') || 0);
  const w = parseFloat(rect.getAttribute('width'));
  const h = parseFloat(rect.getAttribute('height'));
  const transform = rect.getAttribute('transform') || '';

  // translate(tx ty) or translate(tx, ty) offsets the rect's origin
  const tMatch = transform.match(/translate\(\s*([\d.eE+-]+)[,\s]+([\d.eE+-]+)/);
  if (tMatch) { x += parseFloat(tMatch[1]); y += parseFloat(tMatch[2]); }

  // matrix(a 0 0 d e f) — what design tools emit for a flipped rect. Only the
  // axis-aligned (no rotation/skew) case is needed for placement areas.
  const mMatch = transform.match(/matrix\(\s*([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)[,\s]+([\d.eE+-]+)/);
  if (mMatch) {
    const [a, b, c, d, e, f] = mMatch.slice(1).map(Number);
    if (b === 0 && c === 0) {
      const x0 = a * x + e, x1 = a * (x + w) + e, y0 = d * y + f, y1 = d * (y + h) + f;
      return { id, label, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }
  }

  // rotate(-90 cx cy) with pivot at top-left: rendered bounds shift
  if (transform.includes('rotate(-90')) {
    return { id, label, x, y: y - w, w: h, h: w };
  }
  return { id, label, x, y, w, h };
}

async function loadFlagData(flag) {
  const url = '/flags/' + encodeURIComponent(flag.name) + '.svg';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${flag.name}: ${res.status}`);
  const text = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) throw new Error(`No SVG element in ${flag.name}`);

  // IDs may be 'logo-placement' or '#logo-placement' depending on the export tool,
  // so use attribute selectors rather than CSS ID selectors.
  const findGroup = (...ids) => {
    for (const id of ids) {
      const g = svgEl.querySelector(`[id="${id}"]`);
      if (g) return g;
    }
    return null;
  };
  const singleGroup = findGroup('logo-placement', '#logo-placement', 'logo-placement-full', '#logo-placement-full');
  const multiGroup  = findGroup('logo-placement-2', '#logo-placement-2');
  const parseGroup = g => {
    if (!g) return null;
    const rects = Array.from(g.querySelectorAll('rect'));
    if (rects.length) return rects.map((r, i) => parseZoneRect(r, i));
    const custom = customShapeZone(g);
    return custom ? [custom] : null;
  };

  const singleZones = parseGroup(singleGroup);
  const multiZones  = parseGroup(multiGroup);

  if (singleGroup) singleGroup.setAttribute('display', 'none');
  if (multiGroup)  multiGroup.setAttribute('display', 'none');

  // When only multi zones exist, synthesise a full-logo single option from the
  // bounding box of all the multi zones so the layout toggle still appears.
  const effectiveSingle = singleZones ?? (multiZones?.length
    ? [{ id: 'lz-logo-full', label: 'Logo',
         x: Math.min(...multiZones.map(z => z.x)),
         y: Math.min(...multiZones.map(z => z.y)),
         w: Math.max(...multiZones.map(z => z.x + z.w)) - Math.min(...multiZones.map(z => z.x)),
         h: Math.max(...multiZones.map(z => z.y + z.h)) - Math.min(...multiZones.map(z => z.y)) }]
    : null);

  if (effectiveSingle && multiZones) {
    // Flag supports both layouts — store both, default to single
    flag.logoZoneSets = { single: effectiveSingle, multi: multiZones };
    flag.logoZones = effectiveSingle;
  } else {
    flag.logoZoneSets = null;
    flag.logoZones = effectiveSingle || [];
  }

  flag.viewBox = svgEl.getAttribute('viewBox') || '0 0 7519 4669';
  flag.svgContent = svgEl.innerHTML;
}

// Vendor print frames (see flags/print-spec.js). Additive: sets flag.print only
// when both faces load and match the expected frame size; any failure leaves
// the flag on the legacy pipeline untouched.
// Recolourable zone ids in a print frame, normalised so "zone-border (Top)" and
// "zone-secondary_2" count as their zone ("zone-border", "zone-secondary").
function zoneIdsOf(svgEl) {
  const ids = new Set();
  svgEl.querySelectorAll('[id^="zone-"]').forEach(el => ids.add(el.id.replace(/ \(.*\)$/, '').replace(/_\d+$/, '')));
  return ids;
}

export async function loadPrintFrames(flag) {
  const printName = flag.printName || flag.name;
  // Manifest flags (print-manifest.js) name files <style>__<layout>__<face>; the
  // older hand-named ones are listed in PRINT_FLAGS.
  if (!flag.printStyle && !PRINT_FLAGS.includes(printName)) return;
  try {
    const frames = {};
    for (const face of ['front', 'back']) {
      const url = '/flags/print/' + encodeURIComponent(flag.printStyle
        ? `${flag.printStyle}__${flag.printLayout}__${face}`
        : `${printName} - ${face === 'front' ? 'Front' : 'Back'}`) + '.svg';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
      const svgEl = doc.documentElement;
      // A dev server may answer a missing file with index.html (200), so check it really is an SVG.
      if (svgEl.nodeName !== 'svg' || doc.querySelector('parsererror')) throw new Error(`not an SVG: ${url}`);
      // Some exports name zones "#zone-border" (as the pole files and #logo-placement
      // do); the recolor and zone check key on "zone-...", so drop the "#".
      svgEl.querySelectorAll('[id^="#zone-"]').forEach(el => el.setAttribute('id', el.getAttribute('id').slice(1)));
      // The group holding the border zones is lifted above logos by its name ("Border");
      // exports sometimes label it per face/layout ("Border - Front"), so normalise it.
      svgEl.querySelectorAll('g[id]').forEach(g => {
        const id = g.getAttribute('id');
        // Only a group that holds nothing but border shapes: the file's root group (named
        // "<style>__border__<face>") also contains zone-border shapes, and renaming it
        // would make the back print step delete the whole artwork.
        if (id !== 'Border' && /border/i.test(id) && !/zone-/i.test(id) && g.querySelector('[id^="zone-border"]')
            && !g.querySelector('[id="Background"], [id="GolfStatus Tag"], [id="logo-placement"], [id="#logo-placement"], [id="Cut Guides"]')) g.setAttribute('id', 'Border');
      });
      // Newer exports group the GolfStatus Tag (and anything else) together with the
      // placement rect under "#logo-placement". That group gets hidden on screen and
      // deleted from print sheets, which would take the tag with it - so lift
      // everything but the rect out and leave the rect carrying the id, as before.
      const placeGroup = svgEl.querySelector('g[id="#logo-placement"], g[id="logo-placement"]');
      if (placeGroup) {
        const kids = Array.from(placeGroup.children);
        const rects = kids.filter(k => k.tagName === 'rect');
        if (rects.length === 1) {
          let ref = placeGroup;
          kids.filter(k => k !== rects[0]).forEach(k => { ref.after(k); ref = k; });
          rects[0].setAttribute('id', placeGroup.getAttribute('id'));
          placeGroup.replaceWith(rects[0]);
        }
      }
      const viewBox = svgEl.getAttribute('viewBox') || '';
      const [, , w, h] = viewBox.split(/\s+/).map(Number);
      const want = PRINT_FRAMES[face];
      if (w !== want.w || h !== want.h) throw new Error(`${url} is ${w}x${h}, expected ${want.w}x${want.h}`);
      const zoneGroup = svgEl.querySelector('[id="logo-placement"], [id="#logo-placement"]');
      if (!zoneGroup) throw new Error(`no logo-placement group in ${url}`);
      // The placement area is either a group of rects/paths or (print frames)
      // a single rect carrying the id itself.
      const rects = zoneGroup.tagName === 'rect' ? [zoneGroup] : Array.from(zoneGroup.querySelectorAll('rect'));
      const zones = rects.length ? rects.map((r, i) => parseZoneRect(r, i)) : [customShapeZone(zoneGroup)].filter(Boolean);
      if (!zones.length) throw new Error(`no logo-placement zone in ${url}`);
      zoneGroup.setAttribute('display', 'none');
      frames[face] = { viewBox, w, h, zones, zoneIds: zoneIdsOf(svgEl), svgContent: svgEl.innerHTML };
    }
    // The back may only recolour zones the front also has (a layout's border
    // is drawn on the front only), and the front must carry every zone the
    // flag declares in data.js - otherwise a picker would do nothing. Fail
    // loudly and stay on legacy instead.
    const [fz, bz] = [frames.front.zoneIds, frames.back.zoneIds];
    const extraOnBack = [...bz].filter(z => !fz.has(z));
    if (extraOnBack.length) throw new Error(`back has zones the front lacks: ${extraOnBack.join(', ')}`);
    const missing = (flag.colorZones || []).map(z => z.id).filter(id => !fz.has(id));
    if (missing.length) throw new Error(`print frames are missing declared zones: ${missing.join(', ')}`);
    // The reverse is only a warning: a zone the file draws but the flag doesn't
    // declare in data.js never gets a colour picker, so it prints in its authored colour.
    const declared = new Set((flag.colorZones || []).map(z => z.id));
    const unpickable = declared.size ? [...fz].filter(id => !declared.has(id)) : [];
    if (unpickable.length) console.warn(`${flag.name} print frames draw zones the flag doesn't declare (no colour picker, prints in authored colour): ${unpickable.join(', ')}`);
    flag.print = frames;
    // The preview pole is optional: a missing file just means no pole is drawn.
    flag.poleText = flag.poleName ? await fetchPoleText(flag.poleName).catch(err => { console.warn('Pole not loaded for', flag.name, err.message); return null; }) : null;
  } catch (err) {
    flag.print = null;
    flag.poleText = null;
    console.warn('Print frames not loaded for', flag.name, err.message);
  }
}

export async function loadAllFlags(flags) {
  const results = await Promise.allSettled(flags.map(async f => {
    if (f.layoutOf) { // a print layout of another flag: legacy artwork is the base flag's, loaded separately
      await loadPrintFrames(f);
      return;
    }
    await loadFlagData(f);
    await loadPrintFrames(f);
  }));
  // Layout siblings share their base flag's legacy artwork/zones.
  flags.filter(f => f.layoutOf).forEach(f => {
    const base = flags.find(b => b.id === f.layoutOf);
    if (base) Object.assign(f, { svgContent: base.svgContent, viewBox: base.viewBox, logoZones: base.logoZones, logoZoneSets: base.logoZoneSets });
  });
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error('Flag load failed:', flags[i].name, r.reason);
  });
}
