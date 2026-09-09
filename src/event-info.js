import './landing.css';
import './order.css';
import './icons.js';
import { requireAuth } from './auth.js';
import { createProject } from './supabase.js';
import { renderEventFields, validateEventFields, attachEventFieldListeners, formatDate } from './intake-shared.js';
import { scrollToFirstError } from './dom-utils.js';

await requireAuth();

const params = new URLSearchParams(window.location.search);
const type = params.get('type') === 'hole-sign' ? 'hole-sign' : 'flag';
const template = params.get('template') || '';

const state = { eventName: '', courseName: '', eventDate: '' };
let errors = {};
let submitting = false;

const app = document.getElementById('eventInfoApp');

function render() {
  app.innerHTML = `
    <div class="order-wrap">
      <div class="order-card">
        <div class="order-title">Tell us about your event</div>
        <div class="order-sub">We'll use this to name your project and schedule your proof.</div>
        ${renderEventFields(state, errors)}
        <div class="order-nav">
          <button class="btn primary" id="eventInfoContinueBtn" style="flex:1;justify-content:center"${submitting ? ' disabled' : ''}>${submitting ? 'Creating…' : 'Continue'} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        </div>
      </div>
    </div>`;
  attachEventFieldListeners(app, state);
  document.getElementById('eventInfoContinueBtn').addEventListener('click', handleContinue);
}

async function handleContinue() {
  errors = validateEventFields(state);
  if (Object.keys(errors).length) { render(); scrollToFirstError(); return; }
  errors = {};
  submitting = true;
  render();

  try {
    const projectName = state.eventName + ' — ' + formatDate(state.eventDate);
    const projectId = await createProject(projectName, {
      event_name: state.eventName,
      course_name: state.courseName || null,
      event_date: state.eventDate,
    });
    const dest = type === 'hole-sign' ? '/hole-signs' : '/flags';
    const q = new URLSearchParams({ project: projectId });
    if (template) q.set('template', template);
    window.location.href = `${dest}?${q}`;
  } catch (err) {
    console.error('Failed to create project', err);
    submitting = false;
    render();
    alert('We couldn’t start your project. Please try again.');
  }
}

render();
