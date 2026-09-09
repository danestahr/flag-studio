import './order.css';
import './icons.js';
import { COLORS, FLAGS } from './data.js';
import { createProject, uploadLogo, uploadFlagPreview, supabase, sendOrderConfirmation, syncEventInfo, getSession, getMyProfile } from './supabase.js';
import { loadAllFlags } from './svgLoader.js';
import { applyColors, showGsTagVariant, resolveColors } from './render.js';
import { isDisplayableImage, fileTypeLabel } from './media-utils.js';
import { extractDominantColors } from './color-extract.js';
import { scrollToFirstError } from './dom-utils.js';

const SKIP_VALIDATION = false;

// Border color has its own toggle (match secondary/primary vs. an independent
// color) built and working, but it's hidden from customers for now — flip
// back to true to bring it back. While off, the border always resolves to
// the secondary color (see renderZoneColorSection and loadDraft).
const SHOW_BORDER_COLOR_TOGGLE = false;

// ── US States ──────────────────────────────────────────────
const US_STATES = [
  {code:'AL',name:'Alabama'},{code:'AK',name:'Alaska'},{code:'AZ',name:'Arizona'},
  {code:'AR',name:'Arkansas'},{code:'CA',name:'California'},{code:'CO',name:'Colorado'},
  {code:'CT',name:'Connecticut'},{code:'DE',name:'Delaware'},{code:'FL',name:'Florida'},
  {code:'GA',name:'Georgia'},{code:'HI',name:'Hawaii'},{code:'ID',name:'Idaho'},
  {code:'IL',name:'Illinois'},{code:'IN',name:'Indiana'},{code:'IA',name:'Iowa'},
  {code:'KS',name:'Kansas'},{code:'KY',name:'Kentucky'},{code:'LA',name:'Louisiana'},
  {code:'ME',name:'Maine'},{code:'MD',name:'Maryland'},{code:'MA',name:'Massachusetts'},
  {code:'MI',name:'Michigan'},{code:'MN',name:'Minnesota'},{code:'MS',name:'Mississippi'},
  {code:'MO',name:'Missouri'},{code:'MT',name:'Montana'},{code:'NE',name:'Nebraska'},
  {code:'NV',name:'Nevada'},{code:'NH',name:'New Hampshire'},{code:'NJ',name:'New Jersey'},
  {code:'NM',name:'New Mexico'},{code:'NY',name:'New York'},{code:'NC',name:'North Carolina'},
  {code:'ND',name:'North Dakota'},{code:'OH',name:'Ohio'},{code:'OK',name:'Oklahoma'},
  {code:'OR',name:'Oregon'},{code:'PA',name:'Pennsylvania'},{code:'RI',name:'Rhode Island'},
  {code:'SC',name:'South Carolina'},{code:'SD',name:'South Dakota'},{code:'TN',name:'Tennessee'},
  {code:'TX',name:'Texas'},{code:'UT',name:'Utah'},{code:'VT',name:'Vermont'},
  {code:'VA',name:'Virginia'},{code:'WA',name:'Washington'},{code:'WV',name:'West Virginia'},
  {code:'WI',name:'Wisconsin'},{code:'WY',name:'Wyoming'},{code:'DC',name:'Washington, D.C.'},
];

const CA_PROVINCES = [
  {code:'AB',name:'Alberta'},{code:'BC',name:'British Columbia'},{code:'MB',name:'Manitoba'},
  {code:'NB',name:'New Brunswick'},{code:'NL',name:'Newfoundland and Labrador'},
  {code:'NS',name:'Nova Scotia'},{code:'NT',name:'Northwest Territories'},
  {code:'NU',name:'Nunavut'},{code:'ON',name:'Ontario'},{code:'PE',name:'Prince Edward Island'},
  {code:'QC',name:'Quebec'},{code:'SK',name:'Saskatchewan'},{code:'YT',name:'Yukon'},
];

// ── State ──────────────────────────────────────────────────
const O = {
  // Sync-from-GolfStatus pre-step, shown before Step 1 — see renderSyncScreen().
  // Skipping (or a successful/failed sync) sets this false and never shows it again.
  syncStep: true,
  syncUrl: '', syncing: false, syncError: '',
  syncedDominantColors: [],    // up to 4 hex candidates extracted from the synced logo, most-frequent first
  syncedColorApplied: false,   // guards against re-applying once the customer has picked a style
  step: 1,
  // Step 1
  eventName: '',courseName: '', eventDate: '',
  // Step 2
  contactName: '', contactEmail: '',
  attn: null,   // null = default to contactName; '' = explicitly cleared
  country: 'US',
  addressLine1: '', addressLine2: '',
  city: '', stateProvince: '', postalCode: '',
  // Step 3
  flagStyle: '',
  flagStyleOpen: false,
  colorPickerOpen: {},    // { [zoneId]: bool } — a zone with a color already
                          // picked collapses into a tile; this reopens it
  // { [zoneId]: { hex, name } | null } — same shape as the template design
  // page's zone color map. A zone key absent from this object (border)
  // means "match" mode. Defaults to White/Black before any sync; a synced
  // logo overwrites zone-secondary with its top extracted color (see
  // applySyncedInfo) — primary stays White either way.
  flagColors: {
    'zone-primary': { hex: '#FFFFFF', name: 'White' },
    'zone-secondary': { hex: '#111110', name: 'Black' },
  },
  gsTag: true,
  gsTagMode: 'auto',      // 'auto' | 'dark' | 'light' — same as the design page
  flagSetup: 'same',
  flagQty: 9,
  flagQtyCustom: false,
  designNotes: '',
  // Only shown/required when flagSetup === 'different' — a single shared
  // designNotes can't describe two distinct designs (see renderStep3/validate).
  frontDesignNotes: '',
  backDesignNotes: '',
  // Step 4
  logoFiles: [],   // { file, previewUrl, logoRecord } — logoRecord is null until
                   // this specific file has been successfully uploaded via
                   // uploadLogo(); used to make retrying orderSubmit() idempotent.
  // Step 5
  ackDeadline: false,
  // Submit state
  submitting: false,
  submitted: false,
  // Set if sendOrderConfirmation fails after a successful submit — the order
  // itself is already saved at that point, so this only controls whether
  // renderConfirmation() shows a "didn't get the email" note; it must never
  // be swallowed silently (see the .catch() below).
  confirmationEmailFailed: false,
  projectId: null,
  returnToReview: false,
  errors: {},
};

// ── Draft persistence ────────────────────────────────────────
// This form is anonymous (no project exists until submit) and can run long —
// autosave the plain-data fields to localStorage on every render so a refresh
// or accidental tab close doesn't lose progress. Deliberately excludes
// O.logoFiles (File objects aren't JSON-serializable and are too large for
// localStorage anyway) — those are persisted separately via IndexedDB, see
// "Logo file persistence" below. Also excludes transient/submission state
// (syncing, submitting, projectId, errors) so a resumed draft always starts
// from a clean Step render rather than replaying an in-flight sync or submit
// attempt.
const DRAFT_KEY = 'flagstudio.orderDraft.v1';
const DRAFT_FIELDS = [
  'step', 'syncUrl', 'eventName', 'courseName', 'eventDate',
  'contactName', 'contactEmail', 'attn', 'country',
  'addressLine1', 'addressLine2', 'city', 'stateProvince', 'postalCode',
  'flagStyle', 'flagColors', 'gsTag', 'gsTagMode', 'flagSetup', 'flagQty', 'flagQtyCustom', 'designNotes',
  'frontDesignNotes', 'backDesignNotes',
  'ackDeadline',
  'syncedDominantColors', 'syncedColorApplied',
];

function saveDraft() {
  try {
    const data = {};
    DRAFT_FIELDS.forEach(k => { data[k] = O[k]; });
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
  } catch (err) { console.warn('Could not save order draft', err); }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    DRAFT_FIELDS.forEach(k => { if (k in data) O[k] = data[k]; });
    // A restored draft has already been through (or skipped) the sync
    // pre-step — never show it again once there's progress to resume.
    O.syncStep = false;
    // Border color toggle is hidden right now (see SHOW_BORDER_COLOR_TOGGLE)
    // — drop any independent border color a draft saved before it was
    // hidden, so border always resolves back to matching the secondary color.
    if (!SHOW_BORDER_COLOR_TOGGLE) delete O.flagColors['zone-border'];
  } catch (err) { console.warn('Could not load order draft', err); }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clean up */ }
}

