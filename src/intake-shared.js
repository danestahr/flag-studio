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

// Weekend/Monday events count from the preceding Friday, then `days` back.
function daysBeforeWorkingFriday(eventDateIso, days) {
  if (!eventDateIso) return null;
  const [y, m, d] = eventDateIso.split('-').map(Number);
  const deadline = new Date(y, m - 1, d);
  const dow = deadline.getDay();
  if (dow === 6) deadline.setDate(deadline.getDate() - 1);
  else if (dow === 0) deadline.setDate(deadline.getDate() - 2);
  else if (dow === 1) deadline.setDate(deadline.getDate() - 3);
  deadline.setDate(deadline.getDate() - days);
  const iso = `${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, '0')}-${String(deadline.getDate()).padStart(2, '0')}`;
  return { iso, display: formatDate(iso) };
}

// Saturday/Sunday -> the Friday before; a weekday comes back unchanged.
export function previousFriday(iso) {
  if (!iso) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  if (dow === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  else if (dow === 0) dt.setUTCDate(dt.getUTCDate() - 2);
  return dt.toISOString().slice(0, 10);
}

// Mon-Fri only (no holidays), n business days before the date. Same logic Prestige uses for
// the in-hand date: subtractBusinessDays() in src/orderSummaryPdf.js and send-prestige-order.
export function subtractBusinessDays(iso, n) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  while (n > 0) {
    dt.setUTCDate(dt.getUTCDate() - 1);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) n--;
  }
  return dt.toISOString().slice(0, 10);
}

// Canadian orders need an extra week for customs, so every deadline moves 7 days
// earlier. Mirrors compute_approval_deadline(date, country) in the DB and the copies
// in send-order-confirmation / send-prestige-order: keep them in sync.
export const CANADA_EXTRA_DAYS = 7;
export const leadExtraFor = country => (country === 'CA' ? CANADA_EXTRA_DAYS : 0);

// The date passed in is the customer's delivery date (stored as order_intakes.event_date).
export function calcApprovalDeadline(eventDateIso, extra = 0) {
  return daysBeforeWorkingFriday(eventDateIso, 17 + extra);
}

