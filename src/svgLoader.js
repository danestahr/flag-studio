// Fetches SVG files, extracts logo zones from the logo-placement group,
// hides that group so the fill doesn't show, and populates each flag object.

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
  const parseGroup  = g => g ? Array.from(g.querySelectorAll('rect')).map((r, i) => parseZoneRect(r, i)) : null;

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