// ── Logo file persistence (IndexedDB) ─────────────────────────
// File objects can't live in localStorage (not JSON-serializable, and even
// base64-encoded would blow the quota for anything but a tiny logo) —
// IndexedDB stores Blobs natively and has a far larger quota, so a refresh
// restores the actual uploaded files instead of just leaving the customer to
// re-add them. The whole O.logoFiles array is stored under one fixed key so
// it's always swapped in/out atomically.
const LOGO_DB_NAME = 'flagstudio-order-drafts';
const LOGO_STORE = 'logoFiles';
const LOGO_DRAFT_KEY = 'draft';

function openLogoDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(LOGO_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(LOGO_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function saveLogoFilesToDb() {
  try {
    const db = await openLogoDb();
    const records = O.logoFiles.map(lf => ({ name: lf.file.name, type: lf.file.type, blob: lf.file }));
    const tx = db.transaction(LOGO_STORE, 'readwrite');
    tx.objectStore(LOGO_STORE).put(records, LOGO_DRAFT_KEY);
    await txDone(tx);
    db.close();
  } catch (err) { console.warn('Could not save logo files draft', err); }
}

async function loadLogoFilesFromDb() {
  try {
    const db = await openLogoDb();
    const tx = db.transaction(LOGO_STORE, 'readonly');
    const getReq = tx.objectStore(LOGO_STORE).get(LOGO_DRAFT_KEY);
    const records = await new Promise((resolve, reject) => {
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(getReq.error);
    });
    db.close();
    if (!records || !records.length) return;
    records.forEach(r => {
      const file = new File([r.blob], r.name, { type: r.type });
      const entry = { file, previewUrl: isDisplayableImage(file.name) ? URL.createObjectURL(file) : null, logoRecord: null };
      O.logoFiles.push(entry);
      if (!entry.previewUrl) resolvePdfPreview(entry);
    });
  } catch (err) { console.warn('Could not load logo files draft', err); }
}

async function clearLogoFilesDb() {
  try {
    const db = await openLogoDb();
    const tx = db.transaction(LOGO_STORE, 'readwrite');
    tx.objectStore(LOGO_STORE).delete(LOGO_DRAFT_KEY);
    await txDone(tx);
    db.close();
  } catch (err) { console.warn('Could not clear logo files draft', err); }
}

// ── Helpers ────────────────────────────────────────────────
function formatDate(isoDate) {
  if (!isoDate) return '';
  const [year, month, day] = isoDate.split('-').map(Number);
  const months = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return months[month - 1] + ' ' + day + ', ' + year;
}

function calcApprovalDeadline(eventDateIso) {
  if (!eventDateIso) return null;
  const [y, m, d] = eventDateIso.split('-').map(Number);
  const deadline = new Date(y, m - 1, d);
  deadline.setDate(deadline.getDate() - 17);
  const dow = deadline.getDay();
  if (dow === 6) deadline.setDate(deadline.getDate() - 1);
  else if (dow === 0) deadline.setDate(deadline.getDate() - 2);
  else if (dow === 1) deadline.setDate(deadline.getDate() - 3);
  const iso = deadline.toISOString().slice(0, 10);
  return { iso, display: formatDate(iso) };
}

function req() {
  return '<span class="required-mark">*</span>';
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Validation ─────────────────────────────────────────────
function validate(step) {
  if (SKIP_VALIDATION) return {};
  const errors = {};
  if (step === 1) {
    if (!O.eventName.trim()) errors.eventName = 'Event name is required.';
    if (!O.courseName.trim()) errors.courseName = 'Course name is required.';
    if (!O.eventDate) errors.eventDate = 'Event date is required.';
  }
  if (step === 2) {
    if (!O.contactName.trim()) errors.contactName = 'Full name is required.';
    if (!O.contactEmail.trim()) errors.contactEmail = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(O.contactEmail)) errors.contactEmail = 'Enter a valid email address.';
    if (!O.addressLine1.trim()) errors.addressLine1 = 'Address is required.';
    if (!O.city.trim()) errors.city = 'City is required.';
    if (!O.stateProvince) errors.stateProvince = (O.country === 'CA' ? 'Province' : 'State') + ' is required.';
    if (!O.postalCode.trim()) errors.postalCode = (O.country === 'CA' ? 'Postal code' : 'ZIP code') + ' is required.';
  }
  if (step === 3) {
    if (!O.flagStyle) errors.flagStyle = 'Please select a flag style.';
    if (O.flagQtyCustom) {
      if (!O.flagQty || O.flagQty < 10) errors.flagQty = 'Custom quantity must be at least 10.';
    } else if (!O.flagQty) {
      errors.flagQty = 'Please select a quantity.';
    }
    if (O.flagSetup === 'different') {
      if (!O.frontDesignNotes.trim()) errors.frontDesignNotes = 'Front design notes are required.';
      if (!O.backDesignNotes.trim()) errors.backDesignNotes = 'Back design notes are required.';
    } else if (!O.designNotes.trim()) {
      errors.designNotes = 'Flag design is required.';
    }
  }
  if (step === 4) {
    if (!O.logoFiles.length) errors.logoFiles = 'At least one logo is required.';
  }
  if (step === 5) {
    if (!O.ackDeadline) errors.ackDeadline = 'Please acknowledge the deadline policy.';
  }
  return errors;
}

// ── Render ─────────────────────────────────────────────────
// Title/description for each numbered step's order-title/order-sub — rendered
// above the order-card (not inside it) so every step's header lines up the
// same way as the sync pre-step's.
const STEP_HEADERS = {
  1: { title: 'Event Details', sub: "We'll use this to name your project and schedule your proof." },
  2: { title: 'Contact & Shipping', sub: "We'll use this to know where to ship your flags." },
  3: { title: 'Flag & Colors', sub: "We'll use this to understand your vision for the flags." },
  4: { title: 'Logo Upload', sub: "We'll use your logos to bring the design to life." },
  5: { title: 'Review & Submit', sub: "We'll use this to lock in your order — double-check everything below before you submit." },
};

function renderStepHeader(title, sub, actionHtml = '') {
  return `<div class="order-header-row">
    <div class="order-header-text">
      <div class="order-title">${esc(title)}</div>
      <div class="order-sub">${esc(sub)}</div>
    </div>
    ${actionHtml}
  </div>`;
}

// Lets the customer jump back to the sync pre-step from Step 1 to pull fresh
// event details (e.g. the course website changed after their first sync).
// O.syncUrl is left as-is from the last sync, so the URL field comes back
// pre-filled instead of empty.
function renderResyncButton() {
  return `<button type="button" class="btn icon" onclick="window.resyncEvent()" title="Re-sync from GolfStatus" aria-label="Re-sync from GolfStatus"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i></button>`;
}

function renderProgressDots() {
  const stepNums = [1, 2, 3, 4, 5];
  return stepNums.map((n) => {
    const label = STEP_HEADERS[n].title;
    // Step 4 (Logos) can't rely on n < O.step alone: a reload restores
    // O.logoFiles from IndexedDB (see loadLogoFilesFromDb), but that restore
    // can fail (private browsing, quota, disabled storage), leaving a draft
    // resumed past this step with O.logoFiles empty even though O.step says
    // it's done. Only show the checkmark if a logo is actually present right
    // now.
    const done = !O.syncStep && n < O.step && (n !== 4 || O.logoFiles.length > 0);
    const active = !O.syncStep && n === O.step;
    const cls = done ? 'op-step done' : active ? 'op-step active' : 'op-step';
    const lineCls = done ? 'op-line done' : 'op-line';
    const dot = done ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : String(n);
    const line = n < stepNums.length ? `<div class="${lineCls}"></div>` : '';
    const click = done ? ` onclick="window.editStep(${n})" style="cursor:pointer"` : '';
    return `<div class="${cls}"${click}><div class="op-dot">${dot}</div><div class="op-label">${label}</div></div>${line}`;
  }).join('');
}

function render() {
  const app = document.getElementById('orderApp');
  if (!app) return;

  if (O.syncStep) {
    app.innerHTML = `
      <div class="order-wrap">
        <div class="order-progress">${renderProgressDots()}</div>
        ${!O.syncing ? renderStepHeader('Event Details', 'Jump start your designs by syncing your event website') : ''}
        ${renderSyncScreen()}
        ${!O.syncing ? `<p class="sync-skip-link"><a href="#" id="skipSyncLink">Fill Out Form Manually</a></p>` : ''}
      </div>`;
    attachSyncListeners();
    return;
  }

  if (O.submitted) {
    app.innerHTML = renderConfirmation();
    const resetBtn = document.getElementById('devResetBtn');
    if (resetBtn) resetBtn.style.display = 'none';
    return;
  }

  const progressDots = renderProgressDots();
  const header = STEP_HEADERS[O.step];

  let stepHtml = '';
  if (O.step === 1) stepHtml = renderStep1();
  else if (O.step === 2) stepHtml = renderStep2();
  else if (O.step === 3) stepHtml = renderStep3();
  else if (O.step === 4) stepHtml = renderStep4();
  else if (O.step === 5) stepHtml = renderStep5();

  app.innerHTML = `
    <div class="order-wrap">
      <div class="order-progress">${progressDots}</div>
      ${renderStepHeader(header.title, header.sub, O.step === 1 ? renderResyncButton() : '')}
      <div class="order-card">
        ${stepHtml}
        ${renderNav()}
      </div>
    </div>`;

  attachListeners();
  saveDraft();
}

function renderNav() {
  let nextBtn;
  if (O.step === 5) {
    // Logos are normally restored from IndexedDB on reload (see
    // loadLogoFilesFromDb), but that restore can fail (private browsing,
    // quota, disabled storage), leaving a draft resumed on Review with
    // O.logoFiles empty. Disable Submit rather than letting the customer
    // send an order with no logo attached; renderStep5's Logos section is
    // what points them back to Step 4 to fix it.
    nextBtn = O.submitting
      ? `<button class="btn primary" disabled style="flex:1;justify-content:center">Submitting…</button>`
      : !O.logoFiles.length
      ? `<button class="btn primary" disabled title="Re-add your logos before submitting" style="flex:1;justify-content:center">Submit Order</button>`
      : `<button class="btn primary" onclick="window.orderSubmit()" style="flex:1;justify-content:center">Submit Order</button>`;
  } else if (O.returnToReview) {
    nextBtn = `<button class="btn primary" onclick="window.orderNext()" style="flex:1;justify-content:center">Save</button>`;
  } else {
    nextBtn = `<button class="btn primary" onclick="window.orderNext()">Next <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`;
  }
  return `<div class="order-nav">
    ${O.step > 1 ? `<button class="btn" onclick="window.orderBack()"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back</button>` : ''}
    ${nextBtn}
  </div>`;
}

// ── Sync from GolfStatus ─────────────────────────────────────
// Shown once, before Step 1. Anonymous like the rest of this flow — no
// project exists yet, so nothing is persisted here; a synced logo is staged
// into O.logoFiles exactly like a manual drop (see addLogoFiles), and the
// dominant-color suggestion is applied to the color pickers right away (see
// applySyncedInfo) since Step 3 now shows colors before the flag style
// picker — there's no later "style picked" moment to hang it off of.
function renderSyncScreen() {
  if (O.syncing) {
    return `
      <div class="order-card" style="text-align:center">
        <div class="order-title">Sync Event</div>
        <div class="sync-spinner" aria-hidden="true"></div>
        <p class="sync-step-note" style="text-align:center">Pulling your event name, date, course, and logo from GolfStatus — this only takes a moment.</p>
      </div>`;
  }
  return `
    <div class="order-card">
      <div class="form-field">
        <label class="form-label" for="f-syncUrl">GolfStatus Event URL${req()}</label>
        <input class="form-input" id="f-syncUrl" type="url" value="${esc(O.syncUrl)}" placeholder="https://events.golfstatus.com/..." autocomplete="off">
        ${O.syncError ? `<div class="form-error">${esc(O.syncError)}</div>` : ''}
      </div>
      <button type="button" class="btn primary" id="syncBtn" style="width:100%;justify-content:center">Continue</button>
    </div>`;
}

function attachSyncListeners() {
  const input = document.getElementById('f-syncUrl');
  if (input) {
    input.addEventListener('input', e => { O.syncUrl = e.target.value; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); handleSync(); } });
  }
  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) syncBtn.addEventListener('click', handleSync);
  const skipLink = document.getElementById('skipSyncLink');
  if (skipLink) skipLink.addEventListener('click', e => { e.preventDefault(); O.syncStep = false; render(); });
}

