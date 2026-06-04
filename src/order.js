import './order.css';
import { COLORS, FLAGS } from './data.js';
import { createProject, uploadLogo, supabase, sendOrderConfirmation } from './supabase.js';

// TEMP: demo mode — bypass required-field validation so the order form can
// be stepped through without filling everything in. Flip back to `false` after.
const SKIP_VALIDATION = true;

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

// ── SVG cache ──────────────────────────────────────────────
const svgCache = new Map();

async function loadSvg(name) {
  if (svgCache.has(name)) return svgCache.get(name);
  try {
    const res = await fetch('/flags/' + name + '.svg');
    const text = await res.text();
    svgCache.set(name, text);
    return text;
  } catch (_) {
    return '';
  }
}

function preloadSvgs() {
  ['Edinburgh', 'Ascot', 'Plain'].forEach(name => loadSvg(name));
}

// ── State ──────────────────────────────────────────────────
const O = {
  step: 1,
  // Step 1
  eventName: '', eventDate: '',
  // Step 2
  contactName: '', contactEmail: '',
  country: 'US',
  addressLine1: '', addressLine2: '',
  city: '', stateProvince: '', postalCode: '',
  // Step 3
  flagStyle: '',
  flagStyleOpen: false,
  flagPrimaryColor: null,    // { hex, name }
  primaryColorOpen: false,
  flagSecondaryColor: null,  // { hex, name }
  secondaryColorOpen: false,
  flagSetup: 'same',
  flagQty: 9,
  flagQtyCustom: false,
  designNotes: '',
  // Step 4
  logoFiles: [],
  // Step 5
  ackDeadline: false,
  ackPricing: false,
  // Submit state
  submitting: false,
  submitted: false,
  projectId: null,
  returnToReview: false,
  errors: {},
};

// ── Helpers ────────────────────────────────────────────────
function formatDate(isoDate) {
  if (!isoDate) return '';
  const [year, month, day] = isoDate.split('-').map(Number);
  const months = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return months[month - 1] + ' ' + day + ', ' + year;
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
    if (!O.flagQty || O.flagQty < 9) errors.flagQty = 'Quantity must be at least 9.';
  }
  if (step === 4) {
    if (!O.logoFiles.length) errors.logoFiles = 'At least one logo is required.';
  }
  if (step === 5) {
    if (!O.ackDeadline) errors.ackDeadline = 'Please acknowledge the deadline policy.';
    if (!O.ackPricing) errors.ackPricing = 'Please acknowledge the pricing policy.';
  }
  return errors;
}

// ── Render ─────────────────────────────────────────────────
function render() {
  const app = document.getElementById('orderApp');
  if (!app) return;

  if (O.submitted) {
    app.innerHTML = renderConfirmation();
    return;
  }

  const stepLabels = ['Event','Contact','Design','Logos','Review'];
  const progressDots = stepLabels.map((label, i) => {
    const n = i + 1;
    const done = n < O.step;
    const active = n === O.step;
    const cls = done ? 'op-step done' : active ? 'op-step active' : 'op-step';
    const lineCls = done ? 'op-line done' : 'op-line';
    const dot = done ? '✓' : String(n);
    const line = n < stepLabels.length ? `<div class="${lineCls}"></div>` : '';
    const click = done ? ` onclick="window.editStep(${n})" style="cursor:pointer"` : '';
    return `<div class="${cls}"${click}><div class="op-dot">${dot}</div><div class="op-label">${label}</div></div>${line}`;
  }).join('');

  let stepHtml = '';
  if (O.step === 1) stepHtml = renderStep1();
  else if (O.step === 2) stepHtml = renderStep2();
  else if (O.step === 3) stepHtml = renderStep3();
  else if (O.step === 4) stepHtml = renderStep4();
  else if (O.step === 5) stepHtml = renderStep5();

  app.innerHTML = `
    <div class="order-wrap">
      <div class="order-progress">${progressDots}</div>
      <div class="order-card">
        ${stepHtml}
        ${renderNav()}
      </div>
    </div>`;

  attachListeners();
}

