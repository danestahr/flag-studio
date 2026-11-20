import { test, expect } from '@playwright/test';

// Stress test for "customer selections aren't saved / don't reach the design studio".
// Runs against the LOCAL Supabase (see .env.local) — creates throwaway local projects only.
// All contact emails use dane@danestahr.com (never a real customer address).

const SB = 'http://127.0.0.1:54321';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const EMAIL = 'dane@danestahr.com';

// A weekday ~100 days out so the delivery date is always "standard" (no rush/late acks).
function futureWeekday() {
  const d = new Date(Date.now() + 100 * 864e5);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const DRAFT_KEY = 'flagstudio.orderDraft.v1';
const readDraft = page => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), DRAFT_KEY);

// Server-side view of the intake, exactly as the "resume" link sees it (anon RPC).
async function serverIntake(request, projectId) {
  const res = await request.post(`${SB}/rest/v1/rpc/get_order_intake_for_resume`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    data: { p_project_id: projectId },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function startOnStep1(page) {
  await page.addInitScript(([k]) => {
    if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ ackBeta: true, step: 1 }));
  }, [DRAFT_KEY]);
  await page.goto('/order.html');
  await expect(page.locator('#f-eventName')).toBeVisible();
}

async function completeSteps1and2(page) {
  await page.fill('#f-eventName', 'Stress Test Open');
  await page.fill('#f-courseName', 'Stress Test GC');
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.fill('#f-contactName', 'Stress Tester');
  await page.fill('#f-contactEmail', EMAIL);
  await page.fill('#f-addr1', '1 Fairway Dr');
  await page.fill('#f-city', 'Augusta');
  await page.selectOption('#f-state', 'GA');
  await page.fill('#f-postal', '30901');
  await page.fill('#f-deliveryDate', futureWeekday());
  await page.locator('#f-deliveryDate').dispatchEvent('change');
  await page.getByRole('button', { name: /Continue/ }).click();
  await expect(page.locator('.order-step-title, .order-title').first()).toBeVisible();
}

test('draft keeps text typed right before a refresh (no blur / re-render)', async ({ page }) => {
  await startOnStep1(page);
  await page.fill('#f-eventName', 'Typed Then Refreshed');
  await page.fill('#f-courseName', 'Quick Close GC');
  await page.reload();
  await expect(page.locator('#f-eventName')).toHaveValue('Typed Then Refreshed');
  await expect(page.locator('#f-courseName')).toHaveValue('Quick Close GC');
});

test('custom quantity typed then refreshed is kept', async ({ page }) => {
  await startOnStep1(page);
  await completeSteps1and2(page);
  await page.evaluate(() => window.selectQtyCustom());
  await page.fill('#f-qty', '45');
  await page.reload();
  await expect(page.locator('#f-qty')).toHaveValue('45');
});

test('design notes typed on step 3 survive a refresh', async ({ page }) => {
  await startOnStep1(page);
  await completeSteps1and2(page);
  await page.fill('#f-notes', 'Please use our club crest in the center');
  await page.reload();
  await expect(page.locator('#f-notes')).toHaveValue('Please use our club crest in the center');
});

test('step 3 selections reach the server when the customer clicks Continue', async ({ page, request }) => {
  await startOnStep1(page);
  await completeSteps1and2(page);
  await page.evaluate(() => { window.selectFlagStyle('plain'); window.selectQty(18); });
  await page.fill('#f-notes', 'Navy flag with white lettering');
  await page.getByRole('button', { name: /Continue/ }).click();           // → step 4
  const draft = await readDraft(page);
  expect(draft.projectId).toBeTruthy();
  // The save is async (best-effort) after the click, so poll rather than read once.
  await expect.poll(async () => (await serverIntake(request, draft.projectId))?.design_notes).toBe('Navy flag with white lettering');
  const row = await serverIntake(request, draft.projectId);
  expect(row.flag_style).toBe('plain');
  expect(row.flag_qty).toBe(18);
});

test('resume link in a fresh browser restores step 3 selections', async ({ page, browser }) => {
  await startOnStep1(page);
  await completeSteps1and2(page);
  await page.evaluate(() => { window.selectFlagStyle('plain'); window.selectQty(27); });
  await page.fill('#f-notes', 'Resume me');
  await page.getByRole('button', { name: /Continue/ }).click();
  const { projectId } = await readDraft(page);

  const ctx = await browser.newContext();            // no localStorage = "different device"
  const p2 = await ctx.newPage();
  await p2.goto(`/order.html?resume=${projectId}`);
  await expect(p2.locator('#f-notes')).toHaveValue('Resume me');
  const draft2 = await readDraft(p2);
  expect(draft2.flagQty).toBe(27);
  expect(draft2.flagStyle).toBe('plain');
  await ctx.close();
});

