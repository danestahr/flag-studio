import { HS, UI } from './state.js';
import { fillHsLogo, hideHsToolbar, prepareLogo, applyFillToVariation, removeBgFromLogo, detectArtworkBounds, cropSvgToArtwork } from './logo-utils.js';
import { uploadLogo } from '../supabase.js';
import { buildLibStrip, renderVarList } from './variations.js';
import { renderVariationPreview } from './var-canvas.js';
import { logoThumbHtml } from '../media-utils.js';

// ── Zone toolbar ───────────────────────────────────────────

function removeActiveHsLogo() {
  if (!UI.hsActiveZone) return;
  const v = UI.hsActiveZone.variation;
  v.logoId = null; v.logoSrc = null;
  delete v.sponsorText; delete v.artboardSrc;
  hideHsToolbar();
  renderVarList();
  renderVariationPreview();
}

// Delete/Backspace removes the selected logo, unless the user is typing in a
// text field or editing a text layer (which has its own keydown handling).
document.addEventListener('keydown', e => {
  if (!UI.hsActiveZone) return;
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (document.activeElement?.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  removeActiveHsLogo();
});

export function ensureHsToolbar() {
  if (document.getElementById('hsZoneToolbar')) return;
  const t = document.createElement('div');
  t.id = 'hsZoneToolbar';
  t.className = 'dz-toolbar';
  t.innerHTML = `
    <button class="dz-tb-btn" id="hsTbFill">Fill</button>
    <div class="dz-tb-sep" id="hsTbFillSep"></div>
    <button class="dz-tb-btn" id="hsTbRemoveBg">Remove BG</button>
    <div class="dz-tb-sep" id="hsTbRemoveBgSep"></div>
    <button class="dz-tb-btn" id="hsTbRemove">Remove</button>
    <div class="dz-tb-sep" id="hsTbSep"></div>
    <div style="position:relative">
      <button class="dz-tb-btn" id="hsTbReplace">Replace ▾</button>
      <div class="dz-lib-picker" id="hsLibPicker" style="display:none"></div>
    </div>
    <input type="file" id="hsReplaceFile" accept="image/*,.pdf,.ai,.eps" style="display:none">
    <input type="file" id="hsArtboardFile" accept="image/*" style="display:none">`;
  document.body.appendChild(t);

  document.getElementById('hsTbFill').addEventListener('click', fillHsLogo);

  document.getElementById('hsTbRemoveBg').addEventListener('click', async () => {
    const v = UI.hsActiveZone?.variation;
    if (!v?.logoSrc) return;
    const btn = document.getElementById('hsTbRemoveBg');
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Removing…';
    btn.disabled = true;
    // Spinner overlay on the placed logo (not the whole zone) while processing
    const dz = UI.hsActiveZone?.dzone;
    const logoWrap = dz?.querySelector('.dz-logo-wrap') || dz;
    const spinner = document.createElement('div');
    spinner.className = 'logo-processing-spinner';
    logoWrap?.appendChild(spinner);
    try {
      const oldId = v.logoId;
      const logo = HS.library.find(l => l.id === oldId) || { src: v.logoSrc, name: 'logo.png' };
      const newLogo = await removeBgFromLogo(logo, s => { btn.innerHTML = s === 'uploading' ? '<i class="fa-solid fa-arrow-up-from-bracket"></i> Uploading…' : '<i class="fa-solid fa-spinner fa-spin"></i> Removing…'; });
      // Replace in-place — no new library entry
      const origIdx = HS.library.findIndex(l => l.id === oldId);
      if (origIdx >= 0) HS.library.splice(origIdx, 1, newLogo);
      else HS.library.push(newLogo);
      HS.variations.forEach(vv => {
        if (vv.logoId === oldId) {
          vv.logoId = newLogo.id;
          vv.logoSrc = newLogo.src;
          delete vv.logoSrcTight; delete vv.logoAspect; delete vv.logoArtworkBounds;
        }
      });
      v.logoId = newLogo.id;
      v.logoSrc = newLogo.src;
      // Shrink bounding box to actual pixel extents
      const bounds = await detectArtworkBounds(newLogo.src).catch(() => null);
      if (bounds) {
        const tight = await cropSvgToArtwork(newLogo.src, bounds).catch(() => null);
        if (tight) { v.logoSrcTight = tight.url; v.logoAspect = tight.aspect; v.logoArtworkBounds = bounds; }
      }
      v.logoData = { x: 50, y: 50, w: 90 };
      await prepareLogo(v, newLogo.src);
      applyFillToVariation(v);
      buildLibStrip();
      renderVarList();
      renderVariationPreview();
    } catch (err) { console.error('BG removal failed', err); }
    spinner.remove();
    btn.innerHTML = origHTML;
    btn.disabled = false;
    hideHsToolbar();
  });

  document.getElementById('hsTbRemove').addEventListener('click', removeActiveHsLogo);

  document.getElementById('hsTbReplace').addEventListener('click', e => {
    e.stopPropagation();
    const picker = document.getElementById('hsLibPicker');
    const open = picker.style.display !== 'none';
    picker.style.display = open ? 'none' : 'block';
    if (!open) renderHsLibPicker();
  });

  document.getElementById('hsReplaceFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !UI.hsActiveZone) return;
    try {
      const logo = await uploadLogo(HS.projectId, file);
      HS.library.push(logo);
      buildLibStrip();
      const capturedVar = UI.hsActiveZone.variation;
      capturedVar.logoId = logo.id;
      capturedVar.logoSrc = logo.src;
      delete capturedVar.sponsorText;
      if (!capturedVar.logoData) capturedVar.logoData = { x: 50, y: 50, w: 90 };
      prepareLogo(capturedVar, logo.src).then(() => {
        applyFillToVariation(capturedVar);
        renderVarList();
        renderVariationPreview();
      }).catch(() => {});
      hideHsToolbar();
      renderVarList();
      renderVariationPreview();
    } catch (err) { console.error('Upload failed', err); }
  });

  document.getElementById('hsArtboardFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !UI.hsActiveZone) return;
    try {
      const logo = await uploadLogo(HS.projectId, file);
      HS.library.push(logo);
      const v = UI.hsActiveZone.variation;
      v.artboardSrc = logo.src;
      // Clear any logo/text content — artboard replaces it
      v.logoId = null; v.logoSrc = null;
      delete v.sponsorText; delete v.logoSrcTight; delete v.logoData;
      hideHsToolbar();
      renderVarList();
      renderVariationPreview();
    } catch (err) { console.error('Artboard upload failed', err); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#hsZoneToolbar') && !e.target.closest('.dz-logo-wrap') && !e.target.closest('.dzone')) {
      hideHsToolbar();
    }
  });
}

