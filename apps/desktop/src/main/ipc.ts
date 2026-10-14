import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Worker } from 'node:worker_threads';
import { now, type DB } from './db/index.js';
import type { SearchEngine, SearchRequest } from './search/engine.js';
import type { Settings, SettingsStore } from './settings.js';
import type { WorkerIn } from './indexer/worker.js';

export interface IpcContext {
  db: DB;
  engine: SearchEngine;
  settings: SettingsStore;
  worker: () => Worker;
  hideQuick: () => void;
  openWorkspace: (route?: string) => void;
  applySettings: (prev: Settings, next: Settings) => void;
  owner: () => BrowserWindow | undefined;
}

const send = (ctx: IpcContext, m: WorkerIn) => ctx.worker().postMessage(m);

export function registerIpc(ctx: IpcContext): void {
  const { db } = ctx;
  const h = (ch: string, fn: (...a: never[]) => unknown) => ipcMain.handle(ch, (_e, ...args) => (fn as (...a: unknown[]) => unknown)(...args));
  const docRow = (id: number) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as { id: number; path: string; parent_id: number | null; name: string } | undefined;

  h('search', async (req: SearchRequest) => {
    const r = await ctx.engine.search(req);
    if (ctx.settings.get().keepHistory && req.query.trim().length > 1) {
      const last = db.prepare('SELECT id, query FROM history ORDER BY id DESC LIMIT 1').get() as { id: number; query: string } | undefined;
      if (last && (req.query.startsWith(last.query) || last.query.startsWith(req.query))) db.prepare('UPDATE history SET query = ?, at = ?, result_count = ? WHERE id = ?').run(req.query, now(), r.results.length, last.id);
      else db.prepare('INSERT INTO history (query, filters, at, result_count) VALUES (?, ?, ?, ?)').run(req.query, JSON.stringify(req.filters ?? {}), now(), r.results.length);
    }
    return r;
  });
  h('doc:get', (id: number) => {
    const doc = db.prepare('SELECT d.*, s.name source_name FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = ?').get(id);
    if (!doc) return null;
    const segments = db.prepare('SELECT id, ordinal, kind, text, location, method, confidence, fields FROM segments WHERE doc_id = ? ORDER BY ordinal LIMIT 2000').all(id);
    const entities = db.prepare('SELECT type, original, normalized, label, confidence, segment_id FROM entities WHERE doc_id = ? LIMIT 500').all(id);
    const records = db.prepare('SELECT doc_type, data FROM records WHERE doc_id = ?').all(id);
    const children = db.prepare('SELECT id, name, status FROM documents WHERE parent_id = ?').all(id);
    const pinned = !!db.prepare('SELECT 1 FROM pins WHERE doc_id = ?').get(id);
    return { doc, segments, entities, records, children, pinned };
  });
  h('doc:open', async (id: number, query?: string) => {
    const d = docRow(id);
    if (!d) return { ok: false, error: 'Document is no longer indexed' };
    if (!fs.existsSync(d.path)) return { ok: false, error: 'The original file was moved or deleted' };
    db.prepare('INSERT INTO opens (doc_id, query, at) VALUES (?, ?, ?)').run(d.parent_id ?? d.id, query ?? null, now());
    const err = await shell.openPath(d.path);
    return err ? { ok: false, error: err } : { ok: true };
  });
  h('doc:reveal', (id: number) => {
    const d = docRow(id);
    if (!d || !fs.existsSync(d.path)) return { ok: false, error: 'The original file was moved or deleted' };
    shell.showItemInFolder(d.path);
    return { ok: true };
  });
  h('doc:related', (id: number) =>
    db.prepare(`SELECT d.id, d.name, d.path, count(*) shared, group_concat(DISTINCT e2.type) types FROM entities e1
      JOIN entities e2 ON e2.normalized = e1.normalized AND e2.type = e1.type AND e2.doc_id <> e1.doc_id
      JOIN documents d ON d.id = e2.doc_id
      WHERE e1.doc_id = ? AND e1.type NOT IN ('date','percentage','amount','payment_terms') AND d.status IN ('indexed','partial')
      GROUP BY d.id ORDER BY shared DESC LIMIT 15`).all(id));

  h('sources:list', () => db.prepare(`SELECT s.*, (SELECT count(*) FROM documents d WHERE d.source_id = s.id AND d.parent_id IS NULL) docs,
      (SELECT count(*) FROM documents d WHERE d.source_id = s.id AND d.status IN ('failed','unavailable')) failed,
      (SELECT group_concat(pattern, '\n') FROM exclusions x WHERE x.source_id = s.id) exclusions FROM sources s ORDER BY s.id`).all());
  h('sources:add', async (dir?: string) => {
    let folder = dir;
    if (!folder) {
      const owner = ctx.owner();
      const r = owner ? await dialog.showOpenDialog(owner, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      folder = r.filePaths[0];
    }
    const abs = path.resolve(folder);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { error: 'Folder not found' };
    if (abs === path.parse(abs).root) return { error: 'Choose a specific folder rather than a whole drive' };
    const existing = db.prepare('SELECT id FROM sources WHERE path = ?').get(abs) as { id: number } | undefined;
    const id = existing?.id ?? Number(db.prepare('INSERT INTO sources (path, name, created_at) VALUES (?, ?, ?)').run(abs, path.basename(abs) || abs, now()).lastInsertRowid);
    send(ctx, { type: 'scan', sourceId: id });
    return { id };
  });
  h('sources:remove', (id: number) => { send(ctx, { type: 'removeSource', sourceId: id }); return true; });
  h('sources:update', (id: number, patch: { enabled?: boolean; include_hidden?: boolean }) => {
    if (patch.enabled !== undefined) db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    if (patch.include_hidden !== undefined) db.prepare('UPDATE sources SET include_hidden = ? WHERE id = ?').run(patch.include_hidden ? 1 : 0, id);
    send(ctx, { type: 'scan', sourceId: id });
    return true;
  });
  h('sources:rescan', (id?: number) => { send(ctx, { type: 'scan', sourceId: id }); return true; });
  h('exclusions:set', (sourceId: number, patterns: string[]) => {
    db.prepare('DELETE FROM exclusions WHERE source_id = ?').run(sourceId);
    for (const p of patterns.map((x) => x.trim()).filter(Boolean)) db.prepare('INSERT INTO exclusions (source_id, pattern) VALUES (?, ?)').run(sourceId, p);
    send(ctx, { type: 'scan', sourceId });
    return true;
  });

  h('index:status', () => ({
    counts: db.prepare('SELECT status, count(*) n FROM documents WHERE parent_id IS NULL GROUP BY status').all(),
    segments: (db.prepare('SELECT count(*) n FROM segments').get() as { n: number }).n,
    embeddings: (db.prepare('SELECT count(*) n FROM embeddings').get() as { n: number }).n,
  }));
  h('index:pause', () => { send(ctx, { type: 'pause' }); return true; });
  h('index:resume', () => { send(ctx, { type: 'resume' }); return true; });
  h('index:failures', () => db.prepare("SELECT id, name, path, status, status_detail, kind FROM documents WHERE status IN ('failed','unavailable','unsupported','encrypted','ocr_required','skipped','partial') ORDER BY name LIMIT 500").all());
  h('index:events', () => db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all());

  h('settings:get', () => ctx.settings.get());
  h('settings:update', (patch: Partial<Settings>) => {
    const prev = ctx.settings.get();
    const next = ctx.settings.update(patch);
    ctx.applySettings(prev, next);
    return ctx.settings.get();
  });

  h('history:list', () => db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT 100').all());
  h('history:clear', () => { db.prepare('DELETE FROM history').run(); return true; });
  h('saved:list', () => db.prepare('SELECT * FROM saved_searches ORDER BY id DESC').all());
  h('saved:add', (name: string, query: string, filters?: unknown) => Number(db.prepare('INSERT INTO saved_searches (name, query, filters, created_at) VALUES (?, ?, ?, ?)').run(name.slice(0, 200), query, JSON.stringify(filters ?? {}), now()).lastInsertRowid));
  h('saved:remove', (id: number) => { db.prepare('DELETE FROM saved_searches WHERE id = ?').run(id); return true; });
  h('pins:list', () => db.prepare('SELECT d.id, d.name, d.path, d.kind, p.at FROM pins p JOIN documents d ON d.id = p.doc_id ORDER BY p.at DESC').all());
  h('pins:toggle', (id: number) => {
    if (db.prepare('SELECT 1 FROM pins WHERE doc_id = ?').get(id)) { db.prepare('DELETE FROM pins WHERE doc_id = ?').run(id); return false; }
    db.prepare('INSERT INTO pins (doc_id, at) VALUES (?, ?)').run(id, now());
    return true;
  });
  h('recent:list', () => db.prepare('SELECT d.id, d.name, d.path, d.kind, max(o.at) at FROM opens o JOIN documents d ON d.id = o.doc_id GROUP BY d.id ORDER BY at DESC LIMIT 20').all());

  h('quick:hide', () => { ctx.hideQuick(); return true; });
  h('workspace:open', (route?: string) => { ctx.openWorkspace(route); return true; });
  h('app:info', () => ({ version: app.getVersion(), platform: process.platform, userData: app.getPath('userData') }));
}
