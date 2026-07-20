import { esc } from './dom-utils.js';

// Shared "All variations" card list for the Variations step of both the
// flag and hole-sign editors (the flags template): a name + edit/duplicate/
// delete row on top, a thumbnail + status + qty stepper on the bottom.
// State (the item array, drag bookkeeping, save/dirty tracking) stays owned
// by each tool — this only renders the cards and wires them to callbacks.
// The thumbnail itself is painted by the caller's renderThumb, since each
// tool previews its content differently.

function statusTileHtml(fb) {
  if (fb?.status === 'approved') return '<span class="var-status-tile approved"><i class="fa-solid fa-check" aria-hidden="true"></i> Approved</span>';
  if (fb?.status === 'needs_edits' && !fb?.resolved) return '<span class="var-status-tile needs-edits">Needs edits</span>';
  return '<span class="var-status-tile not-reviewed">Not reviewed</span>';
}

function feedbackClass(fb) {
  if (fb?.status === 'needs_edits' && !fb?.resolved) return ' needs-edits';
  if (fb?.status === 'approved') return ' approved';
  return '';
}

export function renderVariationList(container, items, {
  activeId,
  thumbId,             // (item) => string id for the thumbnail element
  thumbClass = 'vthumb',
  renderThumb,          // (el, item) => void
  feedbackFor,          // (item) => feedback object | undefined
  badgeFor,             // (item) => extra badge html | '' (optional, e.g. "Customized")
  onSelect, onRename, onEdit, onDuplicate, onDelete, onQtyChange,
}) {
  if (!container) return;
  container.innerHTML = items.map(item => {
    const fb = feedbackFor?.(item);
    const qty = item.qty ?? 1;
    return `
    <div class="var-card${item.id === activeId ? ' active' : ''}${feedbackClass(fb)}" data-varid="${item.id}">
      <div class="var-card-top">
        <input class="vname" value="${esc(item.name)}">
        <div class="var-btns">
          <button class="vbtn" type="button" title="Edit" data-act="edit"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
          <button class="vbtn" type="button" title="Duplicate" data-act="dup"><i class="fa-solid fa-clone" aria-hidden="true"></i></button>
          <button class="vbtn" type="button" title="Delete" data-act="del"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="var-card-bottom">
        <div class="${thumbClass}" id="${thumbId(item)}"></div>
        <div class="var-card-meta">
          ${statusTileHtml(fb)}
          ${badgeFor?.(item) || ''}
          <div class="var-qty-row">
            <div class="qty-stepper">
              <button class="qty-btn" type="button" data-act="qty-dec" aria-label="Decrease quantity"><i class="fa-solid fa-minus" aria-hidden="true"></i></button>
              <input class="var-qty-input" type="number" min="1" step="1" value="${qty}">
              <button class="qty-btn" type="button" data-act="qty-inc" aria-label="Increase quantity"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  items.forEach(item => {
    const card = container.querySelector(`.var-card[data-varid="${item.id}"]`);
    if (!card) return;
    card.addEventListener('click', () => onSelect?.(item));

    const nameInput = card.querySelector('.vname');
    nameInput.addEventListener('click', e => e.stopPropagation());
    nameInput.addEventListener('change', e => onRename?.(item, e.target.value));

    card.querySelector('[data-act="edit"]').addEventListener('click', e => { e.stopPropagation(); onEdit?.(item); });
    card.querySelector('[data-act="dup"]').addEventListener('click', e => { e.stopPropagation(); onDuplicate?.(item); });
    card.querySelector('[data-act="del"]').addEventListener('click', e => { e.stopPropagation(); onDelete?.(item); });

    const qtyInput = card.querySelector('.var-qty-input');
    card.querySelector('.var-qty-row').addEventListener('click', e => e.stopPropagation());
    const commitQty = delta => {
      const base = parseInt(qtyInput.value, 10) || 1;
      const next = Math.max(1, delta ? base + delta : base);
      qtyInput.value = next;
      onQtyChange?.(item, next);
    };
    qtyInput.addEventListener('change', () => commitQty());
    card.querySelector('[data-act="qty-dec"]').addEventListener('click', () => commitQty(-1));
    card.querySelector('[data-act="qty-inc"]').addEventListener('click', () => commitQty(1));

    const thumbEl = document.getElementById(thumbId(item));
    if (thumbEl) renderThumb?.(thumbEl, item);
  });
}

// Re-paint just the thumbnails without rebuilding the card list — for
// updates (color/style/logo changes) that don't touch name/qty/status.
export function refreshVariationThumbs(items, thumbId, renderThumb) {
  items.forEach(item => {
    const el = document.getElementById(thumbId(item));
    if (el) renderThumb(el, item);
  });
}
