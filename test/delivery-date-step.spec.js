import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import {
  leadExtraFor, calcApprovalDeadline, calcEffectiveDeadline, renderDeliveryAssessment, deliveryAckText, renderDeadlineCallout,
  earliestDeliveryDate, earliestStandardDate, subtractBusinessDays, previousFriday, assessAcks, renderRushAck, renderLateAck, RUSH_FEE,
} from '../src/intake-shared.js';

// The delivery date moved from step 1 ("Event Date") to a "Delivery" group on step 2. It is
// stored as event_date, so every deadline calculation is unchanged, except that Canada now
// gets an extra 7 days (24 days standard, 17 rush). Expectations below are worked out by
// hand for "today" = Mon 2026-11-16.
//   US:  deadline = (date, moved back to the preceding Friday if Sat/Sun/Mon) - 17 days; rush = - 10
//   CA:  - 24 days; rush - 17

const [y, m, d] = [2026, 11, 16];
const NOW = new Date(y, m - 1, d, 12, 0, 0);
const iso = (yy, mm, dd) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;

// ── Pure logic ────────────────────────────────────────────────────────────────────────
test('Canada adds 7 days to the standard and rush deadlines', () => {
  expect(leadExtraFor('CA')).toBe(7);
  expect(leadExtraFor('US')).toBe(0);
  expect(leadExtraFor(undefined)).toBe(0);
  // Wed 2027-03-10: US 17 days -> Feb 21; CA 24 days -> Feb 14.
  expect(calcApprovalDeadline('2027-03-10').iso).toBe('2027-02-21');
  expect(calcApprovalDeadline('2027-03-10', 7).iso).toBe('2027-02-14');
  // Monday 2027-03-08 counts from Friday 03-05: US Feb 16, CA Feb 9.
  expect(calcApprovalDeadline('2027-03-08').iso).toBe('2027-02-16');
  expect(calcApprovalDeadline('2027-03-08', 7).iso).toBe('2027-02-09');
});

test('standard, rush and expired tiers, US and Canada', () => {
  const t = (date, extra = 0) => calcEffectiveDeadline(date, NOW, extra);
  expect(t('2026-12-03')).toMatchObject({ iso: '2026-11-16', rush: false });          // deadline is today: still standard
  expect(t('2026-12-02')).toMatchObject({ iso: '2026-11-22', rush: true, expired: false }); // US rush: -10 days
  expect(t('2026-11-25')).toMatchObject({ rush: true, expired: true });                // US rush deadline Nov 15 is past
  expect(t('2026-12-10', 7)).toMatchObject({ iso: '2026-11-16', rush: false });        // CA: Dec 10 - 24 = today
  expect(t('2026-12-09', 7)).toMatchObject({ rush: true, expired: false });            // CA rush: Dec 9 - 17 = Nov 22
  expect(t('2026-12-02', 7)).toMatchObject({ rush: true, expired: true });             // fine for the US, too late for Canada
});

test('the shared callout shows the deadline, the rush disclaimer, the Canada note, and the expired message', () => {
  const std = renderDeliveryAssessment('2027-03-10', 'US', NOW);
  expect(std).toContain('Artwork Approval Deadline');
  expect(std).not.toContain('Your artwork');
  expect(std).toContain('February 21, 2027');
  expect(std).toContain('Flags must be approved by February 21, 2027 to avoid a rush fee and ensure an on-time delivery.');
  expect(std).not.toContain('by this date');
  expect(std).not.toContain('Canadian orders');

  const ca = renderDeliveryAssessment('2027-03-10', 'CA', NOW);
  expect(ca).toContain('February 14, 2027');
  expect(ca).toContain('Flags must be approved by February 14, 2027 to avoid a rush fee');
  expect(ca).toContain('Canadian orders include an extra 7 days for customs');

  const rush = renderDeliveryAssessment('2026-12-02', 'US', NOW);
  expect(rush).toContain('Rush Order — Artwork Approval Deadline');
  expect(rush).toContain('November 22, 2026');
  expect(rush).toContain('Flags must be approved by November 22, 2026 and will have an additional $199 rush fee to ensure an on-time delivery.');

  const expired = renderDeliveryAssessment('2026-11-25', 'US', NOW);
  expect(expired).toContain("This delivery date can't be met");
  expect(expired).toContain("November 25, 2026 is within the standard production window, flags can't be produced for an on-time delivery for November 25, 2026. We apologize for any inconvenience.");
  expect(expired).not.toContain('deadline-callout-date');

  expect(renderDeliveryAssessment('', 'US', NOW)).toBe('');
});

