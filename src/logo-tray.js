import { logoThumbHtml } from './media-utils.js';

// Shared "logo library" strip for the Variations step of both the flag and
// hole-sign editors: an upload tile plus draggable logo thumbnails with
// delete / remove-background actions. State (the logo array, drag
// bookkeeping, variation patching, save/dirty tracking) stays owned by each
// tool — this only renders the strip's DOM and wires it to callbacks.
export function renderLogoTray(container, {
  library,
  fileInputId,
  accept = 'image/*',
  multiple = true,
  onUpload,      // (File[]) => void
  onItemClick,   // (logo) => void — omit for a drag-only tray
  onDragStart,   // (logo) => void
  onDragEnd,     // (logo) => void
  onDelete,      // (logo) => void
  onRemoveBg,    // (logo, onProgress) => Promise<any> — onProgress('loading'|'uploading')
}) {
  if (!container) return;
  container.innerHTML = `
    <button type="button" class="var-upload-btn" title="Upload logo">+</button>
    <input type="file" id="${fileInputId}" accept="${accept}"${multiple ? ' multiple' : ''} style="display:none">
  `;
  const fileInput = container.querySelector('#' + fileInputId);
  container.querySelector('.var-upload-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) onUpload?.(files);
  });

  library.forEach(logo => {
    const el = document.createElement('div');
    el.className = `var-lib-item${logo.uploading ? ' uploading' : ''}`;
    el.title = logo.name;
    el.innerHTML = logoThumbHtml(logo.src, logo.name);
    container.appendChild(el);
    if (logo.uploading) return;

    el.draggable = true;
    el.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'copy';
      el.classList.add('dragging');
      onDragStart?.(logo);
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      onDragEnd?.(logo);
    });
    if (onItemClick) {
      el.addEventListener('click', e => {
        if (e.target.closest('.var-lib-del, .var-lib-bgrem')) return;
        onItemClick(logo);
      });
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'var-lib-del';
    delBtn.title = 'Delete';
    delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    delBtn.addEventListener('click', e => { e.stopPropagation(); onDelete?.(logo); });
    el.appendChild(delBtn);

    if (onRemoveBg) {
      const bgremBtn = document.createElement('button');
      bgremBtn.className = 'var-lib-bgrem';
      bgremBtn.title = 'Remove background';
      bgremBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
      bgremBtn.addEventListener('click', async e => {
        e.stopPropagation();
        bgremBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        bgremBtn.disabled = true;
        try {
          await onRemoveBg(logo, stage => { bgremBtn.innerHTML = stage === 'uploading' ? '<i class="fa-solid fa-arrow-up-from-bracket"></i>' : '<i class="fa-solid fa-spinner fa-spin"></i>'; });
        } catch (err) {
          console.error('Background removal failed', err);
          bgremBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
          bgremBtn.disabled = false;
        }
      });
      el.appendChild(bgremBtn);
    }
  });
}
