// Cmd/Ctrl+C / Cmd/Ctrl+V for the selected logo/image layers or the active
// text layer, so a placed element can be carried from one flag (variation) to
// another with its position, size, and styling intact. Layers are deep-copied
// as-is — x/y/w (percent of the canvas), font, color, crop, etc. — and only
// get fresh ids on paste. In-memory only (survives switching variations, not
// a page reload), and deliberately separate from the system clipboard.
import { getSelectedLogoLayers, pasteLogoLayers } from './drop-zones.js';
import { getActiveTextLayer, pasteTextLayer } from './text-layers.js';

let _clip = { logos: [], text: null };

const rid = () => Date.now() + '-' + Math.random().toString(36).slice(2);

function inTextField() {
  return !!document.activeElement?.closest?.('input, textarea, select, [contenteditable]');
}

document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'c' && k !== 'v') return;
  if (inTextField()) return;
  // Don't hijack a real text selection (e.g. copying a hex value off the page).
  if (String(window.getSelection?.() || '')) return;

  if (k === 'c') {
    const text = getActiveTextLayer();
    const logos = text ? [] : getSelectedLogoLayers();
    if (!text && !logos.length) return;
    _clip = { logos, text };
    e.preventDefault();
    return;
  }

  if (!_clip.text && !_clip.logos.length) return;
  e.preventDefault();
  if (_clip.text) {
    // Hole-number layers are re-synced per variation by hole-numbers.js; a
    // pasted copy is a plain text layer so it can't fight that sync.
    const { holeNumber, ...rest } = JSON.parse(JSON.stringify(_clip.text));
    pasteTextLayer({ ...rest, id: 'ftl-' + rid() });
  } else {
    pasteLogoLayers(_clip.logos.map(l => ({ ...JSON.parse(JSON.stringify(l)), id: 'pl-' + rid() })));
  }
});