test('the earliest date we can fulfil is the first one whose rush deadline is not past', () => {
  // US: rush deadline = (date's working Friday) - 10. Thu Nov 26 -> Nov 16 (today), Wed Nov 25 -> Nov 15 (past).
  expect(earliestDeliveryDate(NOW, 0)).toBe('2026-11-26');
  expect(calcEffectiveDeadline('2026-11-26', NOW, 0).expired).toBe(false);
  expect(calcEffectiveDeadline('2026-11-25', NOW, 0).expired).toBe(true);
  // Canada: - 17, so Thu Dec 3 -> Nov 16, Wed Dec 2 -> Nov 15.
  expect(earliestDeliveryDate(NOW, 7)).toBe('2026-12-03');
  expect(calcEffectiveDeadline('2026-12-03', NOW, 7).expired).toBe(false);
  expect(calcEffectiveDeadline('2026-12-02', NOW, 7).expired).toBe(true);
  // It moves with the clock.
  expect(earliestDeliveryDate(new Date(2026, 11, 1, 12), 0)).toBe('2026-12-11');
  // The typed-date notice lives inside the same single tile as the kept date's own message.
  const withNotice = renderDeliveryAssessment('2027-03-10', 'US', NOW, '2026-11-20', true);
  expect((withNotice.match(/<div class="deadline-callout( |")/g) || []).length).toBe(1);
  expect(withNotice).toContain("November 20, 2026 is within the standard production window, flags can't be produced for an on-time delivery for November 20, 2026. We apologize for any inconvenience.");
  expect(withNotice).not.toContain("That date can't be met");
  expect(withNotice).not.toContain('for this date'); // the date is named, not "this date"
  expect(withNotice).not.toContain('February 21, 2027'); // the kept date's approval section is hidden
  for (const gone of ['deadline-callout-date', 'deadline-callout-rule', 'Artwork Approval Deadline']) expect(withNotice).not.toContain(gone);
  // the header leads the tile, above the message and the buttons (and is not repeated)
  expect(withNotice).toContain('<div class="deadline-callout-label">Select a new delivery date</div>');
  expect(withNotice.indexOf('Select a new delivery date')).toBeLessThan(withNotice.indexOf('is within the standard production window'));
  expect(withNotice.indexOf('is within the standard production window')).toBeLessThan(withNotice.indexOf('data-use-date'));
  expect(withNotice.split('Select a new delivery date').length - 1).toBe(1);
  expect(renderDeliveryAssessment('', 'US', NOW, '2026-11-20', true)).toContain('We apologize for any inconvenience.');
});

test("when a date can't be met the tile gives the message and the fastest-delivery and avoid-rush-fees buttons", () => {
  // Today Mon Nov 16 2026. US: fastest = rush deadline is today (Thu Nov 26); avoid rush = standard deadline is today (Thu Dec 3).
  // Canada (+7): Dec 3 and Dec 10.
  expect(earliestStandardDate(NOW, 0)).toBe('2026-12-03');
  expect(calcEffectiveDeadline('2026-12-03', NOW, 0).rush).toBe(false);
  expect(calcEffectiveDeadline('2026-12-02', NOW, 0).rush).toBe(true);
  expect(earliestStandardDate(NOW, 7)).toBe('2026-12-10');

  const html = renderDeliveryAssessment('2026-11-25', 'US', NOW, null, true);
  expect(html).toContain('Select a new delivery date');
  expect(html).toContain("November 25, 2026 is within the standard production window");
  expect(html).toContain('data-use-date="2026-11-26"');
  expect(html).toContain('Fastest Delivery: November 26, 2026');
  expect(html).toContain('data-use-date="2026-12-03"');
  expect(html).toContain('Avoid Rush Fees: December 3, 2026');
  for (const gone of ['deadline-callout-date', 'deadline-callout-rule', 'Artwork Approval Deadline']) {
    expect(html, `should not contain ${gone}`).not.toContain(gone);
  }
  expect(html).not.toContain('deadline-callout-alert');
  expect(renderDeliveryAssessment('2026-11-25', 'US', NOW, null, true, true)).toContain('Please select a new delivery date to continue.');
  const ca = renderDeliveryAssessment('2026-12-02', 'CA', NOW, null, true);
  expect(ca).toContain('data-use-date="2026-12-03"');
  expect(ca).toContain('data-use-date="2026-12-10"');
  // Without buttons (the review step) an unmeetable date keeps a plain message; a date that can be met never gets buttons.
  expect(renderDeliveryAssessment('2026-11-25', 'US', NOW)).toContain("November 25, 2026 is within the standard production window");
  expect(renderDeliveryAssessment('2026-11-25', 'US', NOW)).not.toContain('data-use-date');
  expect(renderDeliveryAssessment('2027-03-10', 'US', NOW, null, true)).not.toContain('data-use-date');
});

