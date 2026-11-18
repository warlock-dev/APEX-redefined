// Browser tests of the real app in Chromium, running on this device only (no Firebase configured).
// Cloud sync is tested in tests/sync.test.mjs against an in-memory fake of the same interface.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startServer } from '../scripts/serve.mjs';

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = pw.chromium ?? pw.default?.chromium;
const EXE = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let server;
let base;
let browser;
before(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
});
after(async () => { await browser?.close(); server?.close(); });

async function openApp(context, hash = '#/today') {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|accounts\.google/.test(m.text())) problems.push(m.text()); });
  await page.goto(`${base}${hash}`);
  await page.locator('#main').waitFor();
  return { page, problems };
}

const quickAdd = async (page, text) => {
  await page.locator('#quick').fill(text);
  await page.locator('form.quick button[type=submit]').first().click();
};

test('the More screen works without Firebase set up, and says sync is not set up yet', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, problems } = await openApp(context, '#/more');
  await page.getByText('Account and sync').waitFor();
  await page.getByText('Sign-in and sync are not set up yet').waitFor();
  assert.equal(problems.length, 0, problems.join('\n'));
  await context.close();
});

test('a day from start to close: add, time, finish, plan, close, and it is still there after a reload', async () => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, timezoneId: 'Asia/Kolkata' });
  const { page, problems } = await openApp(context);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'quick', 'quick add is ready on open');
  await page.getByText('Nothing planned yet.').waitFor();
  await quickAdd(page, 'Read Newton 45m');
  await page.locator('.now-title', { hasText: 'Read Newton' }).waitFor();
  assert.match(await page.locator('.now').innerText(), /planned 45m/);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Pause' }).waitFor();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByText('Everything planned is done.').waitFor();
  assert.match(await page.locator('#summary').innerText(), /1 of 1 done/);

  await page.locator('#nav a[data-nav=close]').click();
  await page.getByRole('heading', { name: 'Close the day' }).waitFor();
  const closeBtn = page.getByRole('button', { name: 'Close the day' });
  assert.equal(await closeBtn.isDisabled(), true, 'needs a verdict first');
  await page.getByRole('button', { name: 'Did what I planned' }).click();
  await closeBtn.click();
  await page.getByRole('heading', { name: 'Today' }).count();
  await page.getByText('Everything planned is done.').waitFor();
  await page.reload();
  await page.getByText('Everything planned is done.').waitFor();
  assert.equal(problems.length, 0, problems.join('\n'));
  await context.close();
});

test('a syllabus: create a track, paste topics with subtopics, learn one, and it is scheduled for review', async () => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const { page, problems } = await openApp(context, '#/tracks');
  await page.locator('#track-name').fill('Physics for the exam');
  await page.getByRole('button', { name: 'Create track' }).click();
  await page.getByRole('link', { name: /Physics for the exam/ }).click();
  await page.getByText('Paste a syllabus or list').click();
  await page.locator('#outline').fill("1. Mechanics\n  - Newton's laws\n  - Friction\n2. Optics\n  - Lenses");
  await page.getByRole('button', { name: 'Add these topics' }).click();
  await page.getByText('Added 5 topics.').waitFor();
  const newton = page.locator('li.node', { hasText: "Newton's laws" });
  await newton.getByRole('button', { name: /Learned: Newton/ }).click();
  await page.getByText(/Learned · next review in 1 day/).waitFor();
  assert.equal(await page.locator('li.node', { hasText: 'Friction' }).getByRole('button', { name: /Learned/ }).count(), 1, 'an untouched subtopic can still be learned');
  await page.reload();
  await page.getByText(/Learned · next review in 1 day/).waitFor();
  assert.equal(problems.length, 0, problems.join('\n'));
  await context.close();
});

test('an unfinished task moves to the next day on its own, and remembers where it came from', async () => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const { page, problems } = await openApp(context);
  await quickAdd(page, 'Leftover 10m');
  await page.locator('.now-title', { hasText: 'Leftover' }).waitFor();
  await context.addInitScript(() => { /* nothing: the roll runs on each day change */ });
  await page.evaluate(() => {
    const raw = localStorage.getItem('apex2:data');
    const doc = JSON.parse(raw);
    // Three days back: the app's day starts at 04:00, so "yesterday" can still be today for the app.
    const yesterday = new Date(Date.now() - 3 * 86400000);
    const key = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    doc.tasks.forEach((t) => { t.date = key; });
    localStorage.setItem('apex2:data', JSON.stringify(doc));
  });
  await page.reload();
  await page.getByText(/Carried over from/).waitFor();
  assert.equal(problems.length, 0, problems.join('\n'));
  await context.close();
});

test('the phone layout has no sideways scrolling on any screen', async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const { page, problems } = await openApp(context);
  await quickAdd(page, 'A rather long task title that has to wrap somewhere sensible on a small phone screen 25m');
  for (const route of ['today', 'tracks', 'close', 'progress', 'more']) {
    await page.evaluate((r) => { location.hash = `#/${r}`; }, route);
    await page.waitForTimeout(120);
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.equal(w.sw, w.cw, `no horizontal scroll on ${route}`);
  }
  assert.equal(problems.length, 0, problems.join('\n'));
  await context.close();
});
