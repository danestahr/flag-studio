// Fetches SVG files, extracts logo zones from the logo-placement group,
// hides that group so the fill doesn't show, and populates each flag object.

function parseZoneRect(rect, index) {
  const label = rect.getAttribute('id') || `Logo ${index + 1}`;
  const id = 'lz-' + label.toLowerCase().replace(/\s+/g, '-');
  const x = parseFloat(rect.getAttribute('x') || 0);
  const y = parseFloat(rect.getAttribute('y') || 0);
  const w = parseFloat(rect.getAttribute('width'));
  const h = parseFloat(rect.getAttribute('height'));
  const transform = rect.getAttribute('transform') || '';

  // rotate(-90 cx cy) with pivot at top-left: rendered bounds shift
  if (transform.includes('rotate(-90')) {
    return { id, label, x, y: y - w, w: h, h: w };
  }
  return { id, label, x, y, w, h };
}

async function loadFlagData(flag) {
  const res = await fetch(`/flags/${flag.name}.svg`);
  const text = await res.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');

  const placementGroup = svgEl.querySelector('#logo-placement');
  if (placementGroup) {
    flag.logoZones = Array.from(placementGroup.querySelectorAll('rect'))
      .map((rect, i) => parseZoneRect(rect, i));
    placementGroup.setAttribute('display', 'none');
  } else {
    flag.logoZones = [];
  }

  flag.viewBox = svgEl.getAttribute('viewBox') || '0 0 7519 4669';
  flag.svgContent = svgEl.innerHTML;
}

export async function loadAllFlags(flags) {
  await Promise.all(flags.map(loadFlagData));
}