test('a deadline of today or tomorrow reads "Today" / "Tomorrow" in the tile; anything else shows the date', () => {
  const dateOf = (delivery, country = 'US') => (renderDeliveryAssessment(delivery, country, NOW).match(/deadline-callout-date">([^<]+)</) || [])[1];
  expect(dateOf('2026-12-03')).toBe('Today');        // US: Dec 3 - 17 = Nov 16
  expect(dateOf('2026-12-04')).toBe('Tomorrow');     // Fri Dec 4 - 17 = Nov 17
  expect(dateOf('2026-12-07')).toBe('Tomorrow');     // Monday counts from the Friday before (Dec 4): also Nov 17
  expect(dateOf('2026-12-10')).toBe('November 23, 2026'); // Thu Dec 10 - 17
});

test('the note names the approval date; when it is today or tomorrow it says so', () => {
  const note = (d, c = 'US') => (renderDeliveryAssessment(d, c, NOW).match(/deadline-callout-note">([^<]+)</) || [])[1];
  expect(note('2026-12-03')).toBe('Flags must be approved by today to avoid a rush fee and ensure an on-time delivery.');
  expect(note('2026-12-04')).toBe('Flags must be approved by tomorrow to avoid a rush fee and ensure an on-time delivery.');
  expect(note('2026-12-10')).toBe('Flags must be approved by November 23, 2026 to avoid a rush fee and ensure an on-time delivery.');
});

test('the deadline acknowledgment names the approval date and the delivery date', () => {
  expect(deliveryAckText('2027-03-10', 'US', NOW)).toBe('I understand that final artwork must be approved by February 21, 2027 for my flags to arrive by my delivery date on March 10, 2027.');
  expect(deliveryAckText('2027-03-10', 'CA', NOW)).toContain('approved by February 14, 2027');
  expect(deliveryAckText('2026-12-03', 'US', NOW)).toContain('approved by today');
  expect(deliveryAckText('2026-12-04', 'US', NOW)).toContain('approved by tomorrow');
  expect(deliveryAckText('2026-12-02', 'US', NOW)).not.toContain('rush'); // the rush fee has its own checkbox
});

test('which acknowledgments apply: rush, late for the event, after the event, or none', () => {
  const a = (eventDate, syncedEventDate = '', country = 'US') => assessAcks({ eventDate, syncedEventDate, country }, NOW);
  // Rush: the delivery date is inside the standard window but can still be met (US Dec 2, Canada Dec 9).
  expect(a('2026-12-02')).toMatchObject({ rush: true, late: false, afterEvent: false });
  expect(a('2026-12-09', '', 'CA')).toMatchObject({ rush: true });
  expect(a('2026-12-02', '', 'CA')).toMatchObject({ rush: false, late: false });     // can't be met at all: nothing to acknowledge
  expect(a('2026-11-25')).toMatchObject({ rush: false, late: false, afterEvent: false });
  expect(a('2027-03-10')).toMatchObject({ rush: false, late: false, afterEvent: false });
  // Late needs the event: event Wed 2027-03-10, standard delivery Mon 03-08.
  expect(a('2027-03-08', '2027-03-10')).toMatchObject({ late: false, afterEvent: false });
  expect(a('2027-03-05', '2027-03-10')).toMatchObject({ late: false });
  expect(a('2027-03-09', '2027-03-10')).toMatchObject({ late: true, afterEvent: false });   // 1 day before: no buffer
  expect(a('2027-03-10', '2027-03-10')).toMatchObject({ late: true, afterEvent: false });   // on the day
  expect(a('2027-03-11', '2027-03-10')).toMatchObject({ late: true, afterEvent: true });    // after the event
  expect(a('2027-03-11', '')).toMatchObject({ late: false, afterEvent: false });            // no event date known (not synced)
  // Both can apply at once.
  expect(a('2026-12-03', '2026-12-04', 'US')).toMatchObject({ rush: false, late: true });
});

test('the rush and late acknowledgments render their wording only when they apply', () => {
  const rush = renderRushAck({ eventDate: '2026-12-02', country: 'US' }, {}, NOW);
  expect(rush).toContain('data-ack="ackRush"');
  expect(rush).toContain(`I understand that this is a rush order and will incur an additional <strong>${RUSH_FEE} rush fee</strong>.`);
  expect(renderRushAck({ eventDate: '2027-03-10', country: 'US' }, {}, NOW)).toBe('');
  expect(renderRushAck({ eventDate: '2026-11-25', country: 'US' }, {}, NOW)).toBe('');
  expect(renderRushAck({ eventDate: '2026-12-02', country: 'US', ackRush: true }, {}, NOW)).toContain('ack-item checked');
  expect(renderRushAck({ eventDate: '2026-12-02', country: 'US' }, { ackRush: 'Please accept the $199 rush fee to submit your order.' }, NOW)).toContain('form-error');

  const buffer = renderLateAck({ eventDate: '2027-03-09', syncedEventDate: '2027-03-10', country: 'US' }, {}, NOW);
  expect(buffer).toContain('data-ack="ackLate"');
  expect(buffer).toContain('later than our standard delivery date of March 8, 2027 (2 business days before my event), leaving little or no buffer before the event.');
  const after = renderLateAck({ eventDate: '2027-03-11', syncedEventDate: '2027-03-10', country: 'US' }, {}, NOW);
  expect(after).toContain('after my event on March 10, 2027, and will not be available for the event.');
  expect(renderLateAck({ eventDate: '2027-03-08', syncedEventDate: '2027-03-10', country: 'US' }, {}, NOW)).toBe('');
  expect(renderLateAck({ eventDate: '2027-03-11', country: 'US' }, {}, NOW)).toBe('');
});

test('the submitted-page callout follows the country too', () => {
  expect(renderDeadlineCallout('2027-03-10', 'US')).toContain('February 21, 2027');
  expect(renderDeadlineCallout('2027-03-10', 'US')).toContain('Artwork Approval Deadline');
  expect(renderDeadlineCallout('2027-03-10', 'CA')).toContain('February 14, 2027');
  expect(renderDeadlineCallout('2027-03-10', 'CA')).toContain('24 days before your delivery date');
});

test('subtractBusinessDays skips weekends, like Prestige\'s in-hand rule', () => {
  expect(subtractBusinessDays('2026-12-17', 2)).toBe('2026-12-15'); // Thu -> Tue
  expect(subtractBusinessDays('2026-12-14', 2)).toBe('2026-12-10'); // Mon -> Thu
  expect(subtractBusinessDays('2026-12-12', 2)).toBe('2026-12-10'); // Sat -> Thu
  expect(subtractBusinessDays('2026-12-13', 2)).toBe('2026-12-10'); // Sun -> Thu
  expect(subtractBusinessDays('2026-12-15', 2)).toBe('2026-12-11'); // the in-hand date taken from a delivery date: Tue -> Fri
  expect(subtractBusinessDays('', 2)).toBe('');
});

test('previousFriday moves Saturday and Sunday back and leaves weekdays alone', () => {
  expect(previousFriday('2026-12-12')).toBe('2026-12-11'); // Sat
  expect(previousFriday('2026-12-13')).toBe('2026-12-11'); // Sun
  expect(previousFriday('2026-12-11')).toBe('2026-12-11'); // Fri
  expect(previousFriday('2026-12-14')).toBe('2026-12-14'); // Mon
});

// ── Edge functions keep their own copies of the math: check them against the client ───
const load = f => stripTypeScriptTypes(readFileSync(new URL(`../supabase/functions/${f}/index.ts`, import.meta.url), 'utf8'));
function fn(src, name) {
  const start = src.search(new RegExp(`(^|\\n)(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function* days(from, to) {
  for (let t = Date.UTC(...from); t <= Date.UTC(...to); t += 86400000) yield new Date(t).toISOString().slice(0, 10);
}

test('send-order-confirmation deadline matches the client, every day, US and Canada', () => {
  const src = load('send-order-confirmation');
  const code = ['daysBefore', 'calcApprovalDeadline'].map(n => fn(src, n)).join('\n');
  const edge = new Function(`${code}\nreturn { calcApprovalDeadline };`)();
  for (const day of days([2026, 0, 1], [2028, 11, 31])) {
    for (const country of ['US', 'CA']) {
      expect(edge.calcApprovalDeadline(day, country).iso, `${day} ${country}`).toBe(calcApprovalDeadline(day, leadExtraFor(country)).iso);
    }
  }
});

test('send-prestige-order rush flag matches the client, US and Canada, across several "today" dates', () => {
  const src = load('send-prestige-order');
  const iso2 = t => new Date(t).toISOString().slice(0, 10);
  for (const today of ['2026-11-16', '2026-12-01', '2027-02-28']) {
    const fixed = Date.parse(`${today}T12:00:00Z`);
    const FakeDate = class extends Date { constructor(...a) { if (a.length === 0) super(fixed); else super(...a); } static now() { return fixed; } };
    const isRush = new Function('Date', `${fn(src, 'isRush')}\nreturn isRush;`)(FakeDate);
    const [ty, tm, td] = today.split('-').map(Number);
    const now = new Date(ty, tm - 1, td, 12);
    const start = Date.parse(`${today}T00:00:00Z`) / 86400000;
    for (let off = -10; off <= 60; off++) {
      const day = iso2((start + off) * 86400000);
      for (const country of ['US', 'CA']) {
        expect(isRush(day, country), `today ${today}, ${day}, ${country}`).toBe(!!calcEffectiveDeadline(day, now, leadExtraFor(country))?.rush);
      }
    }
  }
});

// ── Database: the stored deadline (used by the reminder emails) follows the country ───────
const DB = process.env.DB_CONTAINER || 'supabase_db_flag-studio';
const psql = sql => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-At', '-F', '|', '-c', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n').filter(Boolean).map(l => l.split('|'));
let dbUp = true;
try { psql('select 1'); } catch { dbUp = false; }

test('compute_approval_deadline(date, country) matches the client for every day', () => {
  test.skip(!dbUp, 'local Supabase db container not reachable');
  const rows = psql(`select d::date, public.compute_approval_deadline(d::date, 'US'), public.compute_approval_deadline(d::date, 'CA'), public.compute_approval_deadline(d::date)
                     from generate_series('2026-01-01'::date, '2028-12-31'::date, '1 day') d`);
  expect(rows.length).toBeGreaterThan(1000);
  const bad = [];
  for (const [day, us, ca, one] of rows) {
    const js = [calcApprovalDeadline(day).iso, calcApprovalDeadline(day, 7).iso, calcApprovalDeadline(day).iso];
    if (js.join() !== [us, ca, one].join()) bad.push(`${day}: js=${js} db=${[us, ca, one]}`);
  }
  expect(bad.slice(0, 10)).toEqual([]);
});

test('the trigger recomputes approval_deadline when the country changes', () => {
  test.skip(!dbUp, 'local Supabase db container not reachable');
  const out = execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-At', '-c', `
    begin;
    with p as (insert into projects(name) values ('ca-trigger-test') returning id)
    insert into order_intakes(project_id, event_name, event_date, contact_name, contact_email, flag_style, address_line1, city, state_province, postal_code, country)
      select id, 'ct', '2026-12-16', 'n', 'e@example.com', 's', 'a', 'c', 's', '1', 'US' from p returning approval_deadline;
    update order_intakes set country = 'CA' where event_name = 'ct' returning approval_deadline;
    update order_intakes set country = 'US' where event_name = 'ct' returning approval_deadline;
    rollback;`], { encoding: 'utf8' });
  const got = out.split('\n').filter(l => /^\d{4}-\d{2}-\d{2}$/.test(l));
  expect(got).toEqual([calcApprovalDeadline('2026-12-16').iso, calcApprovalDeadline('2026-12-16', 7).iso, calcApprovalDeadline('2026-12-16').iso]);
});

test('save_order_intake records ack_late and ack_rush, defaulting to false', () => {
  test.skip(!dbUp, 'local Supabase db container not reachable');
  const ADDR = '"address_line1":"1 Main","city":"Austin","state_province":"TX","postal_code":"78701"';
  const out = execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', `
    begin;
    insert into projects(id, name) values ('00000000-0000-0000-0000-0000000000f1', 'a1'), ('00000000-0000-0000-0000-0000000000f2', 'a2');
    select save_order_intake('00000000-0000-0000-0000-0000000000f1',
      '{"event_name":"A1","event_date":"2027-03-10","contact_name":"n","contact_email":"e@example.com","flag_style":"s",${ADDR},"ack_late":true,"ack_rush":true}'::jsonb);
    select save_order_intake('00000000-0000-0000-0000-0000000000f2',
      '{"event_name":"A2","event_date":"2027-03-10","contact_name":"n","contact_email":"e@example.com","flag_style":"s",${ADDR}}'::jsonb);
    select 'row', event_name, ack_late, ack_rush from order_intakes where event_name in ('A1', 'A2') order by event_name;
    rollback;`], { encoding: 'utf8' });
  expect(out.split('\n').filter(l => l.startsWith('row|'))).toEqual(['row|A1|t|t', 'row|A2|f|f']);
});

// ── Browser: the order form ───────────────────────────────────────────────────────────
const DRAFT_KEY = 'flagstudio.orderDraft.v1';
const NOON_CHICAGO = '2026-11-16T18:00:00Z';
test.describe('order form', () => {
  test.use({ timezoneId: 'America/Chicago', locale: 'en-US' });

  async function open(page, step, draft = {}) {
    await page.clock.setFixedTime(new Date(NOON_CHICAGO));
    await page.addInitScript(([key, dr]) => {
      localStorage.setItem(key, JSON.stringify({
        step: dr.step, ackBeta: true, eventName: 'Date Step Test', courseName: 'Test GC', eventDate: '', country: 'US',
        contactName: 'A B', contactEmail: 'a@example.com', addressLine1: '1 Main St', city: 'Austin', stateProvince: 'TX', postalCode: '78701',
        // Valid Step 3 too: orderSubmit re-validates Steps 1-3 before the review-step acknowledgments.
        flagStyle: 'plain', flagQty: 18, designNotes: 'Test design', ...dr,
      }));
    }, [DRAFT_KEY, { ...draft, step }]);
    await page.goto('/order.html', { waitUntil: 'domcontentloaded' });
  }
  const callout = page => page.locator('#deliveryAssess .deadline-callout');

  test('step 1 no longer asks for a date', async ({ page }) => {
    await open(page, 1);
    await expect(page.locator('#f-eventName')).toBeVisible();
    await expect(page.locator('#f-courseName')).toBeVisible();
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    await expect(page.getByText('Event Date')).toHaveCount(0);
  });

  test('step 2 has a Delivery group below Shipping, with the date field', async ({ page }) => {
    await open(page, 2);
    const labels = (await page.locator('.order-group > .form-section-label').allTextContents()).map(t => t.trim());
    expect(labels).toEqual(['Contact', 'Shipping', 'Delivery']);
    await expect(page.locator('#f-deliveryDate')).toBeVisible();
    await expect(page.locator('label[for="f-deliveryDate"]')).toContainText('Delivery Date');
    await expect(callout(page)).toHaveCount(0); // nothing until a date is picked
    await expect(page.locator('.order-group:has(#f-deliveryDate) .form-hint')).toHaveCount(0); // no description under the group title
  });

  test('the date picker does not offer a date that cannot be fulfilled (US Nov 26, Canada Dec 3)', async ({ page }) => {
    await open(page, 2);
    await expect(page.locator('#f-deliveryDate')).toHaveAttribute('min', '2026-11-26');
    await open(page, 2, { country: 'CA', stateProvince: 'ON' });
    await expect(page.locator('#f-deliveryDate')).toHaveAttribute('min', '2026-12-03');
  });

  test('a date that cannot be fulfilled is not accepted by hand: the field keeps its value and an orange warning explains', async ({ page }) => {
    await open(page, 2, { eventDate: '2027-03-10' });
    await page.locator('#f-deliveryDate').fill('2026-11-20'); // before Nov 26
    await expect(page.locator('#f-deliveryDate')).toHaveValue('2027-03-10');
    // one tile holds both the notice and the kept date's deadline
    await expect(page.locator('#deliveryAssess .deadline-callout')).toHaveCount(1);
    const tile = page.locator('#deliveryAssess .deadline-callout');
    await expect(tile).toContainText("November 20, 2026 is within the standard production window, flags can't be produced for an on-time delivery for November 20, 2026. We apologize for any inconvenience.");
    await expect(tile).not.toContainText("That date can't be met");
    await expect(tile.locator('[data-use-date]')).toHaveText(['Fastest Delivery: November 26, 2026', 'Avoid Rush Fees: December 3, 2026']);
    // the kept date's approval section (rule, label, date, note) is hidden; only the message, header and buttons remain
    for (const gone of ['.deadline-callout-date', '.deadline-callout-rule', '.delivery-options-title']) await expect(tile.locator(gone)).toHaveCount(0);
    await expect(tile.locator('.deadline-callout-note')).toHaveCount(1); // the message itself
    // the header leads the tile, in orange
    await expect(tile.locator('.deadline-callout-label')).toHaveText('Select a new delivery date');
    expect(await tile.locator('.deadline-callout-label').evaluate(el => getComputedStyle(el).color)).toBe('rgb(217, 119, 6)');
    const order = await tile.evaluate(el => [...el.children].map(c => c.className.split(' ')[0]));
    expect(order.slice(0, 2)).toEqual(['deadline-callout-label', 'deadline-callout-note']);
    // the earliest date itself is fine
    await page.locator('#f-deliveryDate').fill('2026-11-26');
    await expect(page.locator('#f-deliveryDate')).toHaveValue('2026-11-26');
    await expect(page.locator('#deliveryAssess .deadline-callout-label')).toHaveText('Rush Order — Artwork Approval Deadline');
  });

  test('the event sync can still fill in a date that cannot be fulfilled; it is shown with the error tile and the two buttons, and Continue alerts to pick a new date', async ({ page }) => {
    // The sync writes O.eventDate directly (it does not go through the date field's change handler).
    await open(page, 2, { eventDate: '2026-11-20' });
    await expect(page.locator('#f-deliveryDate')).toHaveValue('2026-11-20');
    const tile = page.locator('#deliveryAssess .deadline-callout');
    await expect(tile).toHaveCount(1);
    await expect(tile).toContainText("November 20, 2026 is within the standard production window");
    await expect(tile.locator('[data-use-date]')).toHaveText(['Fastest Delivery: November 26, 2026', 'Avoid Rush Fees: December 3, 2026']);
    await expect(tile.locator('.deadline-callout-alert')).toHaveCount(0); // no nagging until Continue
    await page.evaluate(() => window.orderNext());
    await expect(tile.locator('.deadline-callout-alert')).toHaveText('Please select a new delivery date to continue.');
    await expect(page.locator('.form-field:has(#f-deliveryDate) .form-error')).toHaveCount(0); // orange alert in the tile, not a red error
    await expect(page.locator('#f-deliveryDate')).toBeVisible(); // still on step 2
  });

  test('warnings are orange, not red', async ({ page }) => {
    await open(page, 2, { eventDate: '2026-12-02' }); // US rush
    const color = await page.locator('#deliveryAssess .deadline-callout.rush .deadline-callout-label').evaluate(el => getComputedStyle(el).color);
    expect(color).toBe('rgb(217, 119, 6)');
    const border = await page.locator('#deliveryAssess .deadline-callout.rush').evaluate(el => getComputedStyle(el).borderTopColor);
    expect(border).toBe('rgb(217, 119, 6)');
  });

  for (const [name, draft, label, date, extra] of [
    ['US standard', { eventDate: '2027-03-10' }, 'Artwork Approval Deadline', 'February 21, 2027', 'to avoid a rush fee and ensure an on-time delivery'],
    ['CA standard is a week earlier', { eventDate: '2027-03-10', country: 'CA', stateProvince: 'ON' }, 'Artwork Approval Deadline', 'February 14, 2027', 'Canadian orders include an extra 7 days'],
    ['US deadline is today: still standard, shown as Today', { eventDate: '2026-12-03' }, 'Artwork Approval Deadline', 'Today', null],
    ['US deadline is tomorrow, shown as Tomorrow', { eventDate: '2026-12-04' }, 'Artwork Approval Deadline', 'Tomorrow', null],
    ['US rush', { eventDate: '2026-12-02' }, 'Rush Order — Artwork Approval Deadline', 'November 22, 2026', 'additional $199 rush fee'],
    ['CA rush', { eventDate: '2026-12-09', country: 'CA', stateProvince: 'ON' }, 'Rush Order — Artwork Approval Deadline', 'November 22, 2026', 'additional $199 rush fee'],
  ]) {
    test(`callout: ${name}`, async ({ page }) => {
      await open(page, 2, draft);
      await expect(page.locator('#f-deliveryDate')).toHaveValue(draft.eventDate);
      await expect(callout(page).locator('.deadline-callout-label')).toHaveText(label);
      await expect(callout(page).locator('.deadline-callout-date')).toHaveText(date);
      if (extra) await expect(callout(page)).toContainText(extra);
    });
  }

  test('a date that cannot be met shows the error tile with two full-width buttons; Continue alerts to pick a new date', async ({ page }) => {
    await open(page, 2, { eventDate: '2026-11-25' });
    await expect(page.locator('#deliveryAssess .deadline-callout')).toHaveCount(1);
    await expect(page.locator('#deliveryAssess .deadline-callout-note')).toContainText("November 25, 2026 is within the standard production window");
    for (const gone of ['.deadline-callout-date', '.deadline-callout-rule']) {
      await expect(page.locator(`#deliveryAssess ${gone}`)).toHaveCount(0);
    }
    await expect(page.locator('#deliveryAssess .deadline-callout-label')).toHaveText('Select a new delivery date');
    const buttons = page.locator('#deliveryAssess [data-use-date]');
    await expect(buttons).toHaveText(['Fastest Delivery: November 26, 2026', 'Avoid Rush Fees: December 3, 2026']);
    // full width: each button spans its container
    const [cw, ...bws] = await Promise.all([
      page.locator('#deliveryAssess .delivery-options').evaluate(e => e.getBoundingClientRect().width),
      ...[0, 1].map(i => buttons.nth(i).evaluate(e => e.getBoundingClientRect().width)),
    ]);
    for (const w of bws) expect(w).toBeGreaterThan(cw - 4);
    await page.evaluate(() => window.orderNext());
    await expect(page.locator('#deliveryAssess .deadline-callout-alert')).toHaveText('Please select a new delivery date to continue.');
    await expect(page.locator('.form-field:has(#f-deliveryDate) .form-error')).toHaveCount(0);
    await expect(page.locator('#f-deliveryDate')).toBeVisible(); // still on step 2
  });

  test('"Fastest Delivery" sets the closest rush date and the tile appears with its rush deadline', async ({ page }) => {
    await open(page, 2, { eventDate: '2026-11-20' });
    await page.locator('#deliveryAssess [data-use-date]').first().click();
    await expect(page.locator('#f-deliveryDate')).toHaveValue('2026-11-26');
    await expect(page.locator('#deliveryAssess .deadline-callout-label')).toHaveText('Rush Order — Artwork Approval Deadline');
    await expect(page.locator('#deliveryAssess .deadline-callout-date')).toHaveText('Today');
    await expect(page.locator('#deliveryAssess [data-use-date]')).toHaveCount(0);
  });

  test('"Avoid Rush Fees" sets the earliest standard date and the tile shows a standard deadline', async ({ page }) => {
    await open(page, 2, { eventDate: '2026-11-20' });
    await page.locator('#deliveryAssess [data-use-date]').nth(1).click();
    await expect(page.locator('#f-deliveryDate')).toHaveValue('2026-12-03');
    await expect(page.locator('#deliveryAssess .deadline-callout-label')).toHaveText('Artwork Approval Deadline');
    await expect(page.locator('#deliveryAssess .deadline-callout-date')).toHaveText('Today');
    await expect(page.locator('#deliveryAssess .deadline-callout.rush')).toHaveCount(0);
  });

  test('Canada gets its own two dates', async ({ page }) => {
    await open(page, 2, { eventDate: '2026-11-30', country: 'CA', stateProvince: 'ON' });
    await expect(page.locator('#deliveryAssess [data-use-date]')).toHaveText(['Fastest Delivery: December 3, 2026', 'Avoid Rush Fees: December 10, 2026']);
  });

  test('Continue is blocked without a delivery date', async ({ page }) => {
    await open(page, 2, { eventDate: '' });
    await page.evaluate(() => window.orderNext());
    await expect(page.locator('.form-field:has(#f-deliveryDate) .form-error')).toHaveText('Delivery date is required.');
  });

  test('changing the date updates the callout in place; switching to Canada recalculates it', async ({ page }) => {
    await open(page, 2, { eventDate: '2027-03-10' });
    await expect(callout(page).locator('.deadline-callout-date')).toHaveText('February 21, 2027');
    await page.locator('#f-deliveryDate').fill('2026-12-02');
    await expect(callout(page).locator('.deadline-callout-label')).toHaveText('Rush Order — Artwork Approval Deadline');
    await expect(callout(page).locator('.deadline-callout-date')).toHaveText('November 22, 2026');
    await page.locator('#f-deliveryDate').fill('2027-03-10');
    await page.evaluate(() => window.selectCountry('CA'));
    await expect(page.locator('#f-deliveryDate')).toHaveValue('2027-03-10'); // the date survives the country switch
    await expect(callout(page).locator('.deadline-callout-date')).toHaveText('February 14, 2027');
    await expect(callout(page)).toContainText('Canadian orders include an extra 7 days');
  });

  test('review step: Delivery section with the date and approval deadline; acknowledgment says 24 days for Canada', async ({ page }) => {
    await open(page, 5, { eventDate: '2027-03-10', country: 'CA', stateProvince: 'ON' });
    const titles = (await page.locator('.rs-section-title').allTextContents()).map(t => t.trim());
    expect(titles.slice(0, 3)).toEqual(['Event Details', 'Contact & Shipping', 'Delivery']);
    const delivery = page.locator('.rs-section:has(.rs-section-title:text-is("Delivery"))');
    await expect(delivery).toContainText('Delivery DateMarch 10, 2027');
    await expect(delivery).toContainText('Artwork approval dueFebruary 14, 2027');
    await expect(page.locator('.rs-section:has(.rs-section-title:text-is("Event Details"))')).not.toContainText('Event Date');
    await expect(page.locator('#f-ackDeadline .ack-text')).toContainText('approved by February 14, 2027 for my flags to arrive by my delivery date on March 10, 2027');
  });

  for (const [name, eventDate, expected] of [
    ['Thu event', '2026-12-17', '2026-12-15'],
    ['Mon event skips the weekend', '2026-12-14', '2026-12-10'],
    ['Sat event', '2026-12-12', '2026-12-10'],
  ]) {
    test(`event sync: ${name} defaults the delivery date to two business days before`, async ({ page }) => {
      await page.route('**/functions/v1/sync-event-info', route => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ eventName: 'Synced Open', courseName: 'Synced GC', eventDate }) }));
      await page.clock.setFixedTime(new Date(NOON_CHICAGO));
      await page.goto('/order.html', { waitUntil: 'domcontentloaded' });
      await page.locator('.ack-item').click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.locator('#f-syncUrl').fill('https://events.golfstatus.com/synced');
      await page.locator('#syncBtn').click();
      await expect(page.locator('#f-deliveryDate')).toHaveValue(expected); // a good sync lands on step 2
    });
  }

  test('event sync: a synced event too close to fulfil is still plugged in, with the buttons to pick another date', async ({ page }) => {
    await page.route('**/functions/v1/sync-event-info', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ eventName: 'Synced Open', courseName: 'Synced GC', eventDate: '2026-11-23' }) })); // Mon -> Thu Nov 19, before Nov 26
    await page.clock.setFixedTime(new Date(NOON_CHICAGO));
    await page.goto('/order.html', { waitUntil: 'domcontentloaded' });
    await page.locator('.ack-item').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.locator('#f-syncUrl').fill('https://events.golfstatus.com/synced');
    await page.locator('#syncBtn').click();
    await expect(page.locator('#f-deliveryDate')).toHaveValue('2026-11-19');
    await expect(page.locator('#deliveryAssess [data-use-date]')).toHaveCount(2);
  });

  const weekendNote = page => page.locator('#deliveryWeekendNote');

  for (const [name, picked] of [['Saturday', '2026-12-12'], ['Sunday', '2026-12-13']]) {
    test(`a ${name} pick moves to the preceding Friday, with a note under the date input`, async ({ page }) => {
      await open(page, 2, { eventDate: '2027-03-10' });
      await page.locator('#f-deliveryDate').fill(picked);
      await expect(page.locator('#f-deliveryDate')).toHaveValue('2026-12-11');
      await expect(weekendNote(page)).toHaveText("Delivery isn't available on weekends, so your delivery date has been moved to the preceding Friday, December 11, 2026.");
      // sits directly under the input's field, above the tile
      const [fieldBottom, noteTop, tileTop] = await Promise.all([
        page.locator('.form-field:has(#f-deliveryDate)').evaluate(e => e.getBoundingClientRect().bottom),
        weekendNote(page).evaluate(e => e.getBoundingClientRect().top),
        page.locator('#deliveryAssess').evaluate(e => e.getBoundingClientRect().top),
      ]);
      expect(noteTop).toBeGreaterThanOrEqual(fieldBottom - 8);
      expect(noteTop).toBeLessThan(tileTop);
      // the tile is for the Friday: Dec 11 - 17 days = Nov 24, a standard deadline
      await expect(page.locator('#deliveryAssess .deadline-callout-date')).toHaveText('November 24, 2026');
    });
  }

  test('the weekend note goes away on the next weekday pick, and is empty by default', async ({ page }) => {
    await open(page, 2, { eventDate: '2027-03-10' });
    await expect(weekendNote(page)).toBeEmpty();
    await page.locator('#f-deliveryDate').fill('2026-12-12');
    await expect(weekendNote(page)).not.toBeEmpty();
    await page.locator('#f-deliveryDate').fill('2026-12-15');
    await expect(weekendNote(page)).toBeEmpty();
    await expect(page.locator('#f-deliveryDate')).toHaveValue('2026-12-15');
  });

  test('a weekend pick whose Friday is too early to fulfil is rejected like any other early date', async ({ page }) => {
    await open(page, 2, { eventDate: '2027-03-10' });
    await page.locator('#f-deliveryDate').fill('2026-11-22'); // Sunday -> Friday Nov 20, before Nov 26
    await expect(page.locator('#f-deliveryDate')).toHaveValue('2027-03-10');
    await expect(weekendNote(page)).toContainText('moved to the preceding Friday');
    await expect(page.locator('#deliveryAssess .delivery-options-title, #deliveryAssess .deadline-callout-label').first()).toHaveText('Select a new delivery date');
  });

  // ── Review step acknowledgments ─────────────────────────────────────────────
  const ackItems = page => page.locator('.review-ack-group [data-ack], .review-ack-group #f-ackDeadline');

  test('review: a standard order with no event date known has just the deadline acknowledgment', async ({ page }) => {
    await open(page, 5, { eventDate: '2027-03-10' });
    await expect(page.locator('#f-ackDeadline')).toBeVisible();
    await expect(page.locator('[data-ack]')).toHaveCount(0);
  });

  test('review: a rush order adds the rush fee acknowledgment, which must be ticked to submit', async ({ page }) => {
    await open(page, 5, { eventDate: '2026-12-02', ackDeadline: true });
    const rush = page.locator('[data-ack="ackRush"]');
    await expect(rush).toContainText('rush order and will incur an additional $199 rush fee');
    await expect(page.locator('[data-ack="ackLate"]')).toHaveCount(0);
    await page.evaluate(() => window.orderSubmit()); // validation fails first, so nothing is sent
    await expect(page.getByText('Please accept the $199 rush fee to submit your order.')).toBeVisible();
    await rush.click();
    await expect(page.locator('[data-ack="ackRush"]')).toHaveClass(/checked/);
  });

  test('review: with the event known, a delivery date right before it adds the late acknowledgment', async ({ page }) => {
    await open(page, 5, { eventDate: '2027-03-09', syncedEventDate: '2027-03-10', ackDeadline: true });
    await expect(page.locator('[data-ack="ackLate"]')).toContainText('later than our standard delivery date of March 8, 2027');
    await page.evaluate(() => window.orderSubmit());
    await expect(page.getByText('Please acknowledge the delivery date.')).toBeVisible();
  });

  test('review: a delivery date after the event uses the after-event wording', async ({ page }) => {
    await open(page, 5, { eventDate: '2027-03-11', syncedEventDate: '2027-03-10' });
    await expect(page.locator('[data-ack="ackLate"]')).toContainText('after my event on March 10, 2027, and will not be available for the event');
  });

  test('review: rush and late can both show, and each toggles on its own', async ({ page }) => {
    await open(page, 5, { eventDate: '2026-12-03', syncedEventDate: '2026-12-04' }); // standard (deadline today) but late for the event
    await expect(page.locator('[data-ack="ackRush"]')).toHaveCount(0);
    await expect(page.locator('[data-ack="ackLate"]')).toBeVisible();
    await open(page, 5, { eventDate: '2026-12-02', syncedEventDate: '2026-12-02' }); // rush and after standard delivery
    await expect(page.locator('[data-ack="ackRush"]')).toBeVisible();
    await expect(page.locator('[data-ack="ackLate"]')).toBeVisible();
    await page.locator('[data-ack="ackLate"]').click();
    await expect(page.locator('[data-ack="ackLate"]')).toHaveClass(/checked/);
    await expect(page.locator('[data-ack="ackRush"]')).not.toHaveClass(/checked/);
  });

  test('changing the delivery date clears the acknowledgments, since they no longer apply', async ({ page }) => {
    await open(page, 2, { eventDate: '2026-12-02', ackDeadline: true, ackRush: true, ackLate: true, syncedEventDate: '2026-12-02' });
    await page.locator('#f-deliveryDate').fill('2027-03-10');
    await page.getByRole('button', { name: 'Back' }).click(); // a re-render saves the draft
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('flagstudio.orderDraft.v1')));
    expect([saved.ackDeadline, saved.ackRush, saved.ackLate]).toEqual([false, false, false]);
  });
});
