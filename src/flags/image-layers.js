// Template-level free image layers (S.imageLayers — Step 1's "Images" row).
// Reuses createImageBox (image-box.js) — the same drag/resize/remove
// interaction already used for a variation's placed logos — so this is
// mostly wiring, not new interaction code. Unlike a placed logo, an image
// layer isn't tied to a zone/variation: `x`/`y` (center, percent of canvas)
// and `w` (percent of canvas width) live directly on the layer object, which
// is exactly the shape createImageBox's `data` param expects, so no adapter
// is needed. Height is deliberately never stored (matches how a plain,
// uncropped logo placement already works) — it's always derived from the
// image's own natural aspect ratio, both here (CSS `height:auto`) and in the
// SVG export (render.js's paintImageLayers, via the same getLogoAspect cache
// makeSvg's own logo loop uses).
import { createImageBox } from '../image-box.js';
import { uploadLogo } from '../supabase.js';
import { S } from '../state.js';

// Copy/paste support (see flags/layer-clipboard.js): the image layers array on
// screen (so a paste can target it even with nothing selected) and the id of
// the selected layer. createImageBox leaves selection entirely to the caller.
let _imgCtx = null; // { wrapId, imageLayers, onChange }
let _selImgId = null;

function selectImg(wrap, id) {
  _selImgId = id;
  wrap.querySelectorAll('.flag-img-layer').forEach(el => el.classList.toggle('selected', el.dataset.imgId === id));
}

document.addEventListener('pointerdown', e => {
  if (!_selImgId || e.target.closest?.('.flag-img-layer')) return;
  _selImgId = null;
  document.querySelectorAll('.flag-img-layer.selected').forEach(el => el.classList.remove('selected'));
}, true);

// Delete/Backspace removes the selected image layer.
document.addEventListener('keydown', e => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (!_imgCtx || !_selImgId) return;
  if (document.activeElement?.closest?.('input, textarea, select, [contenteditable]')) return;
  const { wrapId, imageLayers, onChange } = _imgCtx;
  const idx = imageLayers.findIndex(l => l.id === _selImgId);
  if (idx < 0) return;
  e.preventDefault();
  imageLayers.splice(idx, 1);
  _selImgId = null;
  renderFlagImageOverlays(wrapId, imageLayers, onChange);
  onChange();
});

export function clearFlagImageOverlays(wrapId) {
  _imgCtx = null;
  _selImgId = null;
  document.getElementById(wrapId)?.querySelectorAll('.flag-img-layer').forEach(el => el.remove());
}

export function getSelectedImageLayers() {
  if (!_imgCtx || !_selImgId) return [];
  const l = _imgCtx.imageLayers.find(x => x.id === _selImgId);
  return l ? [JSON.parse(JSON.stringify(l))] : [];
}

export function pasteImageLayers(layers) {
  if (!_imgCtx || !layers.length) return false;
  const { wrapId, imageLayers, onChange } = _imgCtx;
  imageLayers.push(...layers);
  _selImgId = layers[layers.length - 1].id;
  renderFlagImageOverlays(wrapId, imageLayers, onChange);
  onChange();
  return true;
}

export function renderFlagImageOverlays(wrapId, imageLayers, onChange) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  _imgCtx = { wrapId, imageLayers: imageLayers || [], onChange };
  wrap.querySelectorAll('.flag-img-layer').forEach(el => el.remove());
  (imageLayers || []).forEach(layer => {
    const box = createImageBox(wrap, wrap, layer, {
      src: layer.src,
      minW: 3,
      maxW: 150,
      onClick: () => selectImg(wrap, layer.id),
      onCommit: onChange,
      onRemove: () => {
        const idx = imageLayers.findIndex(l => l.id === layer.id);
        if (idx >= 0) imageLayers.splice(idx, 1);
        renderFlagImageOverlays(wrapId, imageLayers, onChange);
        onChange();
      },
    });
    box.classList.add('flag-img-layer');
    box.dataset.imgId = layer.id;
    if (layer.id === _selImgId) box.classList.add('selected');
    wrap.appendChild(box);
  });
}

// Reused across calls rather than created fresh each time — Safari drops a
// detached <input type=file> click's dialog callback if the element isn't
// still in the document by the time the user finishes the OS picker.
let _fileInput = null;
function ensureFileInput() {
  if (_fileInput) return _fileInput;
  _fileInput = document.createElement('input');
  _fileInput.type = 'file';
  _fileInput.accept = 'image/*';
  _fileInput.style.display = 'none';
  document.body.appendChild(_fileInput);
  return _fileInput;
}

// "Images" row — straight to the OS file picker (no existing-vs-upload
// choice modal), same simpler shortcut hs/template-logos.js's
// uploadNewTplLogo takes over addTplImage's library picker. Also added to
// S.library so it stays manageable/reusable from the Logo library step, same
// as any other upload.
export function addFlagImageLayer(imageLayers, wrapId, onChange) {
  const input = ensureFileInput();
  input.value = '';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const logo = await uploadLogo(S.projectId, file);
      S.library.push(logo);
      imageLayers.push({ id: 'fil-' + Date.now(), src: logo.src, storagePath: logo.storagePath, x: 50, y: 50, w: 30 });
      renderFlagImageOverlays(wrapId, imageLayers, onChange);
      onChange();
    } catch (err) {
      console.error('Image upload failed', err);
    }
  };
  input.click();
}
