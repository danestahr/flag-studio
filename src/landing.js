import './landing.css';
import './order.css'; // .flag-tmpl-* classes, reused by template-gallery.js
import './icons.js';
import { getSession } from './supabase.js';
import { initHeaderForSession, injectHeaderCta } from './auth.js';
import { listProjects, createProject, deleteProject, getMyRole, listUserLogos, uploadUserLogo, deleteUserLogo } from './supabase.js';
import { esc } from './dom-utils.js';
import { logoThumbHtml, downloadLogo } from './media-utils.js';
import { STATUS_LABEL, STATUS_GROUPS } from './status-labels.js';
import { renderTemplateGallery } from './template-gallery.js';

const PAGE_SIZE = 30;

// Unlike every other page (all gated behind requireAuth()), this one has a
// real public view - browsing templates needs no session at all. getSession()
// never redirects, so branch on its result instead of calling requireAuth().
const session = await getSession();

// Present when arriving via the split-right "Change Flag/Hole Sign" link
// (login.js/signup.js) - an in-progress draft whose event details were just
// saved, to resume rather than lose once a new template's picked below.
const params = new URLSearchParams(window.location.search);
const browseParam = params.get('browse');
const resumeProject = params.get('project');

// Always hand off to login.html - it already knows what to do with a
// selection either way: show it as a preview while an anonymous visitor
// signs in/creates an account, or (already-signed-in branch) skip straight
// to the event-info step if there's already a session. One implementation
// of that step (gallery-side-panel.js's renderEventInfoStep, used by
// login.js/signup.js) instead of a second copy living here.
function onTemplateSelect(type, templateId) {
  // Hole Signs hands off with no templateId (see template-gallery.js) - omit
  // `template` entirely rather than letting URLSearchParams stringify it as
  // the literal text "null".
  const q = { type };
  if (templateId) q.template = templateId;
  if (resumeProject) q.project = resumeProject;
  window.location.href = `/login?${new URLSearchParams(q)}`;
}

// Tournament Flags gets its own browse page (browse-flags.html) rather than
// showing a grid inline here - Hole Signs has no browse step at all, so it
// hands straight off to login/signup with just the type selected.
function onSelectType(type) {
  if (type === 'flag') {
    const q = {};
    if (resumeProject) q.project = resumeProject;
    const qs = new URLSearchParams(q).toString();
    window.location.href = '/browse-flags' + (qs ? `?${qs}` : '');
    return;
  }
  onTemplateSelect('hole-sign', null);
}

if (session) {
  await initHeaderForSession(session);
  initProjectHub(session.user.id, { openGalleryOnLoad: !!browseParam });
  // Not called for now — #sharedLogosSection is hidden (see index.html):
  // cross-project logo sharing isn't needed yet, only cross-tool (flags <->
  // hole signs) within one project. Left wired up, not removed, in case a
  // real cross-project library is wanted later.
  // initSharedLogos();
} else {
  // Anonymous visitor: the header otherwise has nothing but the logo (the
  // signed-in equivalent, injectHeaderActions() in auth.js, adds the avatar/
  // sign-out group instead) - this is the entry point into signing in.
  injectHeaderCta('Sign In', '/login');
  showGallery();
}

function showGallery() {
  document.getElementById('publicGallery').style.display = '';
  renderTemplateGallery(document.getElementById('templateGalleryRoot'), { onSelectType });
}