async function handleSync() {
  if (!O.syncUrl.trim()) { O.syncError = 'Paste your GolfStatus event URL first.'; render(); return; }
  O.syncError = '';
  O.syncing = true;
  render();
  try {
    const result = await syncEventInfo(O.syncUrl.trim());
    await applySyncedInfo(result);
    O.syncStep = false;
    // A successful sync already fills in Step 1 (event name/date), so skip
    // straight to Step 2 — unless the sync left a required field blank, in
    // which case stay on Step 1 so the customer can fill in the gap.
    const step1Errors = validate(1);
    if (Object.keys(step1Errors).length) {
      O.errors = step1Errors;
      O.step = 1;
    } else {
      O.step = 2;
    }
    render();
  } catch (err) {
    console.error('Event sync failed', err);
    O.syncing = false;
    O.syncError = err.message || "We couldn't sync that event. Check the URL and try again.";
    render();
  }
}

// Populates Step 1 fields directly from the sync result. Deliberately does
// NOT prefill the shipping address from the course's address — sales team
// feedback was that the course address is frequently not where the flags
// should actually ship, so the customer must always enter shipping by hand.
async function applySyncedInfo(result) {
  O.eventName = result.eventName || '';
  O.courseName = result.courseName || '';
  O.eventDate = result.eventDate || '';

  // Never throws — a failed logo/color step shouldn't block the rest of the
  // synced info the customer already got.
  if (result.logoBase64) {
    try {
      const contentType = result.logoContentType || 'image/png';
      const dataUrl = `data:${contentType};base64,${result.logoBase64}`;
      const bytes = Uint8Array.from(atob(result.logoBase64), c => c.charCodeAt(0));
      const ext = contentType.split('/')[1]?.split('+')[0] || 'png';
      const file = new File([bytes], `tournament-logo.${ext}`, { type: contentType });
      O.logoFiles.push({ file, previewUrl: URL.createObjectURL(file), logoRecord: null });
      O.syncedDominantColors = await extractDominantColors(dataUrl, 4).catch(() => []);
      // Default primary/secondary to the same white + top-logo-color pair the
      // old flag-style-triggered version used, just applied immediately since
      // Step 3 shows colors before a style is picked now. Guarded the same
      // way — once, so it never stomps a color the customer changes by hand.
      if (O.syncedDominantColors.length && !O.syncedColorApplied) {
        O.flagColors['zone-primary'] = { hex: '#FFFFFF', name: 'White' };
        O.flagColors['zone-secondary'] = { hex: O.syncedDominantColors[0], name: 'Logo color' };
        O.syncedColorApplied = true;
      }
    } catch (err) {
      console.error('Failed to attach synced logo', err);
    }
  }
}

