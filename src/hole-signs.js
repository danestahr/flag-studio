import './style.css';
import './icons.js';
import { requireAuth, isStaffOrAdmin } from './auth.js';

const session = await requireAuth();

// Hole Sign Studio entry. The editor is split into focused modules under ./hs/.
// Each module registers its own window.* inline handlers as a side effect of
// being imported, so importing them all wires up the page before init() runs.
import { UI } from './hs/state.js';
import './hs/design.js';
import './hs/banner.js';
import './hs/template-logos.js';
import './hs/variations.js';
import './hs/logo-utils.js';
import './hs/export.js';
import { init } from './hs/app.js';

UI.isStaffOrAdmin = await isStaffOrAdmin(session);

init();
