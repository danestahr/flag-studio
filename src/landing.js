import './landing.css';
import './icons.js';
import { requireAuth } from './auth.js';
import { listProjects, createProject } from './supabase.js';

await requireAuth();

async function renderProjects() {
  const container = document.getElementById('projectsList');
  try {
    const projects = await listProjects();
    if (!projects.length) {
      container.innerHTML = '<div class="drafts-empty">No projects yet.</div>';
      return;
    }
    container.innerHTML = `<div class="drafts-grid">${projects.map(p => {
      const name = p.name || 'Untitled';
      const updatedAt = new Date(p.updated_at);
      const date = `${updatedAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}, ${updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
      const hasFlags = p.flag_config?.length > 0;
      const hasHoleSigns = p.hole_sign_config?.length > 0;
      const creatorName = [p.profiles?.first_name, p.profiles?.last_name].filter(Boolean).join(' ');
      const creator = creatorName || p.profiles?.email || null;
      return `<div class="draft-card" onclick="window.location.href='/project.html?project=${p.id}'">
        <div class="draft-card-main">
          <div class="draft-card-name">${name}</div>
          <div class="draft-card-meta">Edited ${date}</div>
          ${creator ? `<div class="draft-card-meta">Created by ${creator}</div>` : ''}
        </div>
        <div class="draft-card-tools">
          <a class="draft-card-tool${hasFlags ? ' configured' : ''}" href="/flags.html?project=${p.id}" onclick="event.stopPropagation()"><i class="fa-solid fa-flag" aria-hidden="true"></i> Flags</a>
          <a class="draft-card-tool${hasHoleSigns ? ' configured' : ''}" href="/hole-signs.html?project=${p.id}" onclick="event.stopPropagation()"><i class="fa-solid fa-signs-post" aria-hidden="true"></i> Hole Signs</a>
        </div>
      </div>`;
    }).join('')}</div>`;
  } catch (err) {
    console.error(err);
    container.innerHTML = '<div class="drafts-empty">Could not load projects.</div>';
  }
}

window.newProject = async function () {
  try {
    const id = await createProject();
    window.location.href = `/project.html?project=${id}`;
  } catch (err) {
    console.error(err);
    alert('Could not create project.');
  }
};

renderProjects();