function renderNav() {
  const backLabel = O.step === 1 ? 'Back' : '← Back';
  let nextBtn;
  if (O.step === 5) {
    nextBtn = O.submitting
      ? `<button class="btn primary" disabled style="flex:1;justify-content:center">Submitting…</button>`
      : `<button class="btn primary" onclick="window.orderSubmit()" style="flex:1;justify-content:center">Submit Order</button>`;
  } else if (O.returnToReview) {
    nextBtn = `<button class="btn primary" onclick="window.orderNext()" style="flex:1;justify-content:center">Save</button>`;
  } else {
    nextBtn = `<button class="btn primary" onclick="window.orderNext()">Next →</button>`;
  }
  return `<div class="order-nav">
    <button class="btn" onclick="window.orderBack()">${backLabel}</button>
    ${nextBtn}
  </div>`;
}

function renderStep1() {
  const e = O.errors;
  return `
    <div class="order-title">Tell us about your event</div>
    <div class="order-sub">We'll use this to name your project and schedule your proof.</div>
    <div class="form-field">
      <label class="form-label" for="f-eventName">Event name</label>
      <input class="form-input" id="f-eventName" type="text" value="${esc(O.eventName)}" placeholder="e.g. Augusta Club Championship 2026" autocomplete="off">
      ${e.eventName ? `<div class="form-error">${esc(e.eventName)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-eventDate">Event date</label>
      <input class="form-input" id="f-eventDate" type="date" value="${esc(O.eventDate)}">
      ${e.eventDate ? `<div class="form-error">${esc(e.eventDate)}</div>` : ''}
    </div>`;
}

function renderStep2() {
  const e = O.errors;
  const regions = O.country === 'CA' ? CA_PROVINCES : US_STATES;
  const stateLabel = O.country === 'CA' ? 'Province' : 'State';
  const postalLabel = O.country === 'CA' ? 'Postal code' : 'ZIP code';
  const postalPlaceholder = O.country === 'CA' ? 'A1A 1A1' : '12345';
  return `
    <div class="order-title">Contact & shipping</div>
    <div class="order-sub">Where should we ship your flags?</div>
    <div class="form-field">
      <label class="form-label" for="f-contactName">Full name</label>
      <input class="form-input" id="f-contactName" type="text" value="${esc(O.contactName)}" autocomplete="name">
      ${e.contactName ? `<div class="form-error">${esc(e.contactName)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-contactEmail">Email</label>
      <input class="form-input" id="f-contactEmail" type="email" value="${esc(O.contactEmail)}" autocomplete="email">
      ${e.contactEmail ? `<div class="form-error">${esc(e.contactEmail)}</div>` : ''}
    </div>
    <div class="form-section-label">Shipping address</div>
    <div class="country-toggle">
      <button class="country-btn${O.country === 'US' ? ' active' : ''}" onclick="window.selectCountry('US')">🇺🇸 United States</button>
      <button class="country-btn${O.country === 'CA' ? ' active' : ''}" onclick="window.selectCountry('CA')">🇨🇦 Canada</button>
    </div>
    <div class="form-field">
      <label class="form-label" for="f-addr1">Address line 1</label>
      <input class="form-input" id="f-addr1" type="text" value="${esc(O.addressLine1)}" placeholder="Street address" autocomplete="address-line1">
      ${e.addressLine1 ? `<div class="form-error">${esc(e.addressLine1)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-addr2">Address line 2 <span style="font-weight:400;color:var(--gray-400)">(optional)</span></label>
      <input class="form-input" id="f-addr2" type="text" value="${esc(O.addressLine2)}" placeholder="Apt, suite, unit, etc." autocomplete="address-line2">
    </div>
    <div class="form-row">
      <div class="form-field">
        <label class="form-label" for="f-city">City</label>
        <input class="form-input" id="f-city" type="text" value="${esc(O.city)}" autocomplete="address-level2">
        ${e.city ? `<div class="form-error">${esc(e.city)}</div>` : ''}
      </div>
      <div class="form-field">
        <label class="form-label" for="f-state">${stateLabel}</label>
        <select class="form-input" id="f-state">
          <option value="">Select…</option>
          ${regions.map(r => `<option value="${r.code}"${O.stateProvince === r.code ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
        ${e.stateProvince ? `<div class="form-error">${esc(e.stateProvince)}</div>` : ''}
      </div>
    </div>
    <div class="form-field">
      <label class="form-label" for="f-postal">${postalLabel}</label>
      <input class="form-input" id="f-postal" type="text" value="${esc(O.postalCode)}" placeholder="${postalPlaceholder}" autocomplete="postal-code" style="max-width:180px">
      ${e.postalCode ? `<div class="form-error">${esc(e.postalCode)}</div>` : ''}
    </div>`;
}

function renderStep3() {
  const e = O.errors;
  return `
    <div class="order-title">Design preferences</div>
    <div class="order-sub">Help us understand your vision for the flags.</div>

    <div class="color-pickers-row">
      <div class="color-picker-col">
        <div class="form-section-label" style="margin-top:0">Primary color</div>
        ${renderCollapsibleColorPicker('primary')}
      </div>
      <div class="color-picker-col">
        <div class="form-section-label" style="margin-top:0">Secondary color</div>
        ${renderCollapsibleColorPicker('secondary')}
      </div>
    </div>

    <div class="form-section-label">Flag style</div>
    ${renderCollapsibleFlagPicker()}
    ${e.flagStyle ? `<div class="form-error" style="margin-top:6px">${esc(e.flagStyle)}</div>` : ''}

    <div class="form-section-label" style="margin-top:1.5rem">Flag setup</div>
    <div class="setup-toggle">
      <button class="setup-btn${O.flagSetup === 'same' ? ' active' : ''}" onclick="window.selectSetup('same')">Same front &amp; back</button>
      <button class="setup-btn${O.flagSetup === 'different' ? ' active' : ''}" onclick="window.selectSetup('different')">Different front &amp; back</button>
    </div>

    <div class="form-section-label" style="margin-top:1.5rem">Quantity</div>
    <div class="qty-toggle">
      ${[9, 18, 27, 36].map(n => `
        <button class="qty-btn${!O.flagQtyCustom && O.flagQty === n ? ' active' : ''}" onclick="window.selectQty(${n})">${n}</button>`).join('')}
      <button class="qty-btn${O.flagQtyCustom ? ' active' : ''}" onclick="window.selectQtyCustom()">Custom</button>
    </div>
    ${O.flagQtyCustom ? `
      <div class="form-field" style="margin-top:.75rem">
        <input class="form-input" type="number" min="9" step="1" id="f-qty" value="${O.flagQty}"
          placeholder="Enter quantity (min 9)" oninput="window.setQtyValue(this.value)" style="max-width:200px">
      </div>` : ''}
    ${e.flagQty ? `<div class="form-error" style="margin-top:6px">${esc(e.flagQty)}</div>` : ''}

    <div class="form-field" style="margin-top:1.25rem">
      <label class="form-label" for="f-notes">Design notes <span style="font-weight:400;color:var(--gray-400)">(optional)</span></label>
      <textarea class="form-input" id="f-notes" placeholder="Any specific design requests or references…">${esc(O.designNotes)}</textarea>
    </div>`;
}

function renderStep4() {
  const e = O.errors;
  const previews = O.logoFiles.map((lf, i) => `
    <div class="logo-preview-item">
      <img src="${lf.previewUrl}" alt="Logo ${i + 1}">
      <button class="logo-preview-remove" onclick="window.removeLogoFile(${i})" title="Remove">✕</button>
    </div>`).join('');

  return `
    <div class="order-title">Upload your logos</div>
    <div class="order-sub">At least one logo is required. Accepted formats: SVG, PNG, PDF, AI, EPS.</div>
    <div class="logo-dropzone" id="logoDropzone">
      <div class="logo-dropzone-icon">↑</div>
      <div class="logo-dropzone-text">Drop logos here or click to upload</div>
      <div class="logo-dropzone-sub">SVG, PNG, PDF, AI, EPS</div>
    </div>
    <input type="file" id="logoFileInput" accept=".svg,.png,.pdf,.ai,.eps,image/*" multiple style="display:none">
    ${e.logoFiles ? `<div class="form-error" style="margin-top:6px">${esc(e.logoFiles)}</div>` : ''}
    ${O.logoFiles.length ? `<div class="logo-preview-grid">${previews}</div>` : ''}`;
}

function renderStep5() {
  const e = O.errors;
  const ack1Cls = 'ack-item' + (O.ackDeadline ? ' checked' : '');
  const ack1CheckCls = 'ack-check' + (O.ackDeadline ? ' checked' : '');
  const ack2Cls = 'ack-item' + (O.ackPricing ? ' checked' : '');
  const ack2CheckCls = 'ack-check' + (O.ackPricing ? ' checked' : '');

  function colorChip(c) {
    if (!c) return '<span style="color:var(--gray-400)">—</span>';
    const isWhite = c.hex === '#FFFFFF';
    return `<span style="display:inline-flex;align-items:center;gap:5px"><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${c.hex};${isWhite ? 'border:1px solid var(--gray-200)' : ''};flex-shrink:0"></span>${esc(c.name)}</span>`;
  }

  const addrParts = [
    O.addressLine1, O.addressLine2,
    [O.city, O.stateProvince, O.postalCode].filter(Boolean).join(', '),
    O.country === 'CA' ? 'Canada' : 'USA',
  ].filter(Boolean);

  const setupLabel = O.flagSetup === 'different' ? 'Different front & back' : 'Same front & back';
  const styleLabel = O.flagStyle ? O.flagStyle.charAt(0).toUpperCase() + O.flagStyle.slice(1) : null;

  return `
    <div class="order-title">Review &amp; submit</div>
    <div class="order-sub">Acknowledge the following, then confirm your details before submitting.</div>
    <div class="${ack1Cls}" onclick="window.toggleAck('deadline')">
      <div class="${ack1CheckCls}"></div>
      <div class="ack-text">I acknowledge that final artwork approval is required at least 17 days before the event to avoid rush fees. If the event is on a weekend or Monday, this deadline will be moved to the preceding Friday.</div>
    </div>
    ${e.ackDeadline ? `<div class="form-error" style="margin-top:-12px;margin-bottom:12px">${esc(e.ackDeadline)}</div>` : ''}
    <div class="${ack2Cls}" onclick="window.toggleAck('pricing')">
      <div class="${ack2CheckCls}"></div>
      <div class="ack-text">I acknowledge that if I am submitting more than 3 total logos/designs, the price point for the flags will be $1,099.</div>
    </div>
    ${e.ackPricing ? `<div class="form-error" style="margin-top:-12px;margin-bottom:12px">${esc(e.ackPricing)}</div>` : ''}

    <div class="rs-divider"></div>

    <div class="rs-section">
      <div class="rs-section-header">
        <div class="rs-section-title">Event</div>
        <button class="rs-edit-btn" onclick="window.editStep(1)">Edit</button>
      </div>
      <div class="rs-row"><span class="rs-label">Name</span><span class="rs-value">${O.eventName ? esc(O.eventName) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
      <div class="rs-row"><span class="rs-label">Date</span><span class="rs-value">${formatDate(O.eventDate) || '<span style="color:var(--gray-400)">—</span>'}</span></div>
    </div>

    <div class="rs-section">
      <div class="rs-section-header">
        <div class="rs-section-title">Contact &amp; shipping</div>
        <button class="rs-edit-btn" onclick="window.editStep(2)">Edit</button>
      </div>
      <div class="rs-row"><span class="rs-label">Name</span><span class="rs-value">${O.contactName ? esc(O.contactName) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
      <div class="rs-row"><span class="rs-label">Email</span><span class="rs-value">${O.contactEmail ? esc(O.contactEmail) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
      <div class="rs-row"><span class="rs-label">Address</span><span class="rs-value">${addrParts.length ? addrParts.map(esc).join(', ') : '<span style="color:var(--gray-400)">—</span>'}</span></div>
    </div>

    <div class="rs-section">
      <div class="rs-section-header">
        <div class="rs-section-title">Design</div>
        <button class="rs-edit-btn" onclick="window.editStep(3)">Edit</button>
      </div>
      <div class="rs-row"><span class="rs-label">Style</span><span class="rs-value">${styleLabel ? esc(styleLabel) : '<span style="color:var(--gray-400)">—</span>'}</span></div>
      <div class="rs-row"><span class="rs-label">Primary</span><span class="rs-value">${colorChip(O.flagPrimaryColor)}</span></div>
      <div class="rs-row"><span class="rs-label">Secondary</span><span class="rs-value">${colorChip(O.flagSecondaryColor)}</span></div>
      <div class="rs-row"><span class="rs-label">Setup</span><span class="rs-value">${setupLabel}</span></div>
      <div class="rs-row"><span class="rs-label">Quantity</span><span class="rs-value">${O.flagQty} flag${O.flagQty === 1 ? '' : 's'}</span></div>
      ${O.designNotes ? `<div class="rs-row"><span class="rs-label">Notes</span><span class="rs-value">${esc(O.designNotes)}</span></div>` : ''}
    </div>

    <div class="rs-section">
      <div class="rs-section-header">
        <div class="rs-section-title">Logos</div>
        <button class="rs-edit-btn" onclick="window.editStep(4)">Edit</button>
      </div>
      ${O.logoFiles.length
        ? O.logoFiles.map(lf => `<div class="rs-row"><span class="rs-label">File</span><span class="rs-value">${esc(lf.file.name)}</span></div>`).join('')
        : '<div class="rs-row"><span class="rs-value" style="color:var(--gray-400)">No logos uploaded</span></div>'}
    </div>`;
}

function renderConfirmation() {
  const projectName = O.eventName + ' — ' + formatDate(O.eventDate);
  return `
    <div class="order-wrap">
      <div class="order-card" style="text-align:center;padding:2.5rem 2rem">
        <div class="confirm-icon"></div>
        <div class="confirm-title">Order received!</div>
        <div class="confirm-sub">Your designer will be in touch once your proof is ready for review.</div>
        <div class="confirm-detail">
          <div style="margin-bottom:4px"><strong>${esc(O.eventName)}</strong></div>
          <div style="margin-bottom:10px">${esc(formatDate(O.eventDate))}</div>
          <div style="font-size:12px;color:var(--gray-400)">Project: ${esc(projectName)}</div>
        </div>
      </div>
    </div>`;
}

// ── SVG helpers ────────────────────────────────────────────
function extractSvgInner(svgText) {
  const match = svgText.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
  return match ? match[1] : svgText;
}

function coloredSvgInner(svgText, primaryHex, secondaryHex) {
  if (!svgText) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const svgEl = doc.documentElement;
  if (primaryHex) {
    const el = svgEl.querySelector('#zone-primary');
    if (el) {
      el.setAttribute('fill', primaryHex);
      el.querySelectorAll('rect,path,polygon,circle,ellipse').forEach(c => c.setAttribute('fill', primaryHex));
    }
  }
  if (secondaryHex) {
    const el = svgEl.querySelector('#zone-secondary');
    if (el) {
      el.setAttribute('fill', secondaryHex);
      el.querySelectorAll('rect,path,polygon,circle,ellipse').forEach(c => c.setAttribute('fill', secondaryHex));
    }
  }
  const logoPlacement = svgEl.querySelector('#logo-placement');
  if (logoPlacement) logoPlacement.setAttribute('display', 'none');
  return svgEl.innerHTML;
}

// ── Collapsible pickers ────────────────────────────────────
function renderCollapsibleFlagPicker() {
  const primaryHex = O.flagPrimaryColor?.hex || null;
  const secondaryHex = O.flagSecondaryColor?.hex || null;
  const flagNames = ['Edinburgh', 'Ascot', 'Plain'];

  if (O.flagStyle && !O.flagStyleOpen) {
    const label = O.flagStyle.charAt(0).toUpperCase() + O.flagStyle.slice(1);
    const svgText = svgCache.get(label) || '';
    const inner = svgText ? coloredSvgInner(svgText, primaryHex, secondaryHex) : '';
    return `<div class="picker-collapsed" onclick="window.openPicker('flagStyle')" style="cursor:pointer">
      <div class="picker-flag-thumb">${inner ? `<svg viewBox="0 0 7519 4669" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%">${inner}</svg>` : ''}</div>
      <span class="picker-collapsed-name">${esc(label)}</span>
      <span style="flex:1"></span>
      <button class="picker-clear-btn" onclick="event.stopPropagation();window.clearPicker('flagStyle')" title="Clear">×</button>
    </div>`;
  }

  const cards = flagNames.map(name => {
    const isActive = O.flagStyle === name.toLowerCase();
    const svgText = svgCache.get(name) || '';
    const inner = svgText ? coloredSvgInner(svgText, primaryHex, secondaryHex) : '';
    return `<div class="flag-tmpl-card${isActive ? ' active' : ''}" onclick="window.selectFlagStyle('${name.toLowerCase()}')">
      <div class="flag-tmpl-thumb">${inner ? `<svg viewBox="0 0 7519 4669" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%">${inner}</svg>` : '<div style="width:100%;height:100%;background:var(--gray-100)"></div>'}</div>
      <div class="flag-tmpl-name">${name}</div>
    </div>`;
  }).join('');
  return `<div class="flag-tmpl-grid">${cards}</div>`;
}

function renderCollapsibleColorPicker(which) {
  const isSecondary = which === 'secondary';
  const selected = isSecondary ? O.flagSecondaryColor : O.flagPrimaryColor;
  const isOpen = isSecondary ? O.secondaryColorOpen : O.primaryColorOpen;
  const selectFn = isSecondary ? 'window.selectSecondaryColor' : 'window.selectPrimaryColor';
  const customId = isSecondary ? 'secondaryCustomPicker' : 'primaryCustomPicker';
  const pickerKey = isSecondary ? 'secondaryColor' : 'primaryColor';

  if (selected && !isOpen) {
    const isWhite = selected.hex === '#FFFFFF';
    return `<div class="picker-collapsed" onclick="window.openPicker('${pickerKey}')" style="cursor:pointer">
      <span class="picker-color-dot" style="background:${selected.hex};${isWhite ? 'border:1px solid var(--gray-200)' : ''}"></span>
      <span class="picker-collapsed-name">${esc(selected.name)}</span>
      <span style="flex:1"></span>
      <button class="picker-clear-btn" onclick="event.stopPropagation();window.clearPicker('${pickerKey}')" title="Clear">×</button>
    </div>`;
  }

  const isCustom = selected && !COLORS.find(c => c.hex.toLowerCase() === selected.hex.toLowerCase());
  const customValue = isCustom ? selected.hex : '#2d7a4a';

  const swatches = COLORS.map(c => {
    const isSel = selected?.hex === c.hex;
    const isWhite = c.hex === '#FFFFFF';
    return `<div class="color-swatch${isSel ? ' selected' : ''}${isWhite ? ' white-swatch' : ''}"
      style="background:${c.hex}" title="${esc(c.name)}"
      onclick="${selectFn}('${esc(c.hex)}','${esc(c.name)}')"></div>`;
  }).join('');

  return `<div class="color-swatch-grid">
    ${swatches}
    <label class="color-swatch color-custom-swatch${isCustom ? ' selected' : ''}" title="Custom color">
      <input type="color" id="${customId}" class="color-custom-input" value="${customValue}">
      <span class="color-custom-icon">+</span>
    </label>
  </div>`;
}

// ── Attach listeners ───────────────────────────────────────
function attachListeners() {
  // Step 1 inputs
  const evName = document.getElementById('f-eventName');
  if (evName) evName.addEventListener('input', e => { O.eventName = e.target.value; });

  const evDate = document.getElementById('f-eventDate');
  if (evDate) evDate.addEventListener('change', e => { O.eventDate = e.target.value; });

  // Step 2 inputs
  const cName = document.getElementById('f-contactName');
  if (cName) cName.addEventListener('input', e => { O.contactName = e.target.value; });

  const cEmail = document.getElementById('f-contactEmail');
  if (cEmail) cEmail.addEventListener('input', e => { O.contactEmail = e.target.value; });

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

  // Custom color pickers (fire on change so picker closes before DOM replace)
  const primaryCustom = document.getElementById('primaryCustomPicker');
  if (primaryCustom) {
    primaryCustom.addEventListener('change', e => {
      O.flagPrimaryColor = { hex: e.target.value, name: 'Custom' };
      O.primaryColorOpen = false;
      render();
    });
  }
  const secondaryCustom = document.getElementById('secondaryCustomPicker');
  if (secondaryCustom) {
    secondaryCustom.addEventListener('change', e => {
      O.flagSecondaryColor = { hex: e.target.value, name: 'Custom' };
      O.secondaryColorOpen = false;
      render();
    });
  }

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
    const previewUrl = URL.createObjectURL(file);
    O.logoFiles.push({ file, previewUrl });
  });
  O.errors = {};
  render();
}

// ── Window-level event handlers ────────────────────────────
window.orderNext = function () {
  const errors = validate(O.step);
  if (Object.keys(errors).length) {
    O.errors = errors;
    render();
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

window.orderSubmit = async function () {
  const errors = validate(5);
  if (Object.keys(errors).length) {
    O.errors = errors;
    render();
    return;
  }
  O.errors = {};
  O.submitting = true;
  render();

  try {
    const projectName = O.eventName + ' — ' + formatDate(O.eventDate);
    const projectId = await createProject(projectName);

    for (const lf of O.logoFiles) {
      await uploadLogo(projectId, lf.file);
    }

    await supabase.from('order_intakes').insert({
      project_id: projectId,
      event_name: O.eventName,
      event_date: O.eventDate,
      contact_name: O.contactName,
      contact_email: O.contactEmail,
      address_line1: O.addressLine1,
      address_line2: O.addressLine2 || null,
      city: O.city,
      state_province: O.stateProvince,
      postal_code: O.postalCode,
      country: O.country,
      flag_style: O.flagStyle,
      flag_colors: [O.flagPrimaryColor, O.flagSecondaryColor].filter(Boolean),
      flag_setup: O.flagSetup,
      flag_qty: O.flagQty,
      design_notes: O.designNotes || null,
      ack_deadline: O.ackDeadline,
      ack_pricing: O.ackPricing,
    });

    sendOrderConfirmation({
      contactName: O.contactName,
      contactEmail: O.contactEmail,
      eventName: O.eventName,
      eventDate: O.eventDate,
      shipping: {
        addressLine1: O.addressLine1,
        addressLine2: O.addressLine2 || '',
        city: O.city,
        stateProvince: O.stateProvince,
        postalCode: O.postalCode,
        country: O.country,
      },
      flagStyle: O.flagStyle,
      flagColors: [O.flagPrimaryColor, O.flagSecondaryColor].filter(Boolean),
      flagSetup: O.flagSetup,
      flagQty: O.flagQty,
      designNotes: O.designNotes || '',
      logoFileNames: O.logoFiles.map(lf => lf.file?.name).filter(Boolean),
      projectId,
    }).catch(err => console.warn('Order confirmation email failed', err));

    O.submitting = false;
    O.submitted = true;
    O.projectId = projectId;
    render();
    window.scrollTo(0, 0);
  } catch (err) {
    console.error('Order submission failed', err);
    O.submitting = false;
    O.errors = { submit: 'Something went wrong. Please try again.' };
    render();
  }
};

window.toggleAck = function (which) {
  if (which === 'deadline') O.ackDeadline = !O.ackDeadline;
  else if (which === 'pricing') O.ackPricing = !O.ackPricing;
  O.errors = {};
  render();
};

window.selectPrimaryColor = function (hex, name) {
  O.flagPrimaryColor = O.flagPrimaryColor?.hex === hex ? null : { hex, name };
  if (O.flagPrimaryColor) O.primaryColorOpen = false;
  render();
};

window.selectSecondaryColor = function (hex, name) {
  O.flagSecondaryColor = O.flagSecondaryColor?.hex === hex ? null : { hex, name };
  if (O.flagSecondaryColor) O.secondaryColorOpen = false;
  render();
};

window.openPicker = function (which) {
  if (which === 'flagStyle') O.flagStyleOpen = true;
  else if (which === 'primaryColor') O.primaryColorOpen = true;
  else if (which === 'secondaryColor') O.secondaryColorOpen = true;
  render();
};

window.clearPicker = function (which) {
  if (which === 'flagStyle') { O.flagStyle = ''; O.flagStyleOpen = false; }
  else if (which === 'primaryColor') { O.flagPrimaryColor = null; O.primaryColorOpen = false; }
  else if (which === 'secondaryColor') { O.flagSecondaryColor = null; O.secondaryColorOpen = false; }
  O.errors = {};
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
  if (lf) URL.revokeObjectURL(lf.previewUrl);
  O.logoFiles.splice(index, 1);
  render();
};

// ── Init ───────────────────────────────────────────────────
function init() {
  render();
  preloadSvgs();

  // Re-render step 3 once SVGs are loaded so thumbnails appear
  setTimeout(async () => {
    await Promise.all(['Edinburgh', 'Ascot', 'Plain'].map(name => loadSvg(name)));
    if (O.step === 3) render();
  }, 0);
}

window.addEventListener('DOMContentLoaded', init);
