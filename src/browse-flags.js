import './landing.css';
import './order.css'; // .flag-tmpl-* classes, reused by template-gallery.js
import './icons.js';
import { getSession } from './supabase.js';
import { initHeaderForSession, injectHeaderCta } from './auth.js';
import { renderFlagGallery } from './template-gallery.js';

// Reached from the top-level "What are you looking for?" picker
// (template-gallery.js/landing.js) when Tournament Flags is chosen - its own
// page, unlike Hole Signs which has no browse step at all (see landing.js's
// onSelectType). Selecting a card here hands off to login/signup exactly
// like the old inline grid did.
const session = await getSession();
if (session) {
  await initHeaderForSession(session);
} else {
  injectHeaderCta('Sign In', '/login');
}

// Present when arriving via the split-right "Change Flag" link mid
// event-info-step (login.js/signup.js) - an in-progress draft to resume
// rather than lose once a new flag template's picked here.
const params = new URLSearchParams(window.location.search);
const resumeProject = params.get('project');

function onSelect(type, templateId) {
  const q = { type, template: templateId };
  if (resumeProject) q.project = resumeProject;
  window.location.href = `/login?${new URLSearchParams(q)}`;
}

renderFlagGallery(document.getElementById('templateGalleryRoot'), { onSelect });
