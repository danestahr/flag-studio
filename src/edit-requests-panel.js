import { esc } from './dom-utils.js';

// Shared "Edit requests" sub-view for the flag & hole-sign Variations steps —
// renders INLINE into a container (replacing its content), not a modal. It's
// meant to read as another page of the same right-hand "All variations" /
// "Variations" menu — the same back-button pattern that panel's own
// per-variation editor already uses (varEditPanel in flags-variations.html /
// renderEditor in hs/var-editor.js) — reached either from a specific
// variation's own "View edits" link (pass `filterVariationId` to show just
// that one request) or from the canvas banner's "View all edits" (omit it to
// show every open request).
//
// Each row: the variation's name, then a combined preview of what it would
// look like with every pending quick-pick applied together (renderThumb),
// then a row-wide "Apply all" (or "Mark as resolved" when there's nothing
// structured to apply), the customer's note in its own labeled section, and
// one section per requested field (Flag/Template, a color, Logo — a field
// like colors is free to register once per individual color rather than one
// lumped-together field) — each with its own label, its own preview of just
// that field's requested value, and its own Apply button, so staff can act
// on one piece of feedback without the others.

// `renderThumb(el, v, fb)`: paints the COMBINED "as if every present field
// were applied" preview — the host merges fb's requested_* values onto a
// throwaway copy of v (never mutating the real variation) and renders that,
// not v's current state.
// `fields`: [{ key, sectionLabel, has(fb) => bool, apply(v, fb) => void|Promise, interactiveApply(v, fb) => void|Promise, preview(el, fb) => void }]
//   sectionLabel: short heading for that field's own section ("Flag", "Primary Color", "Logo").
//   apply: used by both "Apply all" paths (row-wide and panel-wide) — must
//     resolve deterministically with no UI of its own, since several fields'
//     apply() may run back-to-back in a loop.
//   interactiveApply: optional override used ONLY by that field's own section
//     button — when a field's Apply needs to ask the user something first
//     (e.g. "which of these logos should the new one replace?"), it can take
//     over the container entirely instead of running apply(); it owns its own
//     completion, refresh and any navigation back, so this panel does nothing
//     further once interactiveApply is called (no onApplied/paintRow).
//   preview: paints the REQUESTED value alone (a flag/template thumb, a
//     color's own swatch+hex, the uploaded logo image) — optional, a field
//     can omit it.
// `resolve(variationId) => Promise` marks the DB row resolved.
// `onApplied(v)` lets the host refresh its own list/canvas/thumbs after a
// field mutates the variation in place — fired once a row is fully settled
// (after resolve(), not before), so a host reading resolved state off its own
// feedback array (e.g. a "View all edits" banner's pending count) sees the
// final state rather than a mid-flight one.
// `persist() => Promise` is called once a row is fully applied, right before
// resolve() — so a resolved request is never left backed by unsaved config.
// `onBack()` returns the container to whatever it showed before this panel.
export function renderEditRequestsPanel(container, { variations, feedback, renderThumb, fields, resolve, onApplied, persist, thumbAspect, filterVariationId, onBack }) {
  if (!container) return;

  const rows = (feedback || [])
    .filter(fb => fb.status === 'needs_edits')
    .filter(fb => !filterVariationId || fb.variation_id === filterVariationId)
    .map(fb => ({ fb, v: variations.find(v => v.id === fb.variation_id) }))
    .filter(r => !!r.v)
    .sort((a, b) => (a.fb.resolved === b.fb.resolved) ? 0 : (a.fb.resolved ? 1 : -1));

  const pendingCount = rows.filter(r => !r.fb.resolved).length;
  container.innerHTML = `
    <div class="hs-menu-section-header">
      <button class="hs-menu-back" id="erpBack"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back</button>
      <div class="hs-menu-section-titlerow">
        <span class="hs-menu-section-title">${filterVariationId ? 'Edit request' : 'Edit requests'}</span>
        ${!filterVariationId && pendingCount ? '<button type="button" class="erm-apply-all-btn erm-apply-all-btn-top" id="erpApplyAll">Apply all</button>' : ''}
      </div>
    </div>
    <div class="erm-list" id="erpList"></div>`;

  container.querySelector('#erpBack').addEventListener('click', () => onBack?.());

  const list = container.querySelector('#erpList');
  if (!rows.length) {
    list.innerHTML = '<div class="erm-empty">No edit requests yet.</div>';
  }

  async function applyRow(row) {
    const applicable = fields.filter(f => f.has(row.fb));
    for (const f of applicable) await f.apply(row.v, row.fb);
    await persist?.();
    await resolve(row.v.id);
    row.fb.resolved = true;
    onApplied?.(row.v);
    paintRow(row);
    if (!rows.some(r => !r.fb.resolved)) container.querySelector('#erpApplyAll')?.remove();
  }

  function paintRow(row) {
    const el = list.querySelector(`[data-fbid="${row.fb.id}"]`);
    if (!el) return;
    el.classList.toggle('resolved', !!row.fb.resolved);
    const thumbEl = el.querySelector('.erm-thumb');
    if (thumbEl) renderThumb(thumbEl, row.v, row.fb);

    const actionsEl = el.querySelector('.erm-row-actions');
    const sectionsEl = el.querySelector('.erm-sections');
    if (row.fb.resolved) {
      if (actionsEl) actionsEl.innerHTML = '<span class="var-edit-resolved-tag">Resolved</span>';
      if (sectionsEl) sectionsEl.innerHTML = '';
      return;
    }

    const applicable = fields.filter(f => f.has(row.fb));
    if (actionsEl) {
      actionsEl.innerHTML = `<button type="button" class="erm-apply-all-btn" data-act="apply-row">${applicable.length ? 'Apply all' : 'Mark as resolved'}</button>`;
      actionsEl.querySelector('[data-act="apply-row"]').addEventListener('click', async () => {
        el.querySelectorAll('button').forEach(b => b.disabled = true);
        try {
          await applyRow(row);
        } catch (err) {
          console.error('Apply edit request failed', err);
          alert('Could not apply this edit request. Please try again.');
          el.querySelectorAll('button').forEach(b => b.disabled = false);
        }
      });
    }

    if (sectionsEl) {
      sectionsEl.innerHTML = applicable.map(f => `
        <div class="erm-section">
          <div class="erm-section-label">${esc(f.sectionLabel)}</div>
          <div class="erm-section-preview" data-field-preview="${f.key}"></div>
          <button type="button" class="erm-section-apply-btn" data-field="${f.key}">Apply</button>
        </div>`).join('');
      applicable.forEach(f => {
        if (!f.preview) return;
        const previewEl = sectionsEl.querySelector(`[data-field-preview="${f.key}"]`);
        if (previewEl) f.preview(previewEl, row.fb);
      });
      sectionsEl.querySelectorAll('[data-field]').forEach(btn => {
        btn.addEventListener('click', async () => {
          el.querySelectorAll('button').forEach(b => b.disabled = true);
          const f = fields.find(x => x.key === btn.dataset.field);
          try {
            // A field can take over entirely (e.g. flags' Logo section opening
            // a "which logo?" sub-view when more than one is placed) — it owns
            // its own completion/refresh in that case, so skip the generic
            // onApplied/paintRow that would otherwise run against this row's
            // now-superseded DOM.
            if (f.interactiveApply) { await f.interactiveApply(row.v, row.fb); return; }
            await f.apply(row.v, row.fb);
            await persist?.();
            onApplied?.(row.v);
            paintRow(row);
          } catch (err) {
            console.error('Apply edit request field failed', err);
            alert('Could not apply this change. Please try again.');
            el.querySelectorAll('button').forEach(b => b.disabled = false);
          }
        });
      });
    }
  }

  rows.forEach(row => {
    const el = document.createElement('div');
    el.className = 'erm-row' + (row.fb.resolved ? ' resolved' : '');
    el.dataset.fbid = row.fb.id;
    el.innerHTML = `
      <div class="erm-row-title">${esc(row.v.name || 'Variation')}</div>
      <div class="erm-thumb"${thumbAspect ? ` style="aspect-ratio:${thumbAspect}"` : ''}></div>
      <div class="erm-row-actions"></div>
      <div class="erm-section">
        <div class="erm-section-label">Notes</div>
        <div class="erm-row-note">${esc(row.fb.note || 'Client requested edits for this variation.')}</div>
      </div>
      <div class="erm-sections"></div>`;
    list.appendChild(el);
    paintRow(row);
  });

  container.querySelector('#erpApplyAll')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      for (const row of rows) {
        if (!row.fb.resolved) await applyRow(row);
      }
    } catch (err) {
      console.error('Apply all edit requests failed', err);
      alert('Could not apply all edit requests. Please try again.');
      if (e.target.isConnected) e.target.disabled = false;
    }
  });
}
