import './landing.css';
import './order.css';
import './icons.js';
import { requireAuth } from './auth.js';
import { loadProject } from './supabase.js';
import { renderDeadlineCallout, formatDate } from './intake-shared.js';
import { esc } from './dom-utils.js';

await requireAuth();

const pid = new URLSearchParams(window.location.search).get('project');
if (!pid) window.location.href = '/';

const app = document.getElementById('submittedApp');

function renderConfirmation(ci) {
  const detailRows = [
    ci.event_name ? `<div style="margin-bottom:4px"><strong>${esc(ci.event_name)}</strong></div>` : '',
    ci.event_date ? `<div>${esc(formatDate(ci.event_date))}</div>` : '',
  ].join('');

  app.innerHTML = `
    <div class="order-wrap">
      <div class="order-card" style="text-align:center;padding:2.5rem 2rem">
        <div class="confirm-icon"></div>
        <div class="confirm-title">Submitted for review!</div>
        <div class="confirm-sub">Your designer will be in touch once your proof is ready for review.</div>
        ${detailRows ? `<div class="confirm-detail">${detailRows}</div>` : ''}
        ${ci.event_date ? `<div style="margin-top:1.25rem;text-align:left">${renderDeadlineCallout(ci.event_date)}</div>` : ''}
        <a class="btn primary" style="margin-top:1.5rem;justify-content:center" href="/project?project=${encodeURIComponent(pid)}">View project</a>
      </div>
    </div>`;
}

try {
  const project = await loadProject(pid);
  renderConfirmation(project.customer_info || {});
} catch (err) {
  console.error('Failed to load project', err);
  renderConfirmation({});
}
