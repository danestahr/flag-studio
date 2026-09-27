import './icons.js';
import { loadProject, loadLogosForProject, uploadLogo, sendLogoUploadNotification } from './supabase.js';
import { isDisplayableImage, fileTypeLabel } from './media-utils.js';

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const projectId = new URLSearchParams(window.location.search).get('project');

const U = {
  loading: true,
  fatalError: '',
  project: null,
  existingLogos: [],
  pendingFiles: [], // { file, previewUrl }
  uploading: false,
  uploadError: '',
  justUploadedCount: 0,
};

function addFiles(files) {
  files.forEach(file => {
    U.pendingFiles.push({ file, previewUrl: isDisplayableImage(file.name) ? URL.createObjectURL(file) : null });
  });
  U.uploadError = '';
  U.justUploadedCount = 0;
  render();
}

window.removePendingFile = function (i) {
  const [pf] = U.pendingFiles.splice(i, 1);
  if (pf?.previewUrl) URL.revokeObjectURL(pf.previewUrl);
  render();
};

window.uploadPendingFiles = async function () {
  if (!U.pendingFiles.length || U.uploading) return;
  U.uploading = true;
  U.uploadError = '';
  render();

  const filesToUpload = U.pendingFiles;
  const uploaded = [];
  try {
    for (const pf of filesToUpload) {
      uploaded.push(await uploadLogo(projectId, pf.file));
    }
  } catch (err) {
    console.error('Logo upload failed', err);
    U.uploading = false;
    U.uploadError = /row-level security/i.test(err?.message || '')
      ? "This project can no longer accept new logo uploads — it may already be under review. Please contact us directly if you need to make changes."
      : 'Something went wrong uploading your logo. Please try again.';
    render();
    return;
  }

  U.existingLogos = [...U.existingLogos, ...uploaded.map(r => ({ id: r.id, name: r.name, src: r.src, storagePath: r.storagePath }))];
  filesToUpload.forEach(pf => { if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl); });
  U.justUploadedCount = filesToUpload.length;
  U.pendingFiles = [];
  U.uploading = false;
  render();

  sendLogoUploadNotification({
    projectId,
    eventName: U.project?.name || '',
    logoFileNames: filesToUpload.map(pf => pf.file.name),
    projectUrl: `${window.location.origin}/project?project=${projectId}`,
  }).catch(err => console.warn('Logo upload notification failed', err));
};

function attachListeners() {
  const dropzone = document.getElementById('logoDropzone');
  const fileInput = document.getElementById('logoFileInput');
  if (!dropzone || !fileInput) return;

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    addFiles(Array.from(e.dataTransfer.files));
  });
  fileInput.addEventListener('change', e => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    addFiles(files);
  });
}

function logoGrid(items) {
  return `<div class="logo-preview-grid">${items}</div>`;
}

function render() {
  const app = document.getElementById('uploadApp');
  if (!app) return;

  if (U.loading) {
    app.innerHTML = `<div class="order-wrap"><p class="order-sub">Loading…</p></div>`;
    return;
  }

  if (U.fatalError) {
    app.innerHTML = `
      <div class="order-wrap">
        <div class="order-header-row">
          <div class="order-header-text">
            <div class="order-title">Upload Logos</div>
            <div class="order-sub">${esc(U.fatalError)}</div>
          </div>
        </div>
      </div>`;
    return;
  }

  const existingHtml = U.existingLogos.length
    ? logoGrid(U.existingLogos.map(l => `
        <div class="logo-preview-item">
          ${isDisplayableImage(l.src)
            ? `<img src="${esc(l.src)}" alt="${esc(l.name)}">`
            : `<div class="file-type-badge">${esc(fileTypeLabel(l.src))}</div>`}
        </div>`).join(''))
    : `<p class="order-sub">No logos uploaded yet.</p>`;

  const pendingHtml = U.pendingFiles.length
    ? logoGrid(U.pendingFiles.map((pf, i) => `
        <div class="logo-preview-item">
          ${pf.previewUrl
            ? `<img src="${pf.previewUrl}" alt="Logo ${i + 1}">`
            : `<div class="file-type-badge">${esc(fileTypeLabel(pf.file.name))}</div>`}
          <button class="logo-preview-remove" onclick="window.removePendingFile(${i})" title="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>`).join(''))
    : '';

  app.innerHTML = `
    <div class="order-wrap">
      <div class="order-header-row">
        <div class="order-header-text">
          <div class="order-title">Upload Logos</div>
          <div class="order-sub">${U.project?.name ? `For ${esc(U.project.name)} — add logos any time before your proof is ready.` : 'Add logos to your project any time before your proof is ready.'}</div>
        </div>
      </div>
      <div class="order-card">
        <div class="form-field">
          <label class="form-label">Current logos</label>
          ${existingHtml}
        </div>
        <div class="form-field">
          <label class="form-label">Add logos</label>
          <div class="logo-dropzone" id="logoDropzone">
            <div class="logo-dropzone-icon"><i class="fa-solid fa-upload" aria-hidden="true"></i></div>
            <div class="logo-dropzone-text">Drop logos here or click to upload</div>
            <div class="logo-dropzone-sub">SVG, PNG, PDF, AI, EPS</div>
          </div>
          <input type="file" id="logoFileInput" accept=".svg,.png,.pdf,.ai,.eps,image/*" multiple style="display:none">
          ${U.uploadError ? `<div class="form-error">${esc(U.uploadError)}</div>` : ''}
          ${U.justUploadedCount ? `<div style="font-size:12px;color:var(--gold)">Uploaded ${U.justUploadedCount} logo${U.justUploadedCount === 1 ? '' : 's'}.</div>` : ''}
          ${pendingHtml}
        </div>
        ${U.pendingFiles.length ? `
        <button class="btn primary" onclick="window.uploadPendingFiles()" ${U.uploading ? 'disabled' : ''} style="justify-content:center">
          ${U.uploading ? 'Uploading…' : `Upload ${U.pendingFiles.length} logo${U.pendingFiles.length === 1 ? '' : 's'}`}
        </button>` : ''}
      </div>
    </div>`;

  attachListeners();
}

async function init() {
  if (!projectId) {
    U.loading = false;
    U.fatalError = 'This link is missing a project. Please use the link from your confirmation email.';
    render();
    return;
  }

  render();
  try {
    const [project, logos] = await Promise.all([loadProject(projectId), loadLogosForProject(projectId)]);
    U.project = project;
    U.existingLogos = logos;
  } catch (err) {
    console.warn('Failed to load project for upload page', err);
    U.fatalError = "We couldn't find that project. The link may be incorrect, or it may no longer be active.";
  }
  U.loading = false;
  render();
}

init();
