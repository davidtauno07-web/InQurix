import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { now, openDatabase, type DB } from './db/index.js';
import { SearchEngine } from './search/engine.js';
import { createEmbedder, type Embedder } from './search/embed.js';
import { SettingsStore, type Settings } from './settings.js';
import { registerIpc } from './ipc.js';
import type { WorkerOut } from './indexer/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.env.INQURIX_USER_DATA) app.setPath('userData', path.resolve(process.env.INQURIX_USER_DATA));
if (!app.requestSingleInstanceLock()) app.quit();

const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../resources');
const userData = app.getPath('userData');
const settings = new SettingsStore(path.join(userData, 'settings.json'));
const dbPath = path.join(userData, 'index.db');
let quick: BrowserWindow | undefined;
let workspace: BrowserWindow | undefined;
let tray: Tray | undefined;
let worker: ChildProcess | undefined;
let embedder: Embedder | undefined;
let quitting = false;
let indexPaused = false;

const modelsDir = path.join(resources, 'models');
const tessdata = [path.join(resources, 'tessdata'), '/usr/share/tesseract-ocr/5/tessdata', '/usr/share/tesseract-ocr/4.00/tessdata'].find((d) => fs.existsSync(path.join(d, 'eng.traineddata')));
const icon = () => nativeImage.createFromPath(path.join(resources, 'icon.png'));
const broadcast = (ch: string, payload?: unknown) => { for (const w of [quick, workspace]) if (w && !w.isDestroyed()) w.webContents.send(ch, payload); };

function load(win: BrowserWindow, view: 'quick' | 'workspace', route = '') {
  const hash = `${view}${route ? `/${route}` : ''}`;
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
}

const secure = { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } as const;

function hardenWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL;
    const ok = dev ? url.startsWith(dev) : url.split('#')[0] === pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
    if (!ok) e.preventDefault();
  });
}

function createQuick() {
  quick = new BrowserWindow({ width: 720, height: 520, show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false, backgroundColor: '#ffffff', title: 'InQurix Quick Search', webPreferences: secure });
  quick.setAlwaysOnTop(true, 'floating');
  quick.on('page-title-updated', (e) => e.preventDefault());
  hardenWindow(quick);
  load(quick, 'quick');
  quick.on('blur', () => { if (!process.env.INQURIX_E2E_KEEP_QUICK) quick?.hide(); });
  quick.on('close', (e) => { if (!quitting) { e.preventDefault(); quick?.hide(); } });
}

function showQuick() {
  if (!quick || quick.isDestroyed()) createQuick();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;
  quick!.setPosition(Math.round(x + (width - 720) / 2), Math.round(y + 120));
  quick!.show();
  quick!.focus();
  quick!.webContents.send('quick:shown');
}

function toggleQuick() { if (quick?.isVisible() && quick.isFocused()) quick.hide(); else showQuick(); }

function openWorkspace(route?: string) {
  if (!workspace || workspace.isDestroyed()) {
    workspace = new BrowserWindow({ width: 1280, height: 820, minWidth: 900, minHeight: 600, show: false, title: 'InQurix', icon: icon(), backgroundColor: '#f7f7f8', webPreferences: secure });
    hardenWindow(workspace);
    load(workspace, 'workspace', route);
    workspace.once('ready-to-show', () => workspace?.show());
    workspace.on('close', (e) => { if (!quitting) { e.preventDefault(); workspace?.hide(); } });
  } else {
    if (route) workspace.webContents.send('nav', route);
    workspace.show();
  }
  workspace.focus();
  quick?.hide();
}

function registerShortcut(s: Settings): boolean {
  globalShortcut.unregisterAll();
  let ok = false;
  try { ok = globalShortcut.register(s.shortcut, toggleQuick); } catch { ok = false; }
  if (!ok) broadcast('shortcut:error', `The shortcut ${s.shortcut} is used by another application. Choose a different one in Settings.`);
  return ok;
}

