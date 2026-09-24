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

// A card's own DOM node gets torn down and rebuilt by every render (see
// renderVariationListNow below) — including ones triggered by something
// unrelated to the click itself (e.g. the realtime variation_feedback
// subscription in flags/variations.js and hs/app.js, which can fire from
// another tab or another person reviewing the same project). If that
// happens between a click's mousedown and mouseup, the browser drops the
// click entirely, because its target no longer exists in the document —
// the tile visually "presses" (the :active style engages on mousedown) but
// selecting it silently does nothing. Queuing any render that arrives
// mid-gesture and flushing it right after the click has fully resolved
// (instead of applying it immediately and yanking the tile out from under
// the pointer) avoids that without changing what a render actually shows.
let mousedownOnCard = false;
let pendingRender = null;

function flushPendingRender() {
  mousedownOnCard = false;
  if (pendingRender) {
    const { container, items, opts } = pendingRender;
    pendingRender = null;
    renderVariationListNow(container, items, opts);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('mousedown', e => {
    if (e.target.closest?.('.var-card')) mousedownOnCard = true;
  }, true);
  // Bubble (not capture) so this runs after the card's own click listener —
  // by then the gesture is fully resolved either way, so applying a render
  // that arrived mid-click is safe.
  document.addEventListener('click', flushPendingRender);
  // Fallback for a mousedown that never produces a click on this card (button
  // released elsewhere, or a stopPropagation()'d click on a card's own
  // edit/duplicate/qty controls never reaches the listener above) — nothing
  // else would clear the flag otherwise.
  document.addEventListener('mouseup', () => setTimeout(flushPendingRender, 0), true);
}

export function renderVariationList(container, items, opts) {
  if (!container) return;
  if (mousedownOnCard) {
    pendingRender = { container, items, opts };
    return;
  }
  renderVariationListNow(container, items, opts);
}

function renderVariationListNow(container, items, {
  activeId,
  thumbId,             // (item) => string id for the thumbnail element
  thumbClass = 'vthumb',
  renderThumb,          // (el, item) => void
  // Optional independent-back preview, shown stacked under the front
  // thumbnail for just the items it applies to — only the flag editor
  // passes these (per-variation "Same Front & Back Design" toggle, see
  // flags/variations.js's sameSidesOf); hole signs have no front/back
  // concept and never set them.
  showBackThumb = () => false,   // (item) => bool
  backThumbId,          // (item) => string id for the back thumbnail element
  renderBackThumb,      // (el, item) => void
  feedbackFor,          // (item) => feedback object | undefined
  badgeFor,             // (item) => extra badge html | '' (optional, e.g. "Customized")
  onSelect, onRename, onEdit, onDuplicate, onDelete, onQtyChange,
  onViewEdits,          // (item) => void — shown only when feedbackFor(item) is an open request
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
        <div class="vthumb-group">
          <div class="${thumbClass}" id="${thumbId(item)}"></div>
          ${showBackThumb(item) ? `<div class="vthumb-back-label">Back</div><div class="${thumbClass}" id="${backThumbId(item)}"></div>` : ''}
        </div>
        <div class="var-card-meta">
          ${statusTileHtml(fb)}
          ${fb?.status === 'needs_edits' && !fb?.resolved ? '<button type="button" class="var-view-edits-link" data-act="view-edits">View edits</button>' : ''}
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
    card.querySelector('[data-act="view-edits"]')?.addEventListener('click', e => { e.stopPropagation(); onViewEdits?.(item); });

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
    if (showBackThumb(item)) {
      const backThumbEl = document.getElementById(backThumbId(item));
      if (backThumbEl) renderBackThumb?.(backThumbEl, item);
    }
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
