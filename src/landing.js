import './landing.css';
import { listProjects, createProject, deleteProject } from './supabase.js';

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
      const date = new Date(p.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const hasFlags = p.flag_config?.length > 0;
      const hasHoleSigns = p.hole_sign_config?.length > 0;
      return `<a class="draft-card" href="/project.html?project=${p.id}">
        <div class="draft-card-top">
          <div class="draft-card-name">${name}</div>
          <button class="draft-card-del" onclick="event.preventDefault();event.stopPropagation();confirmDelete('${p.id}','${name.replace(/'/g, "\\'")}')">✕</button>
        </div>
        <div class="draft-card-meta">${date}</div>
        <div class="draft-card-tools">
          <span class="draft-card-tool${hasFlags ? ' configured' : ''}">🚩 Flags</span>
          <span class="draft-card-tool${hasHoleSigns ? ' configured' : ''}">⛳ Hole Signs</span>
        </div>
      </a>`;
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

window.confirmDelete = async function (id, name) {
  if (!confirm(`Delete "${name}"? This removes all logos and designs.`)) return;
  try {
    await deleteProject(id);
    renderProjects();
  } catch (err) {
    console.error(err);
    alert('Could not delete project.');
  }
};

renderProjects();