function startWorker() {
  const s = settings.get();
  const config = { dbPath, modelsDir, tessdata, ocr: s.ocr, semantic: s.semantic, reconcileMinutes: s.reconcileMinutes };
  worker = fork(path.join(__dirname, 'worker.js'), [], { execPath: process.execPath, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', INQURIX_WORKER_CONFIG: JSON.stringify(config) } });
  worker.on('message', (m: WorkerOut) => {
    if (m.type === 'progress') broadcast('index:progress', m.progress);
    else if (m.type === 'state') { indexPaused = m.paused; broadcast('index:state', m); updateTray(); }
    else if (m.type === 'changed') broadcast('index:changed');
    else if (m.type === 'log') console[m.level === 'error' ? 'error' : 'warn'](`[indexer] ${m.message}`);
  });
  worker.on('exit', (code) => { worker = undefined; if (!quitting) { console.error(`[indexer] exited with code ${code}; restarting`); setTimeout(startWorker, 2000); } });
}

function updateTray() {
  if (!tray) return;
  const accel = settings.get().shortcut;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Quick Search', accelerator: accel, click: showQuick },
    { label: 'Open InQurix', click: () => openWorkspace() },
    { type: 'separator' },
    { label: indexPaused ? 'Resume indexing' : 'Pause indexing', click: () => worker?.send({ type: indexPaused ? 'resume' : 'pause' }) },
    { label: 'Settings…', click: () => openWorkspace('settings') },
    { type: 'separator' },
    { label: 'Quit InQurix', click: () => { quitting = true; app.quit(); } },
  ]));
}

async function loadEmbedder() {
  if (!settings.get().semantic) { embedder = undefined; return; }
  try { embedder = await createEmbedder(modelsDir); } catch (e) { console.warn('Semantic search unavailable:', (e as Error).message); }
}

app.on('second-instance', () => showQuick());
app.on('window-all-closed', () => { /* stay resident in tray; indexing continues */ });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); worker?.send({ type: 'shutdown' }); });
app.on('activate', () => openWorkspace());

/** Notifies once per reminder when it is due within a day; only reminders the user created. */
function checkReminders(db: DB) {
  if (!settings.get().reminders || !Notification.isSupported()) return;
  const soon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const due = db.prepare('SELECT id, title, due_date, date_basis FROM reminders WHERE dismissed_at IS NULL AND notified_at IS NULL AND due_date <= ?').all(soon) as { id: number; title: string; due_date: string; date_basis: string }[];
  for (const r of due) {
    const n = new Notification({ title: `InQurix reminder: ${r.due_date}`, body: `${r.title}${r.date_basis === 'calculated' ? ' (calculated date — check the document)' : ''}` });
    n.on('click', () => openWorkspace('investigations'));
    n.show();
    db.prepare('UPDATE reminders SET notified_at = ? WHERE id = ?').run(now(), r.id);
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(icon());
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  const db = openDatabase(dbPath);
  const engine = new SearchEngine(db, () => embedder);
  registerIpc({
    db, engine, settings,
    worker: () => (worker ? { postMessage: (m: unknown) => worker?.send(m as object) } : undefined),
    hideQuick: () => quick?.hide(),
    openWorkspace,
    owner: () => BrowserWindow.getFocusedWindow() ?? workspace ?? undefined,
    applySettings: (prev, next) => {
      if (prev.shortcut !== next.shortcut) registerShortcut(next);
      if (prev.launchAtLogin !== next.launchAtLogin) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, openAsHidden: true });
      if (prev.semantic !== next.semantic) void loadEmbedder();
      worker?.send({ type: 'config', config: { ocr: next.ocr, semantic: next.semantic, reconcileMinutes: next.reconcileMinutes } });
      updateTray();
    },
  });
  startWorker();
  void loadEmbedder();
  checkReminders(db);
  setInterval(() => checkReminders(db), 3_600_000).unref();
  tray = new Tray(icon().resize({ width: 18, height: 18 }));
  tray.setToolTip('InQurix — The Local Intelligence and Analysis Engine');
  tray.on('click', showQuick);
  updateTray();
  createQuick();
  registerShortcut(settings.get());
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;
  if (!hidden || !settings.get().onboarded) openWorkspace(settings.get().onboarded ? undefined : 'onboarding');
});
