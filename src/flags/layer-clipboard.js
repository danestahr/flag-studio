// Cmd/Ctrl+C / Cmd/Ctrl+V for the selected logo/image layers or the active
// text layer, so a placed element can be carried between flag faces (front ↔
// back), between variations, and between the template (flags.html) and a
// variation (flags-variations.html) with its position, size, and styling
// intact. Layers are deep-copied as-is — x/y/w (percent of the canvas), font,
// color, crop, etc. — and only get fresh ids on paste.
//
// The template and variations are separate pages, so the clipboard lives in
// sessionStorage (survives navigation within the tab, not the tab itself) and
// is deliberately separate from the system clipboard. A template image layer
// and a variation logo are the same picture in two shapes, so they convert on
// paste via the project library: image → { logoId, x, y, w }, logo →
// { src, storagePath, x, y, w }.
import { getSelectedLogoLayers, pasteLogoLayers } from './drop-zones.js';
import { getActiveTextLayer, pasteTextLayer } from './text-layers.js';
import { getSelectedImageLayers, pasteImageLayers } from './image-layers.js';
import { S } from '../state.js';

const KEY = 'flagLayerClipboard';
// { text: layer|null, images: [template image layers], logos: [variation logos] }
const readClip = () => {
  try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch { return null; }
};
const writeClip = clip => {
  try { sessionStorage.setItem(KEY, JSON.stringify(clip)); } catch { /* private mode — copy just won't carry */ }
};

const rid = () => Date.now() + '-' + Math.random().toString(36).slice(2);
const clone = o => JSON.parse(JSON.stringify(o));

const onTemplatePage = () => !!document.getElementById('flagExpPreview');

function inTextField() {
  return !!document.activeElement?.closest?.('input, textarea, select, [contenteditable]');
}

const libById = id => (S.library || []).find(l => l.id === id);
const libBySrc = (src, path) => (S.library || []).find(l => (path && l.storagePath === path) || l.src === src);

function logoToImage(l) {
  const lib = libById(l.logoId);
  if (!lib) return null;
  return { id: 'fil-' + rid(), src: lib.src, storagePath: lib.storagePath, x: l.x ?? 50, y: l.y ?? 50, w: l.w ?? 30 };
}

function imageToLogo(i) {
  const lib = libBySrc(i.src, i.storagePath);
  if (!lib) return null;
  return { id: 'pl-' + rid(), logoId: lib.id, x: i.x ?? 50, y: i.y ?? 50, w: i.w ?? 30 };
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
    const images = text ? [] : getSelectedImageLayers();
    const logos = text || images.length ? [] : getSelectedLogoLayers();
    if (!text && !images.length && !logos.length) return;
    writeClip({ text, images, logos });
    e.preventDefault();
    return;
  }

  const clip = readClip();
  if (!clip || (!clip.text && !clip.images?.length && !clip.logos?.length)) return;
  e.preventDefault();
  if (clip.text) {
    // Hole-number layers are re-synced per variation by hole-numbers.js; a
    // pasted copy is a plain text layer so it can't fight that sync.
    const { holeNumber, ...rest } = clone(clip.text);
    pasteTextLayer({ ...rest, id: 'ftl-' + rid() });
  } else if (onTemplatePage()) {
    const layers = [
      ...(clip.images || []).map(i => ({ ...clone(i), id: 'fil-' + rid() })),
      ...(clip.logos || []).map(logoToImage),
    ].filter(Boolean);
    pasteImageLayers(layers);
  } else {
    const layers = [
      ...(clip.logos || []).map(l => ({ ...clone(l), id: 'pl-' + rid() })),
      ...(clip.images || []).map(imageToLogo),
    ].filter(Boolean);
    pasteLogoLayers(layers);
  }
});
