import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// "Reuse Past Design" on the order form's Flag & Colors step: a light intake (event name, quantity,
// what needs to change) that skips the style, color and front/back pickers.

const DRAFT_KEY = 'flagstudio.orderDraft.v1';
const BASE = {
  ackBeta: true, eventName: 'Repeat Test', courseName: 'Test GC', eventDate: '2027-03-10', country: 'US',
  contactName: 'A B', contactEmail: 'a@example.com', addressLine1: '1 Main St', city: 'Austin', stateProvince: 'TX', postalCode: '78701',
};
async function open(page, step, draft = {}) {
  await page.addInitScript(([key, d]) => localStorage.setItem(key, JSON.stringify(d)), [DRAFT_KEY, { ...BASE, step, ...draft }]);
  await page.goto('/order.html', { waitUntil: 'domcontentloaded' });
}

test.describe('order form', () => {
  test('the Flag & Colors step opens on New Design, with the toggle above the existing pickers', async ({ page }) => {
    await open(page, 3);
    await expect(page.locator('.setup-btn.active').first()).toHaveText('New Design');
    await expect(page.locator('.setup-btn').filter({ hasText: 'Reuse Past Design' })).toBeVisible();
    await expect(page.getByText('Flag setup')).toBeVisible();      // the normal form is intact
    await expect(page.locator('#f-repeatEvent')).toHaveCount(0);
  });

  test('Reuse Past Design shows only event name, quantity and changes needed', async ({ page }) => {
    await open(page, 3, { designSource: 'repeat' });
    await expect(page.locator('#f-repeatEvent')).toBeVisible();
    await expect(page.locator('label[for="f-notes"]')).toContainText('Changes needed');
    await expect(page.locator('.qty-toggle')).toBeVisible();
    for (const gone of ['Flag setup', 'Flag Design - Front']) await expect(page.getByText(gone)).toHaveCount(0);
    await expect(page.locator('.flag-style-picker, #f-frontNotes')).toHaveCount(0);
  });

  test('clicking the toggle switches between the two forms', async ({ page }) => {
    await open(page, 3);
    await page.getByRole('button', { name: 'Reuse Past Design' }).click();
    await expect(page.locator('#f-repeatEvent')).toBeVisible();
    await page.getByRole('button', { name: 'New Design' }).click();
    await expect(page.locator('#f-repeatEvent')).toHaveCount(0);
    await expect(page.getByText('Flag setup')).toBeVisible();
  });

  test('a reuse order requires the past event name, a quantity and the changes (but no flag style)', async ({ page }) => {
    await open(page, 3, { designSource: 'repeat', repeatEventName: '', flagQty: 0, designNotes: '' });
    await page.evaluate(() => window.orderNext()); // fails validation, so nothing is saved
    await expect(page.getByText('Please tell us which event this design was used for.')).toBeVisible();
    await expect(page.getByText('Please select a quantity.')).toBeVisible();
    await expect(page.getByText('Please describe the changes needed (or enter "No changes").')).toBeVisible();
    await expect(page.getByText('Please select a flag style.')).toHaveCount(0);
  });

  test('review step shows the reuse rows instead of style, colors and setup', async ({ page }) => {
    await open(page, 5, { designSource: 'repeat', repeatEventName: '2025 Member-Guest', flagQty: 18, designNotes: 'New sponsors' });
    const section = page.locator('.rs-section:has(.rs-section-title:text-is("Flag & Colors"))');
    await expect(section).toContainText('DesignReuse Past Design');
    await expect(section).toContainText('Event Name2025 Member-Guest');
    await expect(section).toContainText('Quantity18 Flags');
    await expect(section).toContainText('Changes neededNew sponsors');
    for (const gone of ['Flag Setup', 'Flag Design']) await expect(section).not.toContainText(gone);
  });

  test('the logo step asks for last year\'s design on a reuse order', async ({ page }) => {
    await open(page, 4, { designSource: 'repeat' });
    await expect(page.locator('.order-sub')).toContainText("Upload last year's flag design");
    await open(page, 4, { designSource: 'new' });
    await expect(page.locator('.order-sub')).not.toContainText("last year's flag design");
  });
});

// ── Database ──────────────────────────────────────────────────────────────────────────
const DB = process.env.DB_CONTAINER || 'supabase_db_flag-studio';
const psql = sql => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
let dbUp = true;
try { psql('select 1'); } catch { dbUp = false; }

test('save_order_intake persists design_source and repeat_event_name; they default to a new design', () => {
  test.skip(!dbUp, 'local Supabase db container not reachable');
  const out = psql(`
    begin;
    insert into projects(id, name) values ('00000000-0000-0000-0000-0000000000e1', 'rp'), ('00000000-0000-0000-0000-0000000000e2', 'rp2');
    select save_order_intake('00000000-0000-0000-0000-0000000000e1',
      '{"event_name":"E","address_line1":"1 Main","city":"Austin","state_province":"TX","postal_code":"78701","event_date":"2027-03-10","contact_name":"n","contact_email":"e@example.com","flag_style":"plain","flag_setup":"same","design_source":"repeat","repeat_event_name":"2025 Member-Guest","design_notes":"New sponsors"}'::jsonb);
    select save_order_intake('00000000-0000-0000-0000-0000000000e2',
      '{"event_name":"E2","address_line1":"1 Main","city":"Austin","state_province":"TX","postal_code":"78701","event_date":"2027-03-10","contact_name":"n","contact_email":"e@example.com","flag_style":"classic"}'::jsonb);
    select 'row', project_id::text, design_source, coalesce(repeat_event_name, '-'), coalesce(design_notes, '-') from order_intakes where event_name in ('E', 'E2') order by event_name;
    rollback;`);
  const rows = out.split('\n').filter(l => l.startsWith('row|'));
  expect(rows).toEqual([
    'row|00000000-0000-0000-0000-0000000000e1|repeat|2025 Member-Guest|New sponsors',
    'row|00000000-0000-0000-0000-0000000000e2|new|-|-',
  ]);
});

test('design_source only allows new or repeat', () => {
  test.skip(!dbUp, 'local Supabase db container not reachable');
  expect(() => psql(`begin; insert into projects(id, name) values ('00000000-0000-0000-0000-0000000000e3', 'rp3');
    insert into order_intakes(project_id, event_name, event_date, contact_name, contact_email, flag_style, address_line1, city, state_province, postal_code, design_source)
      values ('00000000-0000-0000-0000-0000000000e3', 'x', '2027-03-10', 'n', 'e@example.com', 's', 'a', 'c', 's', '1', 'bogus'); rollback;`)).toThrow();
});
