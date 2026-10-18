import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(appDir, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inqurix-e2e-'));
const docs = path.join(tmp, 'Documents');
const shots = path.join(root, '.e2e/screens');
const hasXdotool = spawnSync('which', ['xdotool']).status === 0;
let app: ElectronApplication;
let ws: Page;
let quick: Page;
const externalRequests: string[] = [];

async function pageFor(hash: string): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const p = app.windows().find((w) => w.url().includes(`#${hash}`));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`window ${hash} not found`);
}
const quickVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#quick'))?.isVisible() ?? false);

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  execFileSync(process.execPath, [path.join(root, 'scripts/generate-fixtures.mjs'), docs]);
  app = await electron.launch({ args: [appDir, '--no-sandbox'], env: { ...process.env, INQURIX_USER_DATA: path.join(tmp, 'userdata'), INQURIX_E2E_KEEP_QUICK: '1' } });
  app.on('window', (p) => p.on('request', (r) => { if (!/^(file|devtools|data|chrome-extension):/.test(r.url())) externalRequests.push(r.url()); }));
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[]; __revealed: string[] };
    g.__opened = []; g.__revealed = [];
    shell.openPath = async (p: string) => { g.__opened.push(p); return ''; };
    shell.showItemInFolder = (p: string) => { g.__revealed.push(p); };
  });
  ws = await pageFor('workspace');
  quick = await pageFor('quick');
});

test.afterAll(async () => { await app?.close(); });

test('onboarding: authorise a folder and index it', async () => {
  await expect(ws.getByRole('heading', { name: /Find information without remembering/ })).toBeVisible();
  await ws.getByRole('button', { name: 'Get started' }).click();
  await expect(ws.getByRole('heading', { name: 'Choose folders to search' })).toBeVisible();
  await ws.evaluate((d) => window.inqurix.invoke('sources:add', d), docs);
  await expect.poll(async () => {
    const s = await ws.evaluate(() => window.inqurix.invoke<{ counts: { status: string; n: number }[] }>('index:status'));
    const pending = s.counts.filter((c) => ['queued', 'processing', 'discovered'].includes(c.status)).reduce((a, c) => a + c.n, 0);
    const done = s.counts.filter((c) => c.status === 'indexed').reduce((a, c) => a + c.n, 0);
    return pending === 0 ? done : 0;
  }, { timeout: 120_000 }).toBeGreaterThanOrEqual(12);
  await expect(ws.getByText(docs)).toBeVisible();
  await ws.screenshot({ path: path.join(shots, '01-onboarding-folder.png') });
  await ws.getByRole('button', { name: 'Continue' }).click();
  await ws.getByRole('button', { name: 'Start searching' }).click();
  await expect(ws.getByRole('textbox', { name: 'Search' })).toBeVisible();
});

test('quick search finds content, navigates, opens, reveals and closes', async () => {
  if (!(await quickVisible())) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#quick'))?.show());
  const input = quick.getByRole('textbox', { name: 'Search your documents' });
  await input.fill('renegotiate paper pricing');
  const first = quick.getByRole('option').first();
  await expect(first).toContainText('board-meeting-2026-03.pptx');
  await expect(first).toContainText('slide 2');
  await quick.screenshot({ path: path.join(shots, '02-quick-search.png') });
  await input.fill('INV-1048');
  await expect(quick.getByRole('option').first()).toContainText(/INV-1048|invoice 1048/);
  await input.press('ArrowDown');
  await expect(quick.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowUp');
  await expect(quick.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await input.press('Control+Enter');
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __revealed: string[] }).__revealed.length)).toBe(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#quick'))?.show());
  await input.press('Enter');
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened[0] ?? '')).toMatch(/1048/);
  expect(await quickVisible()).toBe(false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#quick'))?.show());
  await input.press('Control+Backspace');
  await expect(input).toHaveValue('');
  await input.press('Escape');
  await expect.poll(quickVisible).toBe(false);
});

test('workspace search shows evidence, explanation, extracted fields and related documents', async () => {
  await ws.getByRole('textbox', { name: 'Search' }).fill('14,317.50');
  const panel = ws.getByRole('region', { name: 'Document evidence' });
  await expect(panel.getByRole('heading', { name: 'Why this matched' })).toBeVisible();
  await expect(panel).toContainText('Contains the amount');
  await ws.getByRole('textbox', { name: 'Search' }).fill('invoice INV-1048');
  await expect(panel.getByRole('heading', { level: 2 })).toContainText(/1048/);
  await expect(panel).toContainText('Kavango Office Supplies');
  await expect(panel.getByRole('heading', { name: 'Related documents' })).toBeVisible();
  await ws.screenshot({ path: path.join(shots, '03-workspace-evidence.png') });
});

test('new and deleted files are reflected by the watcher', async () => {
  const f = path.join(docs, 'watcher-note.txt');
  fs.writeFileSync(f, 'Oryx fencing contract signed with Gobabis Agri Supplies');
  const search = (q: string) => ws.evaluate((qq) => window.inqurix.invoke<{ results: { name: string }[] }>('search', { query: qq }).then((r) => r.results.map((x) => x.name)), q);
  await expect.poll(() => search('oryx fencing'), { timeout: 30_000 }).toContain('watcher-note.txt');
  fs.rmSync(f);
  await expect.poll(() => search('oryx fencing'), { timeout: 30_000 }).not.toContain('watcher-note.txt');
});

test('sources page lists failures and the exe is never indexed', async () => {
  await ws.getByRole('button', { name: 'Sources & indexing' }).click();
  await expect(ws.getByRole('heading', { name: 'Files needing attention' })).toBeVisible();
  await expect(ws.getByRole('cell', { name: /Documents/ }).first()).toBeVisible();
  await expect(ws.getByText('program.exe')).toHaveCount(0);
  await ws.screenshot({ path: path.join(shots, '04-sources.png') });
});

test('quick search opens with the global shortcut and is keyboard driven', async () => {
  test.skip(!hasXdotool, 'xdotool not installed');
  expect(await quickVisible()).toBe(false);
  execFileSync('xdotool', ['key', 'ctrl+shift+space']);
  await expect.poll(quickVisible).toBe(true);
  await expect(quick.getByRole('textbox', { name: 'Search your documents' })).toBeFocused();
});

test('no network requests were made by the UI', () => {
  expect(externalRequests.filter((u) => !u.startsWith('http://localhost'))).toEqual([]);
});
