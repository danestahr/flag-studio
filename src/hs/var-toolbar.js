import { HS, UI } from './state.js';
import { fillHsLogo, hideHsToolbar, prepareLogo, applyFillToVariation } from './logo-utils.js';
import { uploadLogo } from '../supabase.js';
import { buildLibStrip, renderVarList } from './variations.js';
import { renderVariationPreview } from './var-canvas.js';
import { logoThumbHtml } from '../media-utils.js';

// ── Zone toolbar ───────────────────────────────────────────

export function ensureHsToolbar() {
  if (document.getElementById('hsZoneToolbar')) return;
  const t = document.createElement('div');
  t.id = 'hsZoneToolbar';
  t.className = 'dz-toolbar';
  t.innerHTML = `
    <button class="dz-tb-btn" id="hsTbFill">Fill</button>
    <div class="dz-tb-sep" id="hsTbFillSep"></div>
    <button class="dz-tb-btn" id="hsTbRemove">Remove</button>
    <div class="dz-tb-sep" id="hsTbSep"></div>
    <div style="position:relative">
      <button class="dz-tb-btn" id="hsTbReplace">Replace ▾</button>
      <div class="dz-lib-picker" id="hsLibPicker" style="display:none"></div>
    </div>
    <input type="file" id="hsReplaceFile" accept="image/*,.pdf,.ai,.eps" style="display:none">`;
  document.body.appendChild(t);

  document.getElementById('hsTbFill').addEventListener('click', fillHsLogo);

  document.getElementById('hsTbRemove').addEventListener('click', () => {
    if (!UI.hsActiveZone) return;
    UI.hsActiveZone.variation.logoId = null;
    UI.hsActiveZone.variation.logoSrc = null;
    delete UI.hsActiveZone.variation.sponsorText;
    hideHsToolbar();
    renderVarList();
    renderVariationPreview();
  });

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
    <div class="dz-lp-upload" id="hsLpText">+ Type text</div>`;

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
    renderVarList();
    renderVariationPreview();
  });
}

export function showHsToolbar(dz, openPicker = false) {
  ensureHsToolbar();
  const v = UI.hsActiveZone?.variation;
  const hasLogo = !!v?.logoSrc;
  const hasText = !!(v?.sponsorText?.text && v.sponsorText.text.trim());
  const hasContent = hasLogo || hasText;
  document.getElementById('hsTbFill').style.display    = hasLogo ? '' : 'none';
  document.getElementById('hsTbFillSep').style.display = hasLogo ? '' : 'none';
  document.getElementById('hsTbRemove').style.display  = hasContent ? '' : 'none';
  document.getElementById('hsTbSep').style.display     = hasContent ? '' : 'none';
  document.getElementById('hsTbReplace').textContent   = hasLogo ? 'Replace ▾' : hasText ? 'Change ▾' : 'Add logo or text ▾';

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
