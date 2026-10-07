import './landing.css';
import './order.css'; // .flag-tmpl-* classes, reused by template-gallery.js
import './icons.js';
import { getSession } from './supabase.js';
import { initHeaderForSession, injectHeaderCta } from './auth.js';
import { listProjects, createProject, deleteProject, getMyRole } from './supabase.js';
import { esc } from './dom-utils.js';
import { STATUS_LABEL, STATUS_GROUPS } from './status-labels.js';
import { calcApprovalDeadline, formatDate } from './intake-shared.js';
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
  let due = '';
  let product = '';
  let cursor = null;
  let loading = false;

  const statusFilter = document.getElementById('projectStatusFilter');
  for (const [value, group] of Object.entries(STATUS_GROUPS)) {
    statusFilter.insertAdjacentHTML('beforeend', `<option value="${esc(value)}">${esc(group.label)}</option>`);
  }

  // Not a status group: it's the absence of both design configs, which is
  // what the "Not started" pill on the card means.
  const NOT_STARTED = 'not_started';
  statusFilter.options[0].insertAdjacentHTML('afterend', `<option value="${NOT_STARTED}">Not started</option>`);
  const statusLabelFor = (v) => (v === NOT_STARTED ? 'Not started' : STATUS_GROUPS[v]?.label || v);

  // Flags and hole signs progress through review independently (see
  // status-labels.js) - a project can have Flags: Draft and Hole Signs: In
  // Review at once, so the card shows one pill per design type it actually
  // has, instead of a single whole-project pill.
  // flag_config/hole_sign_config have UNIQUE(project_id), so PostgREST embeds
  // them as a single object (or null), not an array - normalize either shape.
  const cfgOf = (cfg) => (Array.isArray(cfg) ? cfg[0] : cfg) || null;

  function designStatusPill(cfg, label) {
    const status = cfgOf(cfg)?.status;
    if (!status) return '';
    const statusLabel = STATUS_LABEL[status] || status;
    return `<span class="status-pill status-${esc(status)}" style="flex-shrink:0">${esc(label)}: ${esc(statusLabel)}</span>`;
  }

  // "Approval due Sep 1, 2026 for Sep 18, 2026 event"
  function deadlineLine(p) {
    const eventIso = p.customer_info?.event_date || p.order_intakes?.[0]?.event_date;
    const dl = calcApprovalDeadline(eventIso);
    if (!dl) return '';
    return `<div class="draft-card-meta">Approval due ${esc(dl.display)} for ${esc(formatDate(eventIso))} event</div>`;
  }

  function projectCardHtml(p) {
    const name = p.name || 'Untitled';
    const updatedAt = new Date(p.updated_at);
    const date = `${updatedAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}, ${updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
    const hasFlags = !!cfgOf(p.flag_config);
    const hasHoleSigns = !!cfgOf(p.hole_sign_config);
    // An order submitted anonymously (see order.js) has no `profiles` row at
    // all until the customer later signs up and claimAccount()/
    // claimMyProjects() attaches it — until then, fall back to the contact
    // email on file (customer_info, staff-corrected, ahead of the original
    // order_intakes submission) so staff can still see who placed the order.
    //
    // A project created via the "+ New project" admin fast-path instead has
    // `created_by` = the staff/admin's own uid (there's no order submission
    // at all), so profiles.email there is the staff member, not a customer —
    // label it as such rather than implying a customer placed the order.
    const creatorName = [p.profiles?.first_name, p.profiles?.last_name].filter(Boolean).join(' ');
    const isStaffCreated = p.profiles?.role === 'staff' || p.profiles?.role === 'admin';
    const creator = isStaffCreated
      ? (creatorName || p.profiles?.email || 'unknown')
      : creatorName || p.profiles?.email || p.customer_info?.contact_email || p.order_intakes?.[0]?.contact_email || null;
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
    const statusPills = [designStatusPill(p.flag_config, 'Flags'), designStatusPill(p.hole_sign_config, 'Hole Signs')].filter(Boolean).join('') || '<span class="status-pill" style="flex-shrink:0">Not started</span>';
    return `<div class="draft-card" onclick="window.location.href='${clickHref}'">
      <div class="draft-card-main">
        <div class="draft-card-name">${esc(name)}</div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0 2px">${statusPills}</div>
        ${deadlineLine(p)}
        ${creator ? `<div class="draft-card-meta">Created by ${esc(creator)}</div>` : ''}
        <div class="draft-card-meta" style="opacity:.5">Edited ${date}</div>
      </div>
      <div class="draft-card-tools">
        ${hasFlags ? `<a class="draft-card-tool configured" href="/flags?project=${p.id}" onclick="event.stopPropagation()"><i class="fa-solid fa-flag" aria-hidden="true"></i> Flags</a>` : ''}
        ${hasHoleSigns ? `<a class="draft-card-tool configured" href="/hole-signs?project=${p.id}" onclick="event.stopPropagation()"><i class="fa-solid fa-signs-post" aria-hidden="true"></i> Hole Signs</a>` : ''}
        <button type="button" class="draft-card-delete" title="Delete project" onclick="event.stopPropagation();window.openDeleteProjectModal('${p.id}')"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
      </div>
    </div>`;
  }

  // Artwork approval deadline (calcApprovalDeadline: 17 days before the
  // event, nudged back off the weekend) - the same date customers are shown
  // in order.js/submitted.js, not the event date itself. customer_info holds
  // the staff-corrected event date; the original intake is the fallback.
  const approvalIso = (p) => calcApprovalDeadline(p.customer_info?.event_date || p.order_intakes?.[0]?.event_date)?.iso || null;
  const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const DONE = ['approved', 'sent_to_print'];

  function matchesDue(p) {
    if (!due) return true;
    const iso = approvalIso(p);
    if (!iso) return false;
    // Already signed off on every design it has - nothing left to be due.
    const statuses = [cfgOf(p.flag_config)?.status, cfgOf(p.hole_sign_config)?.status].filter(Boolean);
    if (statuses.length && statuses.every(s => DONE.includes(s))) return false;
    const now = new Date();
    const today = localIso(now);
    if (due === 'overdue') return iso < today;
    if (due === 'today') return iso === today;
    if (due === 'tomorrow') return iso === localIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    if (due === 'week') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)); // Monday
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      return iso >= localIso(start) && iso <= localIso(end);
    }
    return iso.slice(0, 7) === today.slice(0, 7); // month
  }

  const matchesStatus = (p) => {
    if (!matchesDue(p)) return false;
    const flagCfg = cfgOf(p.flag_config);
    const hsCfg = cfgOf(p.hole_sign_config);
    // Product filter narrows both the project set and which design's status
    // the status filter looks at.
    const cfgs = product === 'flags' ? [flagCfg] : product === 'hole_signs' ? [hsCfg] : [flagCfg, hsCfg];
    if (status === NOT_STARTED) return !cfgs.some(Boolean);
    if (product && !cfgs[0]) return false;
    const group = STATUS_GROUPS[status];
    if (!group) return true;
    return cfgs.some(c => group.statuses.includes(c?.status));
  };

  // Infinite scroll: a sentinel below the list triggers the next page when it
  // scrolls into view. Re-observed after every load so a sentinel that's
  // still visible (short page / tall screen) keeps fetching.
  const sentinel = document.getElementById('loadMoreWrap');
  const observer = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting) && cursor && !loading) loadPage({ reset: false });
  }, { rootMargin: '400px' });
  observer.observe(sentinel);

  // Bumped on every reset so an in-flight request from a previous
  // search/filter can't append stale rows into the new result set.
  let generation = 0;

  async function loadPage({ reset }) {
    if (loading && !reset) return;
    const myGen = reset ? ++generation : generation;
    loading = true;

    const container = document.getElementById('projectsList');
    if (reset) {
      cursor = null;
      container.innerHTML = '<div class="drafts-empty">Loading…</div>';
      sentinel.innerHTML = '';
    } else {
      sentinel.innerHTML = '<div class="drafts-empty">Loading more…</div>';
    }

    try {
      // The status filter is applied client-side (PostgREST can't OR across
      // flag_config.status and hole_sign_config.status), so one server page
      // may yield few or zero matches. Keep pulling pages until we have a
      // full page of matches or the table is exhausted - otherwise matches
      // sitting beyond the first non-matching pages would never show up.
      let projects = [];
      let next = cursor;
      do {
        const res = await listProjects({ userId, role, cursor: next, pageSize: PAGE_SIZE, q: query });
        if (myGen !== generation) return;
        projects = projects.concat(res.projects.filter(matchesStatus));
        next = res.nextCursor;
      } while (next && projects.length < PAGE_SIZE);

      if (reset && !projects.length) {
        container.innerHTML = (query || status || due || product)
          ? `<div class="drafts-empty">No projects match${query ? ` “${esc(query)}”` : ''}${status ? ` with status “${esc(statusLabelFor(status))}”` : ''}${due ? ' and that deadline' : ''}.</div>`
          : '<div class="drafts-empty">No projects yet.</div>';
      } else if (reset) {
        container.innerHTML = `<div class="drafts-grid">${projects.map(projectCardHtml).join('')}</div>`;
      } else {
        const grid = container.querySelector('.drafts-grid');
        if (grid) grid.insertAdjacentHTML('beforeend', projects.map(projectCardHtml).join(''));
        else container.innerHTML = `<div class="drafts-grid">${projects.map(projectCardHtml).join('')}</div>`;
      }

      cursor = next;
      sentinel.innerHTML = '';
    } catch (err) {
      if (myGen !== generation) return;
      console.error(err);
      if (reset) container.innerHTML = '<div class="drafts-empty">Could not load projects.</div>';
      sentinel.innerHTML = '';
      cursor = null;
    } finally {
      if (myGen === generation) {
        loading = false;
        // Sentinel may still be on screen after a short page; re-check.
        if (cursor) { observer.unobserve(sentinel); observer.observe(sentinel); }
      }
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

  document.getElementById('projectDueFilter').addEventListener('change', (e) => {
    due = e.target.value;
    loadPage({ reset: true });
  });

  document.getElementById('projectProductFilter').addEventListener('change', (e) => {
    product = e.target.value;
    loadPage({ reset: true });
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

