import './landing.css';
import './order.css'; // .flag-tmpl-* classes, reused by template-gallery.js
import './icons.js';
import { getSession } from './supabase.js';
import { initHeaderForSession, injectHeaderCta } from './auth.js';
import { listProjects, createProject, deleteProject, getMyRole } from './supabase.js';
import { esc } from './dom-utils.js';
import { STATUS_LABEL } from './status-labels.js';
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
  for (const [value, label] of Object.entries(STATUS_LABEL)) {
    statusFilter.insertAdjacentHTML('beforeend', `<option value="${esc(value)}">${esc(label)}</option>`);
  }

  function projectCardHtml(p) {
    const name = p.name || 'Untitled';
    const updatedAt = new Date(p.updated_at);
    const date = `${updatedAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}, ${updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
    const hasFlags = p.flag_config?.length > 0;
    const hasHoleSigns = p.hole_sign_config?.length > 0;
    const creatorName = [p.profiles?.first_name, p.profiles?.last_name].filter(Boolean).join(' ');
    const creator = creatorName || p.profiles?.email || null;
    const statusLabel = STATUS_LABEL[p.status] || p.status;
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
    return `<div class="draft-card" onclick="window.location.href='${clickHref}'">
      <div class="draft-card-main">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="draft-card-name">${esc(name)}</div>
          ${statusLabel ? `<span class="status-pill status-${esc(p.status)}" style="flex-shrink:0">${esc(statusLabel)}</span>` : ''}
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
      const { projects, nextCursor } = await listProjects({ userId, role, cursor, pageSize: PAGE_SIZE, q: query, status });

      if (reset && !projects.length) {
        container.innerHTML = (query || status)
          ? `<div class="drafts-empty">No projects match${query ? ` “${esc(query)}”` : ''}${status ? ` with status “${esc(STATUS_LABEL[status] || status)}”` : ''}.</div>`
          : '<div class="drafts-empty">No projects yet.</div>';
        renderLoadMore(null);
        return;
      }

      if (reset) {
        container.innerHTML = `<div class="drafts-grid">${projects.map(projectCardHtml).join('')}</div>`;
      } else {
        container.querySelector('.drafts-grid').insertAdjacentHTML('beforeend', projects.map(projectCardHtml).join(''));
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
