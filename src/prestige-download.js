import './icons.js';
import { prestigeDownload, logPrestigeDownloadEvent } from './supabase.js';
import { STATUS_LABEL } from './status-labels.js';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const formatSize = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

// Same labels as the project overview (status-labels.js + its 'Submitted'
// override); sent_to_print reads as Approved since Prestige is the one receiving it.
const statusKey = st => (st === 'sent_to_print' ? 'approved' : st);
const statusLabel = st => (st === 'submitted' ? 'Submitted' : STATUS_LABEL[statusKey(st)] || st);

// in_hand_date is a plain date (no time) - parse as local so it doesn't shift a day.
const formatDate = ymd => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatStamp = iso => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

const id = new URLSearchParams(window.location.search).get('id');
const app = document.getElementById('dlApp');
const wrap = inner => `<div class="landing-main" style="max-width:520px">${inner}</div>`;

// The version currently on screen, and whether a download is in flight (a
// refresh must never wipe the tile mid-download).
let current = null;
let busy = false;

async function init(preloaded) {
  let o = preloaded;
  try {
    o ??= await prestigeDownload(id);
  } catch {
    app.innerHTML = wrap(`<div class="project-name-input">Link not valid</div>
      <p style="margin-top:1rem">This download link isn't valid. Email <a href="mailto:design@gsds.space">design@gsds.space</a> and we'll sort it out.</p>`);
    return;
  }
  current = o.versionId;
  const approvedStamp = o.approvedAt && formatStamp(o.approvedAt);
  const approver = o.approvedByName || o.approvedByEmail
    ? `Approved by ${esc(o.approvedByName || '')}${o.approvedByEmail ? ` (${esc(o.approvedByEmail)})` : ''}`
    : '';
  app.innerHTML = wrap(`
    <div id="dlBanner" style="display:none;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1rem;padding:.7rem 1rem;border-radius:var(--r);background:var(--accent-tint);color:var(--accent);font-size:13px;font-weight:500">
      <span>A newer version of this order is available.</span>
      <button type="button" class="btn sm primary" id="dlRefresh"><i class="fa-solid fa-arrow-rotate-right" aria-hidden="true"></i> Refresh</button>
    </div>
    <div class="project-name-row">
      <div class="project-name-input">Prestige Flag Print Files</div>
    </div>
    <div class="tool-card" style="margin-top:1.5rem">
      <div>
        <div class="tool-card-name" style="margin-bottom:2px">${esc(o.project)}</div>
        ${o.creator ? `<div style="font-size:12px;color:var(--gray-400)">Created by ${esc(o.creator)}</div>` : ''}
      </div>
      <div>
        <div class="tool-card-stats">${o.flagCount} ${o.flagCount === 1 ? 'Flag' : 'Flags'}</div>
        ${o.inHandDate ? `<div class="tool-card-stats" style="margin-top:2px">In-Hand Date: ${esc(formatDate(o.inHandDate))}</div>` : ''}
      </div>
      ${o.status ? `<div class="status-block status-${esc(statusKey(o.status))}">
        <div class="status-block-label">Status</div>
        <div class="status-block-value">${esc(statusLabel(o.status))}</div>
      </div>` : ''}
      ${approver ? `<div style="font-size:12px;color:var(--gray-400)">${approver}${approvedStamp ? `<br>${esc(approvedStamp)}` : ''}</div>` : ''}
      <hr class="tool-card-divider">
      <div class="status-block-label" style="margin:0 0 -.6rem">Art Files</div>
      <div style="display:flex;flex-direction:column;gap:.85rem;padding:1rem 1.1rem;border-radius:var(--r);border:1.5px solid var(--gray-100);background:var(--gray-100)">
        <div style="display:flex;align-items:center;gap:1rem">
          <div id="dlIcon" style="font-size:30px;line-height:1;color:var(--accent)"><i class="fa-solid fa-file-zipper" aria-hidden="true"></i></div>
          <div style="min-width:0;flex:1">
            <div style="font-size:14px;font-weight:600;overflow-wrap:anywhere">${esc(o.filename)}</div>
            <div style="font-size:12px;color:var(--gray-500);margin-top:2px">${formatSize(o.sizeBytes)} · ZIP archive</div>
            ${o.generatedAt ? `<div style="font-size:12px;color:var(--gray-500);margin-top:2px">Files generated: ${esc(formatStamp(o.generatedAt))}</div>` : ''}
            <div id="dlDone" hidden style="font-size:12px;font-weight:600;color:var(--gray-500);margin-top:4px">
              <span id="dlDoneLabel"></span><span id="dlAgainWrap"> <span aria-hidden="true" style="color:var(--gray-300);margin:0 .35rem">|</span>
              <button type="button" id="dlAgain" style="background:none;border:none;padding:0;font:inherit;color:var(--accent);cursor:pointer;text-decoration:underline">Download again</button></span>
            </div>
          </div>
        </div>
        <button class="btn primary block" id="dlBtn"><i class="fa-solid fa-circle-arrow-down" aria-hidden="true"></i> Download</button>
      </div>
      <div id="dlStatus" style="min-height:1.2em;font-size:12px;color:var(--gray-400)"></div>
    </div>`);
  const btn = document.getElementById('dlBtn');
  const status = document.getElementById('dlStatus');
  const icon = document.getElementById('dlIcon');
  const done = document.getElementById('dlDone');
  const doneLabel = document.getElementById('dlDoneLabel');
  const againWrap = document.getElementById('dlAgainWrap');
  const iconHtml = icon.innerHTML;
  const startDownload = async () => {
    // Chrome/Edge: open the native Save dialog first (must happen inside the
    // click), then stream the file straight into the chosen location. Other
    // browsers fall back to a normal hidden-link download.
    let handle = null;
    if (window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: o.filename,
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
        });
      } catch (err) {
        if (err.name === 'AbortError') return; // user cancelled the dialog
        handle = null;
      }
    }
    // Progress shows in the tile (spinner where the file icon is), not on the button.
    status.textContent = '';
    btn.style.display = 'none'; // .btn's display beats [hidden], so hide via style
    icon.innerHTML = '<div class="spinner-sm dl-spinner" role="status" aria-label="Downloading"></div>';
    icon.style.color = 'var(--accent)';
    doneLabel.textContent = 'Downloading…';
    againWrap.hidden = true;
    done.hidden = false;
    // A download only counts (prestige_downloads) once the whole file has been
    // fetched; any failure is reported with the stage it died in.
    let stage = 'sign';
    let servedId = o.orderId; // the order the signed URL is actually for
    busy = true;
    try {
      const r = await prestigeDownload(id, true);
      servedId = r.orderId;
      stage = 'fetch';
      const res = await fetch(r.url);
      if (!res.ok) throw new Error(`Download failed (${res.status}). Please try again.`);
      if (handle) {
        // Chrome/Edge: stream straight to the chosen file.
        if (!res.body) throw new Error('Download failed. Please try again.');
        stage = 'write';
        await res.body.pipeTo(await handle.createWritable());
      } else {
        // Other browsers: pull the whole file into memory first so we know it
        // actually arrived, then hand it to the browser as a normal save.
        const blob = await res.blob();
        stage = 'write';
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = o.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 60000);
      }
      await logPrestigeDownloadEvent(servedId, 'complete');
      icon.innerHTML = '<i class="fa-solid fa-file-circle-check" aria-hidden="true"></i>';
      icon.style.color = '#86E99A';
      doneLabel.textContent = 'Download complete';
      againWrap.hidden = false; // "Download again" lives in the status line, not a button
      status.textContent = 'We’ve let GolfStatus know you have the print files.';
    } catch (err) {
      logPrestigeDownloadEvent(servedId, 'error', { stage, message: `${err.name}: ${err.message}` });
      // pipeTo can fail mid-stream (network drop) after the save dialog; a failed
      // sign/log call surfaces the function's own message.
      status.textContent = err.name === 'TypeError'
        ? 'The download was interrupted. Please try again.'
        : `${err.message || 'Download failed.'} If it keeps happening, email design@gsds.space.`;
      icon.innerHTML = iconHtml;
      done.hidden = true;
      btn.style.display = '';
    } finally {
      busy = false;
      checkForNewVersion(); // surface a version that landed mid-download
    }
  };
  document.getElementById('dlRefresh').addEventListener('click', () => { if (!busy) init(pending); });
  btn.addEventListener('click', startDownload);
  document.getElementById('dlAgain').addEventListener('click', startDownload);
}

// Cheap metadata poll: if the link now resolves to a different order than the
// one on screen, offer a refresh (re-render in place; the link itself never changes).
let pending = null;
async function checkForNewVersion() {
  if (!current) return;
  try {
    const m = await prestigeDownload(id);
    if (m.versionId === current) return;
    pending = m;
    const banner = document.getElementById('dlBanner');
    if (banner) banner.style.display = 'flex'; // inline display:flex above would beat [hidden]
  } catch { /* transient - try again next tick */ }
}

if (!id) {
  app.innerHTML = wrap('<div class="project-name-input">Link not valid</div>');
} else {
  init().then(() => {
    setInterval(checkForNewVersion, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForNewVersion(); });
  });
}