// Standard deadline, or the rush one (10 days before the working Friday) once
// today is past the standard deadline. Mirrors rush logic in send-prestige-order.
export function calcEffectiveDeadline(eventDateIso, now = new Date(), extra = 0) {
  const std = calcApprovalDeadline(eventDateIso, extra);
  if (!std) return null;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (today <= std.iso) return { ...std, rush: false };
  const rush = daysBeforeWorkingFriday(eventDateIso, 10 + extra);
  // expired: even the rush deadline has passed, so the order can't be turned around in time.
  return { ...rush, rush: true, expired: rush.iso < today };
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

// First date (today or later) that can still be fulfilled, even as a rush. The delivery
// date picker doesn't offer anything earlier. null if none in the next ~13 months.
export function earliestDeliveryDate(now = new Date(), extra = 0) {
  const pad = n => String(n).padStart(2, '0');
  for (let i = 0; i < 400; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (!calcEffectiveDeadline(iso, now, extra)?.expired) return iso;
  }
  return null;
}

// Names the date itself rather than saying "this date".
const unmeetableMessage = iso => `${formatDate(iso)} is within the standard production window, flags can't be produced for an on-time delivery for ${formatDate(iso)}. We apologize for any inconvenience.`;

// "Today" / "Tomorrow" when the deadline is that close, else the date.
function deadlineText(iso, display, now) {
  const pad = n => String(n).padStart(2, '0');
  const day = off => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  return iso === day(0) ? 'Today' : iso === day(1) ? 'Tomorrow' : display;
}

const COUNTED_FROM_FRIDAY = 'counted from the preceding Friday if your delivery date is on a Saturday, Sunday or Monday';

// First date (today or later) whose standard approval deadline hasn't passed, i.e. the earliest
// delivery date that avoids the rush fee.
export function earliestStandardDate(now = new Date(), extra = 0) {
  const pad = n => String(n).padStart(2, '0');
  for (let i = 0; i < 400; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (!calcEffectiveDeadline(iso, now, extra)?.rush) return iso;
  }
  return null;
}

// Two ways out of a date that can't be met, each of which sets an applicable date (the order
// form's step 2 handles the click via [data-use-date]).
function renderDateOptions(now, extra, withTitle = true) {
  const fastest = earliestDeliveryDate(now, extra), standard = earliestStandardDate(now, extra);
  const btn = (iso, label) => iso ? `<button type="button" class="btn deadline-callout-btn" data-use-date="${esc(iso)}">${label}: ${esc(formatDate(iso))}</button>` : '';
  return `<div class="delivery-options">
    ${withTitle ? '<div class="delivery-options-title">Select a new delivery date</div>' : ''}
    ${btn(fastest, 'Fastest Delivery')}${btn(standard, 'Avoid Rush Fees')}
  </div>`;
}

// The callout under the delivery date (order form step 2 and the review step): the approval
// deadline, whether the order is a rush, and the disclaimers that go with it.
// withButtons (step 2): when the date can't be met, show nothing but the two buttons (fastest
// delivery / avoid rush fees) instead of a tile; the same buttons follow the notice shown when a
// typed date is rejected. Without it (the review step) an unmeetable date gets a plain message.
export function renderDeliveryAssessment(deliveryDateIso, country, now = new Date(), rejectedDateIso = null, withButtons = false, alert = false) {
  const extra = leadExtraFor(country);
  const options = withButtons ? renderDateOptions(now, extra) : '';
  const dl = deliveryDateIso ? calcEffectiveDeadline(deliveryDateIso, now, extra) : null;
  // The customer typed a date (rejectedDateIso) earlier than the earliest we can fulfil: the field
  // kept its previous value, and the same tile says why, above that value's own message.
  const notice = rejectedDateIso
    ? `<div class="deadline-callout-note">${esc(unmeetableMessage(rejectedDateIso))}</div>`
    : '';
  // A date that can't be met (synced, or typed and rejected) hides the approval deadline, its
  // label, rule and note: all that's left is the way forward. A typed, rejected date keeps its
  // explanation above the buttons, inside one tile.
  // In that tile the header leads, in the tile's orange label style, above the message.
  if (withButtons && notice) return `<div class="deadline-callout rush">
    <div class="deadline-callout-label">Select a new delivery date</div>
    ${notice}${renderDateOptions(now, extra, false)}
  </div>`;
  if (!dl) return '';
  // A date that can't be met (e.g. filled in by the event sync) gets the same tile: the message,
  // then the two ways out. `alert` (Continue was pressed) adds a line asking for a new date.
  if (withButtons && dl.expired) return `<div class="deadline-callout rush" id="deliveryUnmeetable">
    <div class="deadline-callout-label">Select a new delivery date</div>
    <div class="deadline-callout-note">${esc(unmeetableMessage(deliveryDateIso))}${extra ? ' Canadian orders include an extra 7 days for customs.' : ''}</div>
    ${alert ? '<div class="deadline-callout-alert">Please select a new delivery date to continue.</div>' : ''}
    ${renderDateOptions(now, extra, false)}
  </div>`;
  const canada = extra ? ' Canadian orders include an extra 7 days for customs.' : '';
  if (dl.expired) {
    if (withButtons) return options;
    return `<div class="deadline-callout rush expired">
      <div class="deadline-callout-label">This delivery date can't be met</div>
      <div class="deadline-callout-note">${esc(unmeetableMessage(deliveryDateIso))}${canada}</div>
    </div>`;
  }
  const when = deadlineText(dl.iso, dl.display, now);
  const by = when === 'Today' || when === 'Tomorrow' ? when.toLowerCase() : when; // "approved by today" / "by November 22, 2026"
  return `<div class="deadline-callout${dl.rush ? ' rush' : ''}">
    <div class="deadline-callout-label">${dl.rush ? 'Rush Order — Artwork Approval Deadline' : 'Artwork Approval Deadline'}</div>
    <div class="deadline-callout-date">${esc(deadlineText(dl.iso, dl.display, now))}</div>
    <div class="deadline-callout-note">${dl.rush
      ? `Flags must be approved by ${esc(by)} and will have an additional $199 rush fee to ensure an on-time delivery.${canada}`
      : `Flags must be approved by ${esc(by)} to avoid a rush fee and ensure an on-time delivery.${canada}`}</div>
  </div>`;
}

// Flat fee added to orders inside the standard production window.
export const RUSH_FEE = '$199';

// Which acknowledgments apply to this delivery date. `eventDate` here is the delivery date as stored;
// syncedEventDate is the event itself, known only when the event sync supplied it.
//   rush       the delivery date is inside the standard window (rush fee applies)
//   late       the delivery date is later than our standard delivery date for the event (2 business
//              days before it): little or no buffer before the event
//   afterEvent the delivery date is after the event itself (a subset of late)
// A date that can't be met at all gets none of these: it can't be submitted.
export function assessAcks({ eventDate, syncedEventDate, country } = {}, now = new Date()) {
  const dl = eventDate ? calcEffectiveDeadline(eventDate, now, leadExtraFor(country)) : null;
  const usable = !!dl && !dl.expired;
  const standard = syncedEventDate ? subtractBusinessDays(syncedEventDate, 2) : null;
  return {
    deadline: dl,
    rush: usable && !!dl.rush,
    late: usable && !!(standard && eventDate > standard),
    afterEvent: usable && !!(syncedEventDate && eventDate > syncedEventDate),
  };
}

// Wording of the review step's deadline acknowledgment (always shown).
export function deliveryAckText(deliveryDateIso, country, now = new Date()) {
  const dl = deliveryDateIso ? calcEffectiveDeadline(deliveryDateIso, now, leadExtraFor(country)) : null;
  return `I understand that final artwork must be approved by ${dl ? deadlineText(dl.iso, dl.display, now).replace(/^(Today|Tomorrow)$/, m => m.toLowerCase()) : 'the date above'} for my flags to arrive by my delivery date${deliveryDateIso ? ` on ${formatDate(deliveryDateIso)}` : ''}.`;
}

// Rush fee acknowledgment: shown (and required) only when the order is a rush.
export function renderRushAck(state, errors = {}, now = new Date()) {
  if (!assessAcks(state, now).rush) return '';
  return renderAckItem('ackRush', !!state.ackRush, `I understand that this is a rush order and will incur an additional <strong>${RUSH_FEE} rush fee</strong>.`)
    + (errors.ackRush ? `<div class="form-error">${esc(errors.ackRush)}</div>` : '');
}

// Late / after-event acknowledgment: shown (and required) only when the event is known and the
// delivery date leaves little or no buffer before it, or lands after it.
export function renderLateAck(state, errors = {}, now = new Date()) {
  const a = assessAcks(state, now);
  if (!a.late) return '';
  const text = a.afterEvent
    ? `I understand my flags will arrive on <strong>${esc(formatDate(state.eventDate))}</strong>, after my event on ${esc(formatDate(state.syncedEventDate))}, and will not be available for the event.`
    : `I understand my flags will arrive on <strong>${esc(formatDate(state.eventDate))}</strong>, later than our standard delivery date of ${esc(formatDate(subtractBusinessDays(state.syncedEventDate, 2)))} (2 business days before my event), leaving little or no buffer before the event.`;
  return renderAckItem('ackLate', !!state.ackLate, text)
    + (errors.ackLate ? `<div class="form-error">${esc(errors.ackLate)}</div>` : '');
}

// Used by the "submitted" page, which only has the saved date and country.
export function renderDeadlineCallout(deliveryDateIso, country) {
  const dl = calcApprovalDeadline(deliveryDateIso, leadExtraFor(country));
  if (!dl) return '';
  return `<div class="deadline-callout">
    <div class="deadline-callout-label">Artwork Approval Deadline</div>
    <div class="deadline-callout-date">${esc(dl.display)}</div>
    <div class="deadline-callout-note">${17 + leadExtraFor(country)} days before your delivery date — ${COUNTED_FROM_FRIDAY}.</div>
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