async function initProjectHub(userId, { openGalleryOnLoad = false } = {}) {
  const role = await getMyRole(userId);

  let query = '';
  let status = '';
  let cursor = null;
  let loading = false;

  const statusFilter = document.getElementById('projectStatusFilter');
  for (const [value, group] of Object.entries(STATUS_GROUPS)) {
    statusFilter.insertAdjacentHTML('beforeend', `<option value="${esc(value)}">${esc(group.label)}</option>`);
  }

  // Flags and hole signs progress through review independently (see
  // status-labels.js) - a project can have Flags: Draft and Hole Signs: In
  // Review at once, so the card shows one pill per design type it actually
  // has, instead of a single whole-project pill.
  function designStatusPill(cfg, label) {
    const status = cfg?.[0]?.status;
    if (!status) return '';
    const statusLabel = STATUS_LABEL[status] || status;
    return `<span class="status-pill status-${esc(status)}" style="flex-shrink:0">${esc(label)}: ${esc(statusLabel)}</span>`;
  }

  function projectCardHtml(p) {
    const name = p.name || 'Untitled';
    const updatedAt = new Date(p.updated_at);
    const date = `${updatedAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}, ${updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
    const hasFlags = p.flag_config?.length > 0;
    const hasHoleSigns = p.hole_sign_config?.length > 0;
    const creatorName = [p.profiles?.first_name, p.profiles?.last_name].filter(Boolean).join(' ');
    const creator = creatorName || p.profiles?.email || null;
    // An Untitled project (no name yet) never made it past the "what
    // tournament is this for" step (gallery-side-panel.js's
    // renderEventInfoStep, which creates the project immediately on arrival
    // and only sets a name once that step is completed) - send them back to
    // that same step to pick up where they left off, rather than
    // project.html's hub, using its recorded intended_type/intended_template.
    // Older Untitled projects predating that step (e.g. the plain "+ New
    // project" fast path) have neither, so they fall back to the hub as before.
    const intendedType = p.customer_info?.intended_type;
    const intendedTemplate = p.customer_info?.intended_template;
    const clickHref = (!p.name && intendedType && intendedTemplate)
      ? `/login?${new URLSearchParams({ type: intendedType, template: intendedTemplate, project: p.id })}`
      : `/project?project=${p.id}`;
    const statusPills = [designStatusPill(p.flag_config, 'Flags'), designStatusPill(p.hole_sign_config, 'Hole Signs')].filter(Boolean).join('');
    return `<div class="draft-card" onclick="window.location.href='${clickHref}'">
      <div class="draft-card-main">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div class="draft-card-name">${esc(name)}</div>
          ${statusPills}
        </div>
        <div class="draft-card-meta">Edited ${date}</div>
        ${creator ? `<div class="draft-card-meta">Created by ${esc(creator)}</div>` : ''}
      </div>
      <div class="draft-card-tools">
        <a class="draft-card-tool${hasFlags ? ' configured' : ''}" href="/flags?project=${p.id}" onclick="event.stopPropagation()"><i class="fa-solid fa-flag" aria-hidden="true"></i> Flags</a>
        <a class="draft-card-tool${hasHoleSigns ? ' configured' : ''}" href="/hole-signs?project=${p.id}" onclick="event.stopPropagation()"><i class="fa-solid fa-signs-post" aria-hidden="true"></i> Hole Signs</a>
        <button type="button" class="draft-card-delete" title="Delete project" onclick="event.stopPropagation();window.openDeleteProjectModal('${p.id}')"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
      </div>
    </div>`;
  }

  function renderLoadMore(nextCursor) {
    const wrap = document.getElementById('loadMoreWrap');
    if (!nextCursor) {
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = '<button class="btn load-more-wrap" id="loadMoreBtn">Load more</button>';
    document.getElementById('loadMoreBtn').addEventListener('click', () => loadPage({ reset: false }));
  }

  async function loadPage({ reset }) {
    if (loading) return;
    loading = true;

    const container = document.getElementById('projectsList');
    if (reset) {
      cursor = null;
      container.innerHTML = '<div class="drafts-empty">Loading…</div>';
    }

    try {
      const { projects: fetched, nextCursor } = await listProjects({ userId, role, cursor, pageSize: PAGE_SIZE, q: query });
      // Filtered client-side, not in the query: PostgREST can't express an
      // OR across flag_config.status and hole_sign_config.status (two
      // different embedded tables) in one request. A project matches if
      // EITHER design type is currently in the selected group - each design
      // progresses independently, so "In Review" should surface a project
      // even when only one side has reached it.
      const group = STATUS_GROUPS[status];
      const projects = group
        ? fetched.filter(p => group.statuses.includes(p.flag_config?.[0]?.status) || group.statuses.includes(p.hole_sign_config?.[0]?.status))
        : fetched;

      if (reset && !projects.length) {
        container.innerHTML = (query || status)
          ? `<div class="drafts-empty">No projects match${query ? ` “${esc(query)}”` : ''}${status ? ` with status “${esc(STATUS_GROUPS[status]?.label || status)}”` : ''}.</div>`
          : '<div class="drafts-empty">No projects yet.</div>';
        renderLoadMore(nextCursor);
        return;
      }

      if (reset) {
        container.innerHTML = `<div class="drafts-grid">${projects.map(projectCardHtml).join('')}</div>`;
      } else {
        const grid = container.querySelector('.drafts-grid');
        if (grid) grid.insertAdjacentHTML('beforeend', projects.map(projectCardHtml).join(''));
        else container.innerHTML = `<div class="drafts-grid">${projects.map(projectCardHtml).join('')}</div>`;
      }

      cursor = nextCursor;
      renderLoadMore(nextCursor);
    } catch (err) {
      console.error(err);
      container.innerHTML = '<div class="drafts-empty">Could not load projects.</div>';
      renderLoadMore(null);
    } finally {
      loading = false;
    }
  }

  let searchDebounce;
  document.getElementById('projectSearch').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      query = e.target.value.trim();
      loadPage({ reset: true });
    }, 250);
  });

  statusFilter.addEventListener('change', (e) => {
    status = e.target.value;
    loadPage({ reset: true });
  });

  window.newProject = async function () {
    try {
      const id = await createProject();
      window.location.href = `/project?project=${id}`;
    } catch (err) {
      console.error(err);
      alert('Could not create project.');
    }
  };

  // ── Delete project modal ──────────────────────────────────
  const deleteModal = document.getElementById('deleteProjectModal');
  const deleteConfirmBtn = document.getElementById('deleteProjectConfirmBtn');
  let deleteTargetId = null;

  window.openDeleteProjectModal = function (projectId) {
    deleteTargetId = projectId;
    deleteModal.style.display = 'flex';
  };

  window.closeDeleteProjectModal = function () {
    deleteModal.style.display = 'none';
    deleteTargetId = null;
  };

  window.confirmDeleteProject = async function () {
    if (!deleteTargetId) return;
    deleteConfirmBtn.disabled = true;
    deleteConfirmBtn.textContent = 'Deleting…';
    try {
      await deleteProject(deleteTargetId);
      window.closeDeleteProjectModal();
      loadPage({ reset: true });
    } catch (err) {
      console.error(err);
      alert('Could not delete project.');
    } finally {
      deleteConfirmBtn.disabled = false;
      deleteConfirmBtn.textContent = 'Delete';
    }
  };

  // "Browse templates" toggle - same gallery component the anonymous branch
  // mounts, just reached from inside the authenticated hub instead of being
  // the whole page. Mounted lazily, once, on first open.
  let galleryMounted = false;
  function openGallery() {
    document.getElementById('projectHub').style.display = 'none';
    document.getElementById('publicGallery').style.display = '';
    document.getElementById('backToProjectsBtn').style.display = '';
    if (!galleryMounted) {
      galleryMounted = true;
      renderTemplateGallery(document.getElementById('templateGalleryRoot'), { onSelectType });
    }
  }
  document.getElementById('browseTemplatesBtn').addEventListener('click', openGallery);
  document.getElementById('backToProjectsBtn').addEventListener('click', () => {
    document.getElementById('publicGallery').style.display = 'none';
    document.getElementById('projectHub').style.display = '';
  });

  if (openGalleryOnLoad) {
    openGallery();
  } else {
    document.getElementById('projectHub').style.display = '';
  }
  loadPage({ reset: true });
}

// Logos reusable across all of this user's projects (see user_logos /
// listUserLogos in supabase.js), managed from the project hub rather than
// any single project's designer. Deleting one here is the only place it can
// be deleted at all — see the modal copy below for why that's a real delete,
// not a per-project removal.
async function initSharedLogos() {
  let sharedLogos = [];

  function renderSharedLogos() {
    const grid = document.getElementById('sharedLogosGrid');
    if (!sharedLogos.length) { grid.innerHTML = '<div class="ci-logo-empty">No shared logos yet</div>'; return; }
    grid.innerHTML = sharedLogos.map(l => `
      <div class="ci-logo-item" id="sl-${l.id}">
        ${logoThumbHtml(l.src, l.name)}
        <div class="ci-logo-name">${esc(l.name)}</div>
        ${l.uploading ? '' : `<button class="ci-logo-dl" title="Download" onclick="downloadSharedLogo('${l.id}')"><i class="fa-solid fa-download" aria-hidden="true"></i></button>`}
        ${l.uploading ? '' : `<button class="ci-logo-del" title="Delete" onclick="window.openDeleteLogoModal('${l.id}')"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`}
      </div>`).join('');
  }

  window.downloadSharedLogo = function (id) {
    const logo = sharedLogos.find(l => l.id === id);
    if (logo) downloadLogo(logo.src, logo.name);
  };

  window.handleSharedLogoUpload = async function (e) {
    const files = Array.from(e.target.files);
    e.target.value = '';
    for (const file of files) {
      const tempId = 'tmp-' + Date.now();
      sharedLogos.push({ id: tempId, name: file.name.replace(/\.[^.]+$/, ''), uploading: true });
      renderSharedLogos();
      try {
        const logo = await uploadUserLogo(file);
        const idx = sharedLogos.findIndex(l => l.id === tempId);
        if (idx !== -1) sharedLogos[idx] = logo;
      } catch (err) {
        console.error('Shared logo upload failed', err);
        sharedLogos = sharedLogos.filter(l => l.id !== tempId);
      }
      renderSharedLogos();
    }
  };
  document.getElementById('sharedLogoFile').addEventListener('change', window.handleSharedLogoUpload);

  // ── Delete shared logo modal ───────────────────────────────
  const deleteLogoModal = document.getElementById('deleteLogoModal');
  const deleteLogoConfirmBtn = document.getElementById('deleteLogoConfirmBtn');
  let deleteLogoTargetId = null;

  window.openDeleteLogoModal = function (id) {
    deleteLogoTargetId = id;
    deleteLogoModal.style.display = 'flex';
  };

  window.closeDeleteLogoModal = function () {
    deleteLogoModal.style.display = 'none';
    deleteLogoTargetId = null;
  };

  window.confirmDeleteLogo = async function () {
    if (!deleteLogoTargetId) return;
    const logo = sharedLogos.find(l => l.id === deleteLogoTargetId);
    deleteLogoConfirmBtn.disabled = true;
    deleteLogoConfirmBtn.textContent = 'Deleting…';
    try {
      if (logo?.storagePath) await deleteUserLogo(logo.storagePath, logo.id);
      sharedLogos = sharedLogos.filter(l => l.id !== deleteLogoTargetId);
      renderSharedLogos();
      window.closeDeleteLogoModal();
    } catch (err) {
      console.error(err);
      alert('Could not delete logo.');
    } finally {
      deleteLogoConfirmBtn.disabled = false;
      deleteLogoConfirmBtn.textContent = 'Delete';
    }
  };

  try {
    sharedLogos = await listUserLogos(session.user.id);
  } catch (err) {
    console.error('Could not load shared logos', err);
  }
  renderSharedLogos();
}