export function renderHsLibPicker() {
  const picker = document.getElementById('hsLibPicker');
  if (!picker || !UI.hsActiveZone) return;
  const { variation } = UI.hsActiveZone;
  const libHtml = HS.library.length
    ? HS.library.map(l => `
        <div class="dz-lp-item${variation.logoId === l.id ? ' active' : ''}" data-lid="${l.id}" title="${l.name}">
          ${logoThumbHtml(l.src, l.name)}
        </div>`).join('')
    : '';
  picker.innerHTML = `
    ${libHtml}
    <div class="dz-lp-upload" id="hsLpUpload">+ Upload image</div>
    <div class="dz-lp-upload" id="hsLpText">+ Type text</div>
    <div class="dz-lp-upload dz-lp-artboard" id="hsLpArtboard">+ Upload full design</div>`;

  picker.querySelectorAll('.dz-lp-item').forEach(el => {
    el.addEventListener('click', () => {
      const logo = HS.library.find(l => l.id === el.dataset.lid);
      if (!logo || !UI.hsActiveZone) return;
      const pickedVar = UI.hsActiveZone.variation;
      pickedVar.logoId = logo.id;
      pickedVar.logoSrc = logo.src;
      delete pickedVar.sponsorText;
      if (!pickedVar.logoData) pickedVar.logoData = { x: 50, y: 50, w: 90 };
      prepareLogo(pickedVar, logo.src).then(() => {
        applyFillToVariation(pickedVar);
        renderVarList();
        renderVariationPreview();
      }).catch(() => {});
      hideHsToolbar();
      renderVarList();
      renderVariationPreview();
    });
  });

  picker.querySelector('#hsLpUpload')?.addEventListener('click', () => {
    document.getElementById('hsReplaceFile').click();
  });

  picker.querySelector('#hsLpArtboard')?.addEventListener('click', () => {
    document.getElementById('hsArtboardFile').click();
  });

  picker.querySelector('#hsLpText')?.addEventListener('click', () => {
    if (!UI.hsActiveZone) return;
    const v = UI.hsActiveZone.variation;
    v.logoId = null;
    v.logoSrc = null;
    if (!v.sponsorText || !v.sponsorText.text || !v.sponsorText.text.trim()) {
      v.sponsorText = {
        text: v.name || 'Sponsor name',
        font: HS.topText?.font || 'dm-serif',
        size: 300,
        color: HS.topText?.color || '#111110',
      };
    }
    hideHsToolbar();
    // Open the variation editor directly at the sponsor text section so the
    // user can edit the text immediately without extra clicks.
    window.startEditVar?.(v.id);
    window.openHsVarMenu?.('sponsor');
  });
}

export function showHsToolbar(dz, openPicker = false) {
  ensureHsToolbar();
  const v = UI.hsActiveZone?.variation;
  const hasLogo = !!v?.logoSrc;
  const hasText = !!(v?.sponsorText?.text && v.sponsorText.text.trim());
  const hasArtboard = !!v?.artboardSrc;
  const hasContent = hasLogo || hasText || hasArtboard;
  document.getElementById('hsTbFill').style.display         = hasLogo ? '' : 'none';
  document.getElementById('hsTbFillSep').style.display      = hasLogo ? '' : 'none';
  document.getElementById('hsTbRemoveBg').style.display     = hasLogo ? '' : 'none';
  document.getElementById('hsTbRemoveBgSep').style.display  = hasLogo ? '' : 'none';
  document.getElementById('hsTbRemove').style.display       = hasContent ? '' : 'none';
  document.getElementById('hsTbSep').style.display          = hasContent ? '' : 'none';
  document.getElementById('hsTbReplace').textContent        = hasLogo ? 'Replace ▾' : hasArtboard ? 'Replace design ▾' : hasText ? 'Change ▾' : 'Add logo or text ▾';

  const picker = document.getElementById('hsLibPicker');
  picker.style.display = openPicker ? 'block' : 'none';
  if (openPicker) renderHsLibPicker();

  const tb = document.getElementById('hsZoneToolbar');
  tb.style.display = 'flex';
  const dzRect = dz.getBoundingClientRect();
  const tbH = tb.offsetHeight || 36;
  const topAbove = dzRect.top + window.scrollY - tbH - 6;
  const topBelow = dzRect.bottom + window.scrollY + 6;
  const top = dzRect.top > tbH + 20 ? topAbove : topBelow;
  tb.style.left = Math.max(8, dzRect.left + window.scrollX) + 'px';
  tb.style.top  = top + 'px';
}