test('dev-only reset button is not shown to customers', async ({ page }) => {
  await startOnStep1(page);
  await expect(page.locator('#devResetBtn')).toBeHidden();
});

test('resume link in a window whose draft is stale backfills step 3 from the server', async ({ page }) => {
  await startOnStep1(page);
  await completeSteps1and2(page);
  await page.evaluate(() => { window.selectFlagStyle('plain'); window.selectQty(18); });
  await page.fill('#f-notes', 'Server has this');
  await page.getByRole('button', { name: /Continue/ }).click();      // saved to the server
  const { projectId } = await readDraft(page);
  await expect.poll(async () => (await serverIntake(page.request, projectId))?.design_notes).toBe('Server has this');

  // Make this browser's draft look like the customer's stale one: same project, step 3 blank.
  // (Planted via an init script: the old page's pagehide autosave would otherwise overwrite it.)
  const stale = { ...(await readDraft(page)), step: 3, flagStyle: '', flagQty: 0, designNotes: '' };
  await page.addInitScript(([k, d]) => localStorage.setItem(k, JSON.stringify(d)), [DRAFT_KEY, stale]);
  await page.goto(`/order.html?resume=${projectId}`);
  await expect(page.locator('#f-notes')).toHaveValue('Server has this');
  await expect(page.locator('.qty-btn.active')).toHaveText('18');
  await expect(page.locator('.flag-selected-preview')).toBeVisible();
});

test('resume backfill never overwrites what the draft already has', async ({ page }) => {
  await startOnStep1(page);
  await completeSteps1and2(page);
  await page.evaluate(() => { window.selectFlagStyle('plain'); window.selectQty(18); });
  await page.fill('#f-notes', 'Server version');
  await page.getByRole('button', { name: /Continue/ }).click();
  const { projectId } = await readDraft(page);
  await expect.poll(async () => (await serverIntake(page.request, projectId))?.design_notes).toBe('Server version');
  const local = { ...(await readDraft(page)), step: 3, flagQty: 36, designNotes: 'Local version' };
  await page.addInitScript(([k, d]) => localStorage.setItem(k, JSON.stringify(d)), [DRAFT_KEY, local]);
  await page.goto(`/order.html?resume=${projectId}`);
  await expect(page.locator('#f-notes')).toHaveValue('Local version');
  await expect(page.locator('.qty-btn.active')).toHaveText('36');
});

test('step 3 picks reach the server on their own, without clicking Continue', async ({ page, request }) => {
  await startOnStep1(page);
  await completeSteps1and2(page);
  // The project is created asynchronously when Step 2's Continue is saved; wait for its id.
  await expect.poll(async () => (await readDraft(page)).projectId).toBeTruthy();
  const { projectId } = await readDraft(page);
  await page.evaluate(() => { window.selectFlagStyle('plain'); window.selectQty(27); });
  await page.fill('#f-notes', 'Autosaved without Continue');
  // No Continue / Back: the debounced autosave alone must put these on the server.
  await expect.poll(async () => (await serverIntake(request, projectId))?.design_notes, { timeout: 3000 }).toBe('Autosaved without Continue');   // well under the old 1.5s+ wait
  const row = await serverIntake(request, projectId);
  expect(row.flag_style).toBe('plain');
  expect(row.flag_qty).toBe(27);
});

test('merely opening a resume link does not write to the server', async ({ page, browser, request }) => {
  await startOnStep1(page);
  await completeSteps1and2(page);
  await page.evaluate(() => { window.selectFlagStyle('plain'); window.selectQty(18); });
  await page.getByRole('button', { name: /Continue/ }).click();
  const { projectId } = await readDraft(page);
  await expect.poll(async () => (await serverIntake(request, projectId))?.flag_qty).toBe(18);

  // A different device with a stale draft for the same project must not clobber the server on load.
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.addInitScript(([k, d]) => localStorage.setItem(k, JSON.stringify(d)), [DRAFT_KEY, { ...(await readDraft(page)), step: 3, flagQty: 36, flagStyle: '', designNotes: '' }]);
  await p2.goto(`/order.html?resume=${projectId}`);
  await p2.waitForTimeout(3500);   // longer than the autosave debounce
  expect((await serverIntake(request, projectId)).flag_qty).toBe(18);
  await ctx.close();
});
