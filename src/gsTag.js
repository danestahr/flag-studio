const _groups = {};

export async function loadGsTag() {
  try {
    const res = await fetch('/flags/GolfStatus Tag.svg');
    if (!res.ok) return;
    const text = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'image/svg+xml');
    for (const name of ['Front - Dark Tag', 'Front - Light Tag', 'Back - Dark Tag', 'Back - Light Tag']) {
      const g = doc.querySelector(`[id="${name}"]`);
      if (g) _groups[name] = g.innerHTML;
    }
  } catch (e) { console.error('GolfStatus tag load failed', e); }
}

export function isLightColor(hex) {
  if (!hex || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

// Returns innerHTML of the appropriate tag group, or null if not loaded.
// face: 'front' | 'back'
// primaryHex: flag background color for auto dark/light selection
// mode: 'auto' | 'dark' | 'light'
export function getGsTagGroup(face, primaryHex, mode) {
  let style;
  if (mode === 'auto') {
    style = isLightColor(primaryHex) ? 'Light' : 'Dark';
  } else {
    style = mode === 'light' ? 'Light' : 'Dark';
  }
  const faceKey = face === 'back' ? 'Back' : 'Front';
  return _groups[`${faceKey} - ${style} Tag`] ?? null;
}

// Returns SVG transform string for placing the tag at the bottom-left of a flag.
export function gsTagTransform(vbW, vbH) {
  const scale = (vbW * 0.28) / 238;
  const tx = vbW * 0.027;
  const ty = vbH - 50 * scale - vbH * 0.04;
  return `translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${scale.toFixed(4)})`;
}
