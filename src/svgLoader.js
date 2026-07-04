// Fetches SVG files, extracts logo zones from the logo-placement group,
// hides that group so the fill doesn't show, and populates each flag object.

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

export async function loadAllFlags(flags) {
  const results = await Promise.allSettled(flags.map(loadFlagData));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error('Flag load failed:', flags[i].name, r.reason);
  });
}