function renderStep1() {
  const e = O.errors;
  return `
    <div class="form-field">
      <label class="form-label" for="f-eventName">Event Name${req()}</label>
      <input class="form-input" id="f-eventName" type="text" value="${esc(O.eventName)}" placeholder="e.g. Augusta Club Championship 2026" autocomplete="off">
      ${e.eventName ? `<div class="form-error">${esc(e.eventName)}</div>` : ''}
    </div>
     <div class="form-field">
      <label class="form-label" for="f-courseName">Course Name${req()}</label>
      <input class="form-input" id="f-courseName" type="text" value="${esc(O.courseName)}" placeholder="e.g. Augusta National Golf Club" autocomplete="off">
      ${e.courseName ? `<div class="form-error">${esc(e.courseName)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-eventDate">Event Date${req()}</label>
      <input class="form-input" id="f-eventDate" type="date" value="${esc(O.eventDate)}">
      ${e.eventDate ? `<div class="form-error">${esc(e.eventDate)}</div>` : ''}
    </div>`;
}

function renderStep2() {
  const e = O.errors;
  const regions = O.country === 'CA' ? CA_PROVINCES : US_STATES;
  const stateLabel = O.country === 'CA' ? 'Province' : 'State';
  const postalLabel = O.country === 'CA' ? 'Postal Code' : 'ZIP Code';
  const postalPlaceholder = O.country === 'CA' ? 'A1A 1A1' : '12345';
  return `
    <div class="form-field">
      <label class="form-label" for="f-contactName">Full Name${req()}</label>
      <input class="form-input" id="f-contactName" type="text" value="${esc(O.contactName)}" autocomplete="name">
      ${e.contactName ? `<div class="form-error">${esc(e.contactName)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-contactEmail">Email${req()}</label>
      <input class="form-input" id="f-contactEmail" type="email" value="${esc(O.contactEmail)}" autocomplete="email">
      ${e.contactEmail ? `<div class="form-error">${esc(e.contactEmail)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label">Shipping Address</label>
      <div class="country-toggle">
        <button class="country-btn${O.country === 'US' ? ' active' : ''}" onclick="window.selectCountry('US')">🇺🇸 United States</button>
        <button class="country-btn${O.country === 'CA' ? ' active' : ''}" onclick="window.selectCountry('CA')">🇨🇦 Canada</button>
      </div>
    </div>
    <div class="form-field">
      <label class="form-label" for="f-attn">ATTN <span style="font-weight:400;color:var(--gray-400)">(Optional)</span></label>
      <input class="form-input" id="f-attn" type="text" value="${esc(O.attn !== null ? O.attn : O.eventName)}" placeholder="Recipient name" autocomplete="off">
    </div>
    <div class="form-field">
      <label class="form-label" for="f-addr1">Address Line 1${req()}</label>
      <input class="form-input" id="f-addr1" type="text" value="${esc(O.addressLine1)}" placeholder="Street address" autocomplete="address-line1">
      ${e.addressLine1 ? `<div class="form-error">${esc(e.addressLine1)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-addr2">Address Line 2 <span style="font-weight:400;color:var(--gray-400)">(Optional)</span></label>
      <input class="form-input" id="f-addr2" type="text" value="${esc(O.addressLine2)}" placeholder="Apt, suite, unit, etc." autocomplete="address-line2">
    </div>
    <div class="form-row">
      <div class="form-field">
        <label class="form-label" for="f-city">City${req()}</label>
        <input class="form-input" id="f-city" type="text" value="${esc(O.city)}" autocomplete="address-level2">
        ${e.city ? `<div class="form-error">${esc(e.city)}</div>` : ''}
      </div>
      <div class="form-field">
        <label class="form-label" for="f-state">${stateLabel}${req()}</label>
        <select class="form-input" id="f-state">
          <option value="">Select…</option>
          ${regions.map(r => `<option value="${r.code}"${O.stateProvince === r.code ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
        ${e.stateProvince ? `<div class="form-error">${esc(e.stateProvince)}</div>` : ''}
      </div>
      <div class="form-field" style="max-width:80px;flex:0 0 80px">
        <label class="form-label" for="f-postal">${postalLabel}${req()}</label>
        <input class="form-input" id="f-postal" type="text" value="${esc(O.postalCode)}" placeholder="${postalPlaceholder}" autocomplete="postal-code">
        ${e.postalCode ? `<div class="form-error">${esc(e.postalCode)}</div>` : ''}
      </div>
    </div>`;
}

function renderStep3() {
  const e = O.errors;
  const flag = FLAGS.find(f => f.id === O.flagStyle);
  return `
    ${renderZoneColorSection(flag)}

    <div class="form-field">
      <label class="form-label">Flag${req()}</label>
      ${renderFlagStylePicker()}
      ${e.flagStyle ? `<div class="form-error">${esc(e.flagStyle)}</div>` : ''}
    </div>

    <div class="form-field">
      <label class="form-label">Quantity${req()}</label>
      <div class="qty-toggle">
        <div class="qty-num-group">
          ${[9, 18, 27, 36].map(n => `
            <button class="qty-btn${!O.flagQtyCustom && O.flagQty === n ? ' active' : ''}" onclick="window.selectQty(${n})">${n}</button>`).join('')}
        </div>
        <button class="qty-btn${O.flagQtyCustom ? ' active' : ''}" onclick="window.selectQtyCustom()">Custom</button>
      </div>
      ${O.flagQtyCustom ? `
        <div class="form-field qty-custom-field">
          <label class="form-label" for="f-qty">Custom Quantity${req()}</label>
          <input class="form-input" type="number" min="10" step="1" id="f-qty" value="${O.flagQty}" required
            placeholder="Minimum 10" oninput="window.setQtyValue(this.value)">
        </div>` : ''}
      ${e.flagQty ? `<div class="form-error">${esc(e.flagQty)}</div>` : ''}
    </div>

    <div class="form-field">
      <label class="form-label">Flag setup${req()}</label>
      <div class="setup-toggle">
        <button class="setup-btn${O.flagSetup === 'same' ? ' active' : ''}" onclick="window.selectSetup('same')">Same front &amp; back</button>
        <button class="setup-btn${O.flagSetup === 'different' ? ' active' : ''}" onclick="window.selectSetup('different')">Different front &amp; back</button>
      </div>
    </div>

    ${O.flagSetup === 'same' ? `
    <div class="form-field">
      <label class="form-label" for="f-notes">Flag Design${req()}</label>
      <textarea class="form-input" id="f-notes" placeholder="Describe the design of the flag, including any requests or references…">${esc(O.designNotes)}</textarea>
      ${e.designNotes ? `<div class="form-error">${esc(e.designNotes)}</div>` : ''}
    </div>` : `
    <div class="form-field">
      <label class="form-label" for="f-frontNotes">Flag Design - Front${req()}</label>
      <textarea class="form-input" id="f-frontNotes" placeholder="Describe the design of the front of the flag, including any requests or references…">${esc(O.frontDesignNotes)}</textarea>
      ${e.frontDesignNotes ? `<div class="form-error">${esc(e.frontDesignNotes)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-backNotes">Flag Design - Back${req()}</label>
      <textarea class="form-input" id="f-backNotes" placeholder="Describe the design of the back of the flag, including any requests or references…">${esc(O.backDesignNotes)}</textarea>
      ${e.backDesignNotes ? `<div class="form-error">${esc(e.backDesignNotes)}</div>` : ''}
    </div>`}`;
}

function renderStep4() {
  const e = O.errors;
  const previews = O.logoFiles.map((lf, i) => `
    <div class="logo-preview-item">
      ${lf.previewUrl
        ? `<img src="${lf.previewUrl}" alt="Logo ${i + 1}">`
        : `<div class="file-type-badge">${fileTypeLabel(lf.file.name)}</div>`}
      <button class="logo-preview-remove" onclick="window.removeLogoFile(${i})" title="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    </div>`).join('');

  return `
    <div class="form-field">
      <label class="form-label">Logos${req()}</label>
      <div class="logo-dropzone" id="logoDropzone">
        <div class="logo-dropzone-icon"><i class="fa-solid fa-upload" aria-hidden="true"></i></div>
        <div class="logo-dropzone-text">Drop logos here or click to upload</div>
        <div class="logo-dropzone-sub">SVG, PNG, PDF, AI, EPS</div>
      </div>
      <input type="file" id="logoFileInput" accept=".svg,.png,.pdf,.ai,.eps,image/*" multiple style="display:none">
      ${e.logoFiles ? `<div class="form-error">${esc(e.logoFiles)}</div>` : ''}
      ${O.logoFiles.length ? `<div class="logo-preview-grid">${previews}</div>` : ''}
    </div>`;
}

function renderStep5() {
  const e = O.errors;
  const ack1Cls = 'ack-item' + (O.ackDeadline ? ' checked' : '') + (e.ackDeadline ? ' error' : '');
  const ack1CheckCls = 'ack-check' + (O.ackDeadline ? ' checked' : '');

  function colorChip(c) {
    if (!c) return '<span style="color:var(--gray-400)">—</span>';
    return `<span style="display:inline-flex;align-items:center;gap:5px"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${c.hex};border:1px solid var(--gray-200);flex-shrink:0"></span>${esc(c.name)}</span>`;
  }

  const effectiveAttn = O.attn !== null ? O.attn : O.eventName;
  const addrParts = [
    effectiveAttn ? 'ATTN: ' + effectiveAttn : null,
    O.addressLine1, O.addressLine2,
    [O.city, O.stateProvince, O.postalCode].filter(Boolean).join(', '),
    O.country === 'CA' ? 'Canada' : 'USA',
  ].filter(Boolean);

  const setupLabel = O.flagSetup === 'different' ? 'Different Front & Back' : 'Same Front & Back';
  const selectedFlag = FLAGS.find(f => f.id === O.flagStyle);
  const styleLabel = selectedFlag ? selectedFlag.name : (O.flagStyle || null);
  const flagPreviewHtml = selectedFlag ? buildFlagSvgHtml(selectedFlag) : '';
  // Border isn't user-configurable right now (SHOW_BORDER_COLOR_TOGGLE is off
  // on Step 3 - it always just matches secondary/primary), so it has nothing
  // to review here either.
  const colorZones = (selectedFlag?.colorZones || []).filter(z => z.id !== 'zone-border');

  return `
    ${e.submit ? `<div class="submit-error-banner">${esc(e.submit)}</div>` : ''}
    ${(() => {
      const dl = calcApprovalDeadline(O.eventDate);
      if (!dl) return '';
      return `<div class="deadline-callout">
        <div class="deadline-callout-label">Your artwork approval deadline</div>
        <div class="deadline-callout-date">${esc(dl.display)}</div>
        <div class="deadline-callout-note">17 days before your event — adjusted to the preceding Friday if needed.</div>
      </div>`;
    })()}
    <div class="${ack1Cls}" id="f-ackDeadline" onclick="window.toggleAck('deadline')">
      <div class="${ack1CheckCls}"></div>
      <div class="ack-text">I acknowledge that final artwork approval is required at least 17 days before the event to avoid rush fees. If the event is on a weekend or Monday, this deadline will be moved to the preceding Friday.</div>
    </div>
    ${e.ackDeadline ? `<div class="form-error">${esc(e.ackDeadline)}</div>` : ''}

    <div class="rs-divider"></div>

    <div class="rs-section">
      <div class="rs-section-header">
        <div class="rs-section-title">Event Details</div>
        <button class="rs-edit-btn" onclick="window.editStep(1)">Edit</button>
      </div>
      <div class="rs-rows">
        <div class="rs-row"><span class="rs-label">Event Name</span><span class="rs-value">${O.eventName ? esc(O.eventName) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
        <div class="rs-row"><span class="rs-label">Course Name</span><span class="rs-value">${O.courseName ? esc(O.courseName) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
        <div class="rs-row"><span class="rs-label">Event Date</span><span class="rs-value">${formatDate(O.eventDate) || '<span style="color:var(--gray-400)">—</span>'}</span></div>
        ${O.syncUrl.trim() ? `<div class="rs-row"><span class="rs-label">Event URL</span><span class="rs-value"><a href="${esc(O.syncUrl.trim())}" target="_blank" rel="noopener noreferrer">${esc(O.syncUrl.trim())}</a></span></div>` : ''}
      </div>
    </div>

    <div class="rs-section">
      <div class="rs-section-header">
        <div class="rs-section-title">Contact &amp; Shipping</div>
        <button class="rs-edit-btn" onclick="window.editStep(2)">Edit</button>
      </div>
      <div class="rs-rows">
        <div class="rs-row"><span class="rs-label">Full Name</span><span class="rs-value">${O.contactName ? esc(O.contactName) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
        <div class="rs-row"><span class="rs-label">Email</span><span class="rs-value">${O.contactEmail ? esc(O.contactEmail) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
        <div class="rs-row" style="align-items:flex-start"><span class="rs-label">Address</span><span class="rs-value">${addrParts.length ? addrParts.map(esc).join('<br>') : '<span style="color:var(--gray-400)">—</span>'}</span></div>
      </div>
    </div>

    <div class="rs-section">
      <div class="rs-section-header">
        <div class="rs-section-title">Flag &amp; Colors</div>
        <button class="rs-edit-btn" onclick="window.editStep(3)">Edit</button>
      </div>
      ${flagPreviewHtml ? `<div class="rs-flag-preview">${flagPreviewHtml}</div>` : ''}
      <div class="rs-rows">
        ${colorZones.map(z =>
          `<div class="rs-row"><span class="rs-label">${esc(z.label || z.id)}</span><span class="rs-value">${colorChip(O.flagColors[z.id])}</span></div>`
        ).join('')}
        <div class="rs-row"><span class="rs-label">Flag</span><span class="rs-value">${styleLabel ? esc(styleLabel) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
        <div class="rs-row"><span class="rs-label">Quantity</span><span class="rs-value">${O.flagQty} Flag${O.flagQty === 1 ? '' : 's'}</span></div>
        <div class="rs-row"><span class="rs-label">Flag Setup</span><span class="rs-value">${setupLabel}</span></div>
        ${O.designNotes ? `<div class="rs-row"><span class="rs-label">Flag Design</span><span class="rs-value">${esc(O.designNotes)}</span></div>` : ''}
        ${O.flagSetup === 'different' ? `<div class="rs-row"><span class="rs-label">Flag Design - Front</span><span class="rs-value">${O.frontDesignNotes ? esc(O.frontDesignNotes) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
        <div class="rs-row"><span class="rs-label">Flag Design - Back</span><span class="rs-value">${O.backDesignNotes ? esc(O.backDesignNotes) : '<span style="color:var(--gray-400)">—</span>'}</span></div>` : ''}
      </div>
    </div>

    <div class="rs-section">
      <div class="rs-section-header">
        <div class="rs-section-title">Logo Upload</div>
        <button class="rs-edit-btn" onclick="window.editStep(4)">Edit</button>
      </div>
      <div class="rs-rows">
        ${O.logoFiles.length
          ? O.logoFiles.map(lf => `<div class="rs-row"><span class="rs-label">File</span><span class="rs-value">${esc(lf.file.name)}</span></div>`).join('')
          // Reaching Review with zero logos is only possible after a page
          // reload failed to restore the logo files from IndexedDB (see
          // loadLogoFilesFromDb — private browsing, quota, disabled storage)
          // — orderNext()'s validate(4) blocks getting here any other way —
          // so say so plainly instead of implying nothing was ever added,
          // and give a direct way back to Step 4 (Submit is also disabled
          // for this same case — see renderNav).
          : `<div class="rs-row" style="flex-direction:column;align-items:flex-start;gap:10px">
              <span class="rs-value" style="color:#c0392b">Logos weren’t saved through your last visit — please re-add them before submitting.</span>
              <button type="button" class="btn sm" onclick="window.editStep(4)"><i class="fa-solid fa-upload" aria-hidden="true"></i> Re-add Logos</button>
            </div>`}
      </div>
    </div>`;
}

function renderConfirmation() {
  return `
    <div class="order-wrap">
      <div class="order-card" style="text-align:center;padding:2.5rem 2rem">
        <div class="confirm-icon"></div>
        <div class="confirm-title">We'll take it from here!</div>
        <div class="confirm-sub">You'll receive an email with a link to review the flag, once the design is complete.</div>
        <div class="confirm-detail">
          <div><strong>${esc(O.eventName)}</strong></div>
          <div>${esc(formatDate(O.eventDate))}</div>
        </div>
        ${O.confirmationEmailFailed ? `<div class="confirm-email-warning">Your order was received, but we couldn't send a confirmation email${O.contactEmail ? ' to ' + esc(O.contactEmail) : ''} just now. If you don't hear from us soon, please reach out so we can confirm it went through.</div>` : ''}
      </div>
    </div>`;
}

// ── SVG rendering — reuses the same applyColors/showGsTagVariant pipeline as
// the template design page so previews here match exactly ──────────────────
function colorsForRender() {
  const out = {};
  Object.entries(O.flagColors).forEach(([zid, v]) => { out[zid] = v?.hex || null; });
  // Defensive fallback only — applySyncedInfo already fills O.flagColors as
  // soon as a sync produces logo colors, so this normally never fires. Kept
  // in case O.flagColors is ever empty with synced colors present (e.g. the
  // customer clears both zones by hand) so template previews still get some
  // color instead of rendering uncolored.
  if (!Object.keys(out).length && O.syncedDominantColors.length) {
    out['zone-primary'] = '#FFFFFF';
    out['zone-secondary'] = O.syncedDominantColors[0];
  }
  return out;
}

// Resolves each zone to its chosen color — including the border zone's
// "match" mode, which has no entry of its own in O.flagColors — for
// submission (order_intakes.flag_colors) and the confirmation email.
function buildFlagColorEntries(flag) {
  const zones = flag?.colorZones || [
    { id: 'zone-primary', label: 'Primary Color' },
    { id: 'zone-secondary', label: 'Secondary Color' },
  ];
  return zones.map(z => {
    let c = O.flagColors[z.id];
    if (z.id === 'zone-border' && !('zone-border' in O.flagColors)) {
      c = zones.some(zz => zz.id === 'zone-secondary') ? O.flagColors['zone-secondary'] : O.flagColors['zone-primary'];
    }
    if (!c) return null;
    return { zone: z.id, label: z.label, hex: c.hex, name: c.name };
  }).filter(Boolean);
}

// Builds the colored <svg> element shared by the live preview (buildFlagSvgHtml)
// and the email rasterizer (rasterizeFlagPreviewPng) — width/height are left
// unset since the two callers need different values (see each below).
function buildFlagSvgElement(flag) {
  if (!flag?.svgContent) return null;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  // createElementNS's own outerHTML never includes this — harmless when
  // inserted live via innerHTML (the HTML parser auto-namespaces it), but
  // rasterizeFlagPreviewPng serializes this element standalone for a
  // standalone Image()/blob load, which needs the explicit declaration to
  // parse as image/svg+xml at all (same reasoning as makeSvg() in render.js).
  svg.setAttribute('xmlns', ns);
  svg.setAttribute('viewBox', flag.viewBox || '0 0 7519 4669');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.innerHTML = flag.svgContent;
  const colors = colorsForRender();
  applyColors(svg, colors, flag.noColors, flag);
  if (O.gsTag && !flag.noGsTag) {
    const keyZone = flag.tagKeyZone || 'zone-primary';
    showGsTagVariant(svg, 'front', O.gsTagMode, resolveColors(colors, flag)[keyZone]);
  }
  return svg;
}

function buildFlagSvgHtml(flag) {
  const svg = buildFlagSvgElement(flag);
  if (!svg) return '';
  // Percentage sizing is fine here — this markup is inserted live into a
  // sized parent (.rs-flag-preview / .flag-tmpl-thumb etc.), which resolves it.
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  return svg.outerHTML;
}

// Rasterizes the same preview buildFlagSvgHtml renders (template + chosen
// colors, no logo/text layers — those don't apply to the order intake flow)
// to a PNG blob, so the confirmation email can embed it as a plain <img> —
// SendGrid/most mail clients don't render inline SVG reliably.
async function rasterizeFlagPreviewPng(flag) {
  const svg = buildFlagSvgElement(flag);
  if (!svg) return null;
  const [, , vbW, vbH] = (flag.viewBox || '0 0 7519 4669').split(' ').map(Number);
  // Unlike buildFlagSvgHtml's live-DOM usage, this gets serialized and loaded
  // via a standalone Image() with no parent to resolve a percentage against
  // — needs concrete pixel dimensions instead (same reasoning as makeSvg() in
  // render.js, used by the print-export rasterizer in src/flags/gallery.js).
  svg.setAttribute('width', vbW);
  svg.setAttribute('height', vbH);
  let str = svg.outerHTML;
  if (!str.startsWith('<?xml')) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
  const blobUrl = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  const w = 900, h = Math.round(900 * vbH / vbW);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(blobUrl);
      c.toBlob(blob => blob ? resolve(blob) : reject(new Error('canvas.toBlob failed')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('SVG render failed')); };
    img.src = blobUrl;
  });
}

// ── Flag style picker ────────────────────────────────────────
function renderFlagStylePicker() {
  if (O.flagStyle && !O.flagStyleOpen) {
    const flag = FLAGS.find(f => f.id === O.flagStyle);
    const label = flag ? flag.name : O.flagStyle;
    const svgHtml = flag ? buildFlagSvgHtml(flag) : '';
    return `<div class="flag-selected-preview">
      <div class="flag-selected-thumb" onclick="window.openPicker('flagStyle')" style="cursor:pointer">${svgHtml}</div>
      <div class="flag-selected-footer">
        <span class="picker-collapsed-name">${esc(label)}</span>
        <span style="flex:1"></span>
        <button class="picker-change-btn" onclick="window.openPicker('flagStyle')">Change</button>
      </div>
    </div>`;
  }

  const cards = FLAGS.map(flag => {
    const isActive = O.flagStyle === flag.id;
    const svgHtml = buildFlagSvgHtml(flag);
    return `<div class="flag-tmpl-card${isActive ? ' active' : ''}" onclick="window.selectFlagStyle('${flag.id}')">
      <div class="flag-tmpl-thumb">${svgHtml}</div>
      <div class="flag-tmpl-name">${esc(flag.name)}</div>
    </div>`;
  }).join('');
  return `<div class="flag-tmpl-grid">${cards}</div>`;
}

// ── Color zone pickers — mirrors the template design page's per-zone color
// controls (including the border "match" toggle) instead of a fixed
// primary/secondary pair, so any flag style's full zone set is editable.
// Colors are now chosen before a flag style is picked (see renderStep3), so
// all zones render here until a style is picked; once it is, a zone the
// style doesn't define (e.g. Plain has no secondary zone) is dropped
// entirely rather than shown as a disabled placeholder ────────────────────
function renderZoneColorSection(flag) {
  if (flag?.noColors) {
    return `<div class="color-none-label" style="font-style:italic">Colors are fixed for this template</div>`;
  }
  const ZONES = [
    { id: 'zone-primary', label: 'Primary Color' },
    { id: 'zone-secondary', label: 'Secondary Color' },
    { id: 'zone-border', label: 'Border Color' },
  ];
  const usesZone = id => !flag || flag.colorZones?.some(z => z.id === id);
  const mainZones = ZONES.filter(z => z.id !== 'zone-border' && usesZone(z.id));

  const stackHtml = mainZones.map(z => `
    <div class="color-picker-col">
      <div class="form-label">${esc(z.label)}${req()}</div>
      ${renderZoneColorPicker(z.id)}
    </div>`).join('');

  // Border color toggle is hidden for now (will come back later) — border
  // always assumes the secondary color in the meantime, so never render an
  // independent "zone-border" entry into O.flagColors while this is off.
  if (!SHOW_BORDER_COLOR_TOGGLE) return stackHtml;

  const borderMatchLabel = usesZone('zone-secondary') ? 'Secondary Color' : 'Primary Color';
  return `${stackHtml}${renderBorderSection(usesZone('zone-border'), borderMatchLabel)}`;
}

function renderBorderSection(isUsed, matchLabel) {
  if (!isUsed) {
    return `<div class="form-label">Border Color</div>
      <div class="color-none-label" style="font-style:italic">Not used on this flag style</div>`;
  }
  const matches = !('zone-border' in O.flagColors);
  const body = matches ? '' : renderZoneColorPicker('zone-border');
  return `<div class="form-label">Border Color</div>
    <label class="gs-tag-label">
      <input type="checkbox" class="gs-toggle-input" ${matches ? 'checked' : ''} onchange="window.toggleBorderMatch(this.checked)">
      <span class="gs-toggle-switch"></span>
      <span class="gs-toggle-text">Use ${esc(matchLabel)}</span>
    </label>
    ${body}`;
}

// Once a zone has a color, it collapses into a compact tile (click it, or
// "Change", to reopen); an unset zone (or one being actively edited) shows
// the full circle+hex row — which mirrors the template design page's
// s2ZonePickerHtml component (src/flags/design.js), minus that component's
// "+" custom swatch since the circle+hex row already covers custom entry.
function renderZoneColorPicker(zoneId) {
  const selected = O.flagColors[zoneId];
  const isOpen = !!O.colorPickerOpen[zoneId];

  if (selected && !isOpen) {
    const isWhite = selected.hex === '#FFFFFF';
    const tileName = selected.name === 'Custom' ? selected.hex.toUpperCase() : selected.name;
    return `<div class="color-tile" onclick="window.openColorPicker('${zoneId}')">
      <span class="color-tile-swatch" style="background:${selected.hex};${isWhite ? 'border:1px solid var(--gray-200)' : ''}"></span>
      <span class="color-tile-name">${esc(tileName)}</span>
      <span style="flex:1"></span>
      <button class="picker-change-btn" onclick="event.stopPropagation();window.openColorPicker('${zoneId}')">Change</button>
    </div>`;
  }

  const hex = selected?.hex || '';
  const colorInputId = 'zc-' + zoneId;
  const hexInputId = 'zch-' + zoneId;

  // Quick-pick colors sampled straight from the synced logo — shown inline
  // with the circle+hex selector (separated by a divider) on every zone
  // picker (primary, secondary, border) so the customer can pull any zone's
  // color from their own logo instead of hunting through the preset palette.
  const logoColors = O.syncedDominantColors;
  const logoSwatchesHtml = logoColors.length ? `
    <span class="color-row-divider"></span>
    <div class="color-swatch-grid">
      ${logoColors.map((c, i) => {
        const label = `Logo Color ${i + 1}`;
        const isSel = hex.toLowerCase() === c.toLowerCase();
        return `<div class="color-swatch${isSel ? ' selected' : ''}"
          style="background:${c}" title="${esc(label)}"
          onclick="window.selectZoneColor('${zoneId}','${esc(c)}','${esc(label)}')"></div>`;
      }).join('')}
    </div>` : '';

  const swatches = COLORS.map(c => {
    const isSel = hex.toLowerCase() === c.hex.toLowerCase();
    const isWhite = c.hex === '#FFFFFF';
    return `<div class="color-swatch${isSel ? ' selected' : ''}${isWhite ? ' white-swatch' : ''}"
      style="background:${c.hex}" title="${esc(c.name)}"
      onclick="window.selectZoneColor('${zoneId}','${esc(c.hex)}','${esc(c.name)}')"></div>`;
  }).join('');

  return `<div class="color-select-row">
      <div class="color-wheel-wrap">
        <input type="color" id="${colorInputId}" value="${hex || '#2d7a4a'}"
          oninput="window.zoneColorSync('${zoneId}', this.value)" onchange="window.zoneColorApply('${zoneId}', this.value)">
        <i class="fa-solid fa-pen color-wheel-pen" aria-hidden="true"></i>
      </div>
      <input type="text" class="hexin" id="${hexInputId}" value="${esc(hex)}" maxlength="7" placeholder="#000000"
        oninput="window.zoneHexSync('${zoneId}', this.value)" onkeydown="if(event.key==='Enter')window.zoneHexApply('${zoneId}')">
      ${logoSwatchesHtml}
    </div>
    <div class="color-swatch-grid">${swatches}</div>`;
}

// ── Attach listeners ───────────────────────────────────────
function attachListeners() {
  // Step 1 inputs
  const courseName = document.getElementById('f-courseName');
  if (courseName) courseName.addEventListener('input', e => { O.courseName = e.target.value; });

  const evName = document.getElementById('f-eventName');
  if (evName) evName.addEventListener('input', e => { O.eventName = e.target.value; });

  const evDate = document.getElementById('f-eventDate');
  if (evDate) evDate.addEventListener('change', e => { O.eventDate = e.target.value; });

  // Step 2 inputs
  const cName = document.getElementById('f-contactName');
  if (cName) cName.addEventListener('input', e => { O.contactName = e.target.value; });

  const cEmail = document.getElementById('f-contactEmail');
  if (cEmail) cEmail.addEventListener('input', e => { O.contactEmail = e.target.value; });

  const attnInput = document.getElementById('f-attn');
  if (attnInput) attnInput.addEventListener('input', e => { O.attn = e.target.value; });

  const addr1 = document.getElementById('f-addr1');
  if (addr1) addr1.addEventListener('input', e => { O.addressLine1 = e.target.value; });

  const addr2 = document.getElementById('f-addr2');
  if (addr2) addr2.addEventListener('input', e => { O.addressLine2 = e.target.value; });

  const city = document.getElementById('f-city');
  if (city) city.addEventListener('input', e => { O.city = e.target.value; });

  const state = document.getElementById('f-state');
  if (state) state.addEventListener('change', e => { O.stateProvince = e.target.value; });

  const postal = document.getElementById('f-postal');
  if (postal) postal.addEventListener('input', e => { O.postalCode = e.target.value; });

  // Step 3 notes
  const notes = document.getElementById('f-notes');
  if (notes) notes.addEventListener('input', e => { O.designNotes = e.target.value; });

  const frontNotes = document.getElementById('f-frontNotes');
  if (frontNotes) frontNotes.addEventListener('input', e => { O.frontDesignNotes = e.target.value; });

  const backNotes = document.getElementById('f-backNotes');
  if (backNotes) backNotes.addEventListener('input', e => { O.backDesignNotes = e.target.value; });


  // Step 4 dropzone
  const dropzone = document.getElementById('logoDropzone');
  const fileInput = document.getElementById('logoFileInput');

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', e => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      addLogoFiles(files);
    });

    fileInput.addEventListener('change', e => {
      const files = Array.from(e.target.files);
      e.target.value = '';
      addLogoFiles(files);
    });
  }
}

function addLogoFiles(files) {
  files.forEach(file => {
    const entry = { file, previewUrl: isDisplayableImage(file.name) ? URL.createObjectURL(file) : null, logoRecord: null };
    O.logoFiles.push(entry);
    if (!entry.previewUrl) resolvePdfPreview(entry);
  });
  O.errors = {};
  render();
  saveLogoFilesToDb();
}

// PDF/AI previews render async (pdf.js parses the file); the entry starts
// with no previewUrl (falls back to the file-type badge) and upgrades to a
// thumbnail if rendering succeeds. Real EPS files, or .ai files saved
// without PDF compatibility, fail here and just keep the badge.
async function resolvePdfPreview(entry) {
  if (!/\.(pdf|ai)$/i.test(entry.file.name)) return;
  try {
    const { renderPdfPreviewUrl } = await import('./pdf-raster.js');
    entry.previewUrl = await renderPdfPreviewUrl(entry.file);
    if (O.step === 4) render();
  } catch {
    // Leave previewUrl null — badge fallback.
  }
}

// ── Window-level event handlers ────────────────────────────
window.orderNext = function () {
  const errors = validate(O.step);
  if (Object.keys(errors).length) {
    O.errors = errors;
    render();
    scrollToFirstError();
    return;
  }
  O.errors = {};
  if (O.returnToReview) {
    O.returnToReview = false;
    O.step = 5;
  } else {
    O.step += 1;
  }
  render();
  window.scrollTo(0, 0);
};

window.orderBack = function () {
  if (O.step === 1) {
    window.history.back();
    return;
  }
  O.errors = {};
  O.step -= 1;
  render();
  window.scrollTo(0, 0);
};

window.resyncEvent = function () {
  O.syncStep = true;
  O.syncError = '';
  render();
  window.scrollTo(0, 0);
};

window.orderSubmit = async function () {
  // validate(5) doesn't re-check logos — a reload normally restores
  // O.logoFiles from IndexedDB (see loadLogoFilesFromDb), but that restore
  // can fail (private browsing, quota, disabled storage), leaving a draft
  // resumed past Step 4 with O.logoFiles empty even though O.step already
  // says Step 4 is done. Without this, a customer who reloads on Review in
  // that case and doesn't notice the empty Logos section could submit an
  // order with no logo attached.
  if (!O.logoFiles.length) {
    O.errors = { logoFiles: 'Logos weren’t saved through your last visit — please re-add them.' };
    O.returnToReview = true;
    O.step = 4;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const errors = validate(5);
  if (Object.keys(errors).length) {
    O.errors = errors;
    render();
    scrollToFirstError();
    return;
  }
  O.errors = {};
  O.submitting = true;
  render();

  try {
    // Reuse the project from a previous attempt in this session instead of
    // creating a duplicate `projects` row every time "Submit Order" is retried.
    let projectId = O.projectId;
    if (!projectId) {
      projectId = await createProject(O.eventName);
      O.projectId = projectId;
    }

    // Only upload logos that haven't already succeeded in a previous attempt.
    for (const lf of O.logoFiles) {
      if (lf.logoRecord) continue;
      lf.logoRecord = await uploadLogo(projectId, lf.file);
    }

    const selectedFlagForEmail = FLAGS.find(f => f.id === O.flagStyle);
    const flagColorEntries = buildFlagColorEntries(selectedFlagForEmail);

    // Best-effort — a failed render/upload here shouldn't block the order
    // itself; the email just goes out without the preview image (same
    // reasoning as sendOrderConfirmation's own .catch() below).
    let flagPreviewUrl = '';
    try {
      if (selectedFlagForEmail) {
        const pngBlob = await rasterizeFlagPreviewPng(selectedFlagForEmail);
        if (pngBlob) flagPreviewUrl = await uploadFlagPreview(projectId, pngBlob);
      }
    } catch (err) {
      console.warn('Flag preview image generation failed', err);
    }

    const { error: intakeError } = await supabase.from('order_intakes').insert({
      project_id: projectId,
      course_name: O.courseName || null,
      event_source_url: O.syncUrl.trim() || null,
      event_name: O.eventName,
      event_date: O.eventDate,
      contact_name: O.contactName,
      contact_email: O.contactEmail,
      attn: O.attn !== null ? O.attn : O.eventName,
      address_line1: O.addressLine1,
      address_line2: O.addressLine2 || null,
      city: O.city,
      state_province: O.stateProvince,
      postal_code: O.postalCode,
      country: O.country,
      flag_style: O.flagStyle,
      // { zones: [{zone,label,hex,name}], gsTag, gsTagMode } — zone-tagged so
      // the design page can map colors back to the right zone (not just
      // positional primary/secondary), and carries the GS tag choice through.
      flag_colors: { zones: flagColorEntries, gsTag: O.gsTag, gsTagMode: O.gsTagMode },
      flag_setup: O.flagSetup,
      flag_qty: O.flagQty,
      design_notes: O.designNotes || null,
      front_design_notes: O.flagSetup === 'different' ? (O.frontDesignNotes || null) : null,
      back_design_notes: O.flagSetup === 'different' ? (O.backDesignNotes || null) : null,
      ack_deadline: O.ackDeadline,
    });
    if (intakeError) throw intakeError;

    sendOrderConfirmation({
      contactName: O.contactName,
      contactEmail: O.contactEmail,
      courseName: O.courseName || '',
      eventName: O.eventName,
      eventDate: O.eventDate,
      eventUrl: O.syncUrl.trim() || '',
      shipping: {
        attn: O.attn !== null ? O.attn : O.eventName,
        addressLine1: O.addressLine1,
        addressLine2: O.addressLine2 || '',
        city: O.city,
        stateProvince: O.stateProvince,
        postalCode: O.postalCode,
        country: O.country,
      },
      flagStyle: O.flagStyle,
      flagStyleName: selectedFlagForEmail ? selectedFlagForEmail.name : O.flagStyle,
      flagPreviewUrl,
      flagColors: flagColorEntries,
      flagSetup: O.flagSetup,
      flagQty: O.flagQty,
      designNotes: O.designNotes || '',
      frontDesignNotes: O.flagSetup === 'different' ? (O.frontDesignNotes || '') : '',
      backDesignNotes: O.flagSetup === 'different' ? (O.backDesignNotes || '') : '',
      logoFileNames: O.logoFiles.map(lf => lf.file?.name).filter(Boolean),
      projectId,
    }).catch(err => {
      // The order itself already succeeded by this point (intake row is
      // inserted) — this only means the confirmation email didn't go out.
      // Never let that fail silently: surface it on the confirmation screen
      // so the customer isn't left wondering why no email arrived.
      console.warn('Order confirmation email failed', err);
      O.confirmationEmailFailed = true;
      if (O.submitted) render();
    });

    clearDraft();
    clearLogoFilesDb();
    O.submitting = false;
    O.submitted = true;
    render();
    window.scrollTo(0, 0);
  } catch (err) {
    console.error('Order submission failed', err);
    O.submitting = false;
    O.errors = { submit: 'We couldn’t finish submitting your order. Please try again — if this keeps happening, contact us directly so we can follow up.' };
    render();
    window.scrollTo(0, 0);
  }
};

window.toggleAck = function (which) {
  if (which === 'deadline') O.ackDeadline = !O.ackDeadline;
  O.errors = {};
  render();
};

window.selectZoneColor = function (zoneId, hex, name) {
  const cur = O.flagColors[zoneId];
  O.flagColors[zoneId] = cur?.hex === hex ? null : { hex, name };
  O.colorPickerOpen[zoneId] = false;
  render();
};

window.openColorPicker = function (zoneId) {
  O.colorPickerOpen[zoneId] = true;
  render();
};

// Native color-wheel input: live-sync the paired hex field while dragging
// (no render — the wheel would otherwise repaint mid-drag), commit on change.
window.zoneColorSync = function (zoneId, hex) {
  const inp = document.getElementById('zch-' + zoneId);
  if (inp) inp.value = hex;
};

window.zoneColorApply = function (zoneId, hex) {
  O.flagColors[zoneId] = { hex, name: 'Custom' };
  O.colorPickerOpen[zoneId] = false;
  render();
};

// Hex text field: live-sync the paired color wheel as the customer types,
// commit (Enter) only once the value is a valid 6-digit hex.
window.zoneHexSync = function (zoneId, raw) {
  const hex = raw.startsWith('#') ? raw : '#' + raw;
  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    const inp = document.getElementById('zc-' + zoneId);
    if (inp) inp.value = hex;
  }
};

window.zoneHexApply = function (zoneId) {
  const inp = document.getElementById('zch-' + zoneId);
  if (!inp) return;
  const raw = inp.value;
  const hex = raw.startsWith('#') ? raw : '#' + raw;
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return;
  O.flagColors[zoneId] = { hex, name: 'Custom' };
  O.colorPickerOpen[zoneId] = false;
  render();
};

window.toggleBorderMatch = function (checked) {
  if (checked) delete O.flagColors['zone-border'];
  else O.flagColors['zone-border'] = null; // independent, unset — show the picker
  O.colorPickerOpen['zone-border'] = false;
  render();
};

window.openPicker = function (which) {
  if (which === 'flagStyle') O.flagStyleOpen = true;
  render();
};

window.editStep = function (n) {
  O.errors = {};
  if (O.step === 5) O.returnToReview = true;
  O.step = n;
  render();
  window.scrollTo(0, 0);
};

window.selectFlagStyle = function (style) {
  O.flagStyle = style;
  O.flagStyleOpen = false;
  O.errors = {};
  // Colors are picked before a style now (see renderStep3/applySyncedInfo) —
  // nothing to apply here anymore, this just records the chosen style.
  render();
};

window.selectQty = function (n) {
  O.flagQty = n;
  O.flagQtyCustom = false;
  O.errors = {};
  render();
};

window.selectQtyCustom = function () {
  O.flagQtyCustom = true;
  O.flagQty = 10;
  O.errors = {};
  render();
  // Focus the custom field for immediate entry
  requestAnimationFrame(() => document.getElementById('f-qty')?.focus());
};

window.setQtyValue = function (val) {
  const n = parseInt(val, 10);
  O.flagQty = isNaN(n) ? 0 : n;
};

window.selectSetup = function (setup) {
  O.flagSetup = setup;
  render();
};

window.selectCountry = function (country) {
  O.country = country;
  O.stateProvince = '';
  O.errors = {};
  render();
};

window.removeLogoFile = function (index) {
  const lf = O.logoFiles[index];
  if (lf?.previewUrl) URL.revokeObjectURL(lf.previewUrl);
  O.logoFiles.splice(index, 1);
  render();
  saveLogoFilesToDb();
};

// If a signed-in customer lands on this normally-anonymous form (e.g. typing
// the URL directly), seed the contact fields from their account instead of
// leaving them blank — same convention as gallery-side-panel.js's contact
// prefill. Never overwrites a value the customer has already typed.
async function prefillContactFromSession() {
  try {
    const session = await getSession();
    if (!session) return;
    if (!O.contactEmail) O.contactEmail = session.user.email || '';
    if (!O.contactName) {
      const profile = await getMyProfile(session.user.id);
      O.contactName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ');
    }
  } catch { /* contact prefill is a nicety, not required */ }
  if (O.step === 2 && !O.syncStep) render();
}

// ── Init ───────────────────────────────────────────────────
async function init() {
  loadDraft();
  await loadLogoFilesFromDb();
  render();
  prefillContactFromSession();

  // Re-render step 3 once the flag SVGs are loaded so thumbnails appear
  loadAllFlags(FLAGS).then(() => {
    if (O.step === 3) render();
  }).catch(err => console.error('Flag SVG load failed', err));
}

window.addEventListener('DOMContentLoaded', init);

// TEMP: dev-only reset button in order.html; remove both together before shipping.
window.debugResetOrderForm = async function () {
  clearDraft();
  await clearLogoFilesDb();
  window.location.reload();
};
