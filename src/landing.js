import './landing.css';
import './icons.js';
import { requireAuth } from './auth.js';
import { listProjects, createProject, getMyRole } from './supabase.js';
import { esc } from './dom-utils.js';

const PAGE_SIZE = 30;

const session = await requireAuth();
const userId = session.user.id;
const role = await getMyRole(userId);

let query = '';
let cursor = null;
let loading = false;

function projectCardHtml(p) {
  const name = p.name || 'Untitled';
  const updatedAt = new Date(p.updated_at);
  const date = `${updatedAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}, ${updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
  const hasFlags = p.flag_config?.length > 0;
  const hasHoleSigns = p.hole_sign_config?.length > 0;
  const creatorName = [p.profiles?.first_name, p.profiles?.last_name].filter(Boolean).join(' ');
  const creator = creatorName || p.profiles?.email || null;
  return `<div class="draft-card" onclick="window.location.href='/project.html?project=${p.id}'">
    <div class="draft-card-main">
      <div class="draft-card-name">${esc(name)}</div>
      <div class="draft-card-meta">Edited ${date}</div>
      ${creator ? `<div class="draft-card-meta">Created by ${esc(creator)}</div>` : ''}
    </div>
    <div class="draft-card-tools">
      <a class="draft-card-tool${hasFlags ? ' configured' : ''}" href="/flags.html?project=${p.id}" onclick="event.stopPropagation()"><i class="fa-solid fa-flag" aria-hidden="true"></i> Flags</a>
      <a class="draft-card-tool${hasHoleSigns ? ' configured' : ''}" href="/hole-signs.html?project=${p.id}" onclick="event.stopPropagation()"><i class="fa-solid fa-signs-post" aria-hidden="true"></i> Hole Signs</a>
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
    const { projects, nextCursor } = await listProjects({ userId, role, cursor, pageSize: PAGE_SIZE, q: query });

    if (reset && !projects.length) {
      container.innerHTML = query
        ? `<div class="drafts-empty">No projects match “${esc(query)}”.</div>`
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

window.newProject = async function () {
  try {
    const id = await createProject();
    window.location.href = `/project.html?project=${id}`;
  } catch (err) {
    console.error(err);
    alert('Could not create project.');
  }
};

loadPage({ reset: true });
