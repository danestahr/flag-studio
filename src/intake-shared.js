// Shared render/validate helpers for collecting event and contact/shipping
// details, ported from order.js's Step 1/2/5 wizard panels so the new
// submit-from-Gallery-&-export flow (and event-info.js) can reuse the exact
// same fields/markup/validation instead of forking a second copy.
//
// Framework-agnostic on purpose: render* functions are pure string
// templates, attach*Listeners functions take a container element plus a
// plain state object and mutate it by reference (matching this codebase's
// existing "any module can mutate shared state by reference" convention,
// see hs/state.js) — this works whether the caller re-renders once (like
// flags/gallery.js) or rebuilds its panel's innerHTML on every visit (like
// hs/export.js's renderGallery()), since the caller re-attaches listeners
// after each render either way.

import { esc } from './dom-utils.js';

export const US_STATES = [
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

export const CA_PROVINCES = [
  {code:'AB',name:'Alberta'},{code:'BC',name:'British Columbia'},{code:'MB',name:'Manitoba'},
  {code:'NB',name:'New Brunswick'},{code:'NL',name:'Newfoundland and Labrador'},
  {code:'NS',name:'Nova Scotia'},{code:'NT',name:'Northwest Territories'},
  {code:'NU',name:'Nunavut'},{code:'ON',name:'Ontario'},{code:'PE',name:'Prince Edward Island'},
  {code:'QC',name:'Quebec'},{code:'SK',name:'Saskatchewan'},{code:'YT',name:'Yukon'},
];

export function formatDate(isoDate) {
  if (!isoDate) return '';
  const [year, month, day] = isoDate.split('-').map(Number);
  const months = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return months[month - 1] + ' ' + day + ', ' + year;
}

export function calcApprovalDeadline(eventDateIso) {
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

// ── Event fields (order.js Step 1) ──────────────────────────────────────

export function renderEventFields(state, errors = {}) {
  const e = errors;
  return `
    <div class="form-field">
      <label class="form-label" for="f-eventName">Event name</label>
      <input class="form-input" id="f-eventName" type="text" value="${esc(state.eventName)}" placeholder="e.g. Augusta Club Championship 2026" autocomplete="off">
      ${e.eventName ? `<div class="form-error">${esc(e.eventName)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-courseName">Course name <span style="font-weight:400;color:var(--gray-400)">(optional)</span></label>
      <input class="form-input" id="f-courseName" type="text" value="${esc(state.courseName)}" placeholder="e.g. Augusta National Golf Club" autocomplete="off">
    </div>
    <div class="form-field">
      <label class="form-label" for="f-eventDate">Event date</label>
      <input class="form-input" id="f-eventDate" type="date" value="${esc(state.eventDate)}">
      ${e.eventDate ? `<div class="form-error">${esc(e.eventDate)}</div>` : ''}
    </div>`;
}

export function validateEventFields(state) {
  const errors = {};
  if (!state.eventName?.trim()) errors.eventName = 'Event name is required.';
  if (!state.eventDate) errors.eventDate = 'Event date is required.';
  return errors;
}

export function attachEventFieldListeners(container, state) {
  const evName = container.querySelector('#f-eventName');
  if (evName) evName.addEventListener('input', e => { state.eventName = e.target.value; });
  const courseName = container.querySelector('#f-courseName');
  if (courseName) courseName.addEventListener('input', e => { state.courseName = e.target.value; });
  const evDate = container.querySelector('#f-eventDate');
  if (evDate) evDate.addEventListener('change', e => { state.eventDate = e.target.value; });
}

// ── Contact & shipping fields (order.js Step 2) ─────────────────────────
//
// contact.attn follows the same null-vs-empty-string convention as
// order.js's O.attn: null means "untouched, default to contactName";  ''
// means "explicitly cleared by the customer".

export function renderContactShippingFields(contact, errors = {}) {
  const e = errors;
  const regions = contact.country === 'CA' ? CA_PROVINCES : US_STATES;
  const stateLabel = contact.country === 'CA' ? 'Province' : 'State';
  const postalLabel = contact.country === 'CA' ? 'Postal code' : 'ZIP code';
  const postalPlaceholder = contact.country === 'CA' ? 'A1A 1A1' : '12345';
  const effectiveAttn = contact.attn !== null && contact.attn !== undefined ? contact.attn : contact.contactName;
  return `
    <div class="form-section-label" style="margin-top:0">Contact</div>
    <div class="form-field">
      <label class="form-label" for="f-contactName">Full name</label>
      <input class="form-input" id="f-contactName" type="text" value="${esc(contact.contactName)}" autocomplete="name">
      ${e.contactName ? `<div class="form-error">${esc(e.contactName)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-contactEmail">Email</label>
      <input class="form-input" id="f-contactEmail" type="email" value="${esc(contact.contactEmail)}" autocomplete="email">
      ${e.contactEmail ? `<div class="form-error">${esc(e.contactEmail)}</div>` : ''}
    </div>
    <div class="form-section-label">Shipping address</div>
    <div class="country-toggle">
      <button type="button" class="country-btn${contact.country === 'US' ? ' active' : ''}" data-country="US">🇺🇸 United States</button>
      <button type="button" class="country-btn${contact.country === 'CA' ? ' active' : ''}" data-country="CA">🇨🇦 Canada</button>
    </div>
    <div class="form-field">
      <label class="form-label" for="f-attn">ATTN <span style="font-weight:400;color:var(--gray-400)">(optional)</span></label>
      <input class="form-input" id="f-attn" type="text" value="${esc(effectiveAttn)}" placeholder="Recipient name" autocomplete="off">
    </div>
    <div class="form-field">
      <label class="form-label" for="f-addr1">Address line 1</label>
      <input class="form-input" id="f-addr1" type="text" value="${esc(contact.addressLine1)}" placeholder="Street address" autocomplete="address-line1">
      ${e.addressLine1 ? `<div class="form-error">${esc(e.addressLine1)}</div>` : ''}
    </div>
    <div class="form-field">
      <label class="form-label" for="f-addr2">Address line 2 <span style="font-weight:400;color:var(--gray-400)">(optional)</span></label>
      <input class="form-input" id="f-addr2" type="text" value="${esc(contact.addressLine2)}" placeholder="Apt, suite, unit, etc." autocomplete="address-line2">
    </div>
    <div class="form-row">
      <div class="form-field">
        <label class="form-label" for="f-city">City</label>
        <input class="form-input" id="f-city" type="text" value="${esc(contact.city)}" autocomplete="address-level2">
        ${e.city ? `<div class="form-error">${esc(e.city)}</div>` : ''}
      </div>
      <div class="form-field">
        <label class="form-label" for="f-state">${stateLabel}</label>
        <select class="form-input" id="f-state">
          <option value="">Select…</option>
          ${regions.map(r => `<option value="${r.code}"${contact.stateProvince === r.code ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
        </select>
        ${e.stateProvince ? `<div class="form-error">${esc(e.stateProvince)}</div>` : ''}
      </div>
      <div class="form-field" style="max-width:80px;flex:0 0 80px">
        <label class="form-label" for="f-postal">${postalLabel}</label>
        <input class="form-input" id="f-postal" type="text" value="${esc(contact.postalCode)}" placeholder="${postalPlaceholder}" autocomplete="postal-code">
        ${e.postalCode ? `<div class="form-error">${esc(e.postalCode)}</div>` : ''}
      </div>
    </div>`;
}

export function validateContactShipping(contact) {
  const errors = {};
  if (!contact.contactName?.trim()) errors.contactName = 'Full name is required.';
  if (!contact.contactEmail?.trim()) errors.contactEmail = 'Email is required.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.contactEmail)) errors.contactEmail = 'Enter a valid email address.';
  if (!contact.addressLine1?.trim()) errors.addressLine1 = 'Address is required.';
  if (!contact.city?.trim()) errors.city = 'City is required.';
  if (!contact.stateProvince) errors.stateProvince = (contact.country === 'CA' ? 'Province' : 'State') + ' is required.';
  if (!contact.postalCode?.trim()) errors.postalCode = (contact.country === 'CA' ? 'Postal code' : 'ZIP code') + ' is required.';
  return errors;
}

// onCountryChange is called (no args) after country/stateProvince mutate, so
// the caller can re-render — the region list and postal label depend on it.
export function attachContactShippingListeners(container, contact, { onCountryChange } = {}) {
  const bind = (id, prop, evt = 'input') => {
    const el = container.querySelector('#' + id);
    if (el) el.addEventListener(evt, e => { contact[prop] = e.target.value; });
  };
  bind('f-contactName', 'contactName');
  bind('f-contactEmail', 'contactEmail');
  bind('f-attn', 'attn');
  bind('f-addr1', 'addressLine1');
  bind('f-addr2', 'addressLine2');
  bind('f-city', 'city');
  bind('f-state', 'stateProvince', 'change');
  bind('f-postal', 'postalCode');

  container.querySelectorAll('.country-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      contact.country = btn.dataset.country;
      contact.stateProvince = '';
      if (onCountryChange) onCountryChange();
    });
  });
}

// ── Acknowledgment checkboxes (order.js Step 5 .ack-item pattern) ───────
//
// Generic on purpose: order.js hardcoded a single "deadline" acknowledgment
// (its "pricing" one computed checked/unchecked classes but never rendered
// the item itself, so that policy text was never actually written). Callers
// supply their own key + copy rather than this module guessing at legal
// text.

export function renderAckItem(key, checked, text) {
  return `<div class="ack-item${checked ? ' checked' : ''}" data-ack="${esc(key)}">
    <div class="ack-check${checked ? ' checked' : ''}"></div>
    <div class="ack-text">${text}</div>
  </div>`;
}

export function attachAckListeners(container, acks, onChange) {
  container.querySelectorAll('[data-ack]').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.ack;
      acks[key] = !acks[key];
      if (onChange) onChange();
    });
  });
}

export function renderDeadlineCallout(eventDateIso) {
  const dl = calcApprovalDeadline(eventDateIso);
  if (!dl) return '';
  return `<div class="deadline-callout">
    <div class="deadline-callout-label">Your artwork approval deadline</div>
    <div class="deadline-callout-date">${esc(dl.display)}</div>
    <div class="deadline-callout-note">17 days before your event — adjusted to the preceding Friday if needed.</div>
  </div>`;
}

// ── Recap rows (order.js Step 5 .rs-section/.rs-row pattern) ───────────
//
// rows is [label, value][]; value is inserted as-is (not escaped) so callers
// can pass pre-built markup (e.g. a color chip) — plain text values must be
// esc()'d by the caller first, same as order.js's own renderStep5 did.

export function renderRecapSection(title, rows, editHref) {
  const rowsHtml = rows.map(([label, value]) =>
    `<div class="rs-row"><span class="rs-label">${esc(label)}</span><span class="rs-value">${value || '<span style="color:var(--gray-400)">—</span>'}</span></div>`
  ).join('');
  return `<div class="rs-section">
    <div class="rs-section-header">
      <div class="rs-section-title">${esc(title)}</div>
      ${editHref ? `<a class="rs-edit-btn" href="${esc(editHref)}" style="text-decoration:none">Edit</a>` : ''}
    </div>
    ${rowsHtml}
  </div>`;
}
