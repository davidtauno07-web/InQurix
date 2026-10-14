import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { DEFAULT_LIMITS, extensionOf, SUPPORTED_EXTENSIONS, terminateOcr } from '@inqurix/core';
import { openDatabase } from '../db/index.js';
import { createEmbedder, type Embedder } from '../search/embed.js';
import { indexFile, isExcluded, isHiddenName, loadExclusions, recoverInterrupted, removeFile, removeSourceDocuments, removeUnder, scanSource, type ScanProgress, type SourceRow } from './pipeline.js';

export interface WorkerConfig { dbPath: string; modelsDir?: string; tessdata?: string; ocr: boolean; semantic: boolean; reconcileMinutes: number }
export type WorkerIn =
  | { type: 'scan'; sourceId?: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'removeSource'; sourceId: number }
  | { type: 'config'; config: Partial<WorkerConfig> }
  | { type: 'shutdown' };
export type WorkerOut = { type: 'progress'; progress: ScanProgress } | { type: 'changed' } | { type: 'state'; paused: boolean; busy: boolean; queue: number } | { type: 'log'; level: string; message: string };

let config = workerData as WorkerConfig;
const db = openDatabase(config.dbPath);
const post = (m: WorkerOut) => parentPort?.postMessage(m);
const SUPPORTED = new Set(SUPPORTED_EXTENSIONS);
let paused = false;
let busy = false;
let abort = new AbortController();
let embedder: Embedder | undefined;
const queue: ({ kind: 'scan'; sourceId: number } | { kind: 'file'; sourceId: number; path: string } | { kind: 'unlink'; path: string } | { kind: 'unlinkDir'; path: string })[] = [];
const watchers = new Map<number, FSWatcher>();

const sources = () => db.prepare('SELECT * FROM sources WHERE enabled = 1').all() as unknown as SourceRow[];
const opts = () => ({ limits: { ...DEFAULT_LIMITS, ocr: config.ocr }, ocr: config.ocr && config.tessdata ? { langPath: config.tessdata } : undefined, embed: config.semantic ? embedder : undefined });
const state = () => post({ type: 'state', paused, busy, queue: queue.length });

async function ensureEmbedder() {
  if (config.semantic && !embedder && config.modelsDir) {
    try { embedder = await createEmbedder(config.modelsDir); } catch (e) { post({ type: 'log', level: 'warn', message: `Semantic model unavailable: ${(e as Error).message}` }); }
  }
}

function watchSource(s: SourceRow) {
  if (watchers.has(s.id)) return;
  const exclusions = loadExclusions(db, s.id);
  const w = watch(s.path, {
    ignoreInitial: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
    ignored: (p: string) => {
      const rel = path.relative(s.path, p);
      if (!rel) return false;
      if (!s.include_hidden && rel.split(path.sep).some(isHiddenName)) return true;
      return isExcluded(rel, exclusions) || /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(rel);
    },
  });
  const onFile = (p: string) => { if (SUPPORTED.has(extensionOf(p))) { queue.push({ kind: 'file', sourceId: s.id, path: p }); pump(); } };
  w.on('add', onFile).on('change', onFile)
    .on('unlink', (p) => { queue.push({ kind: 'unlink', path: p }); pump(); })
    .on('unlinkDir', (p) => { queue.push({ kind: 'unlinkDir', path: p }); pump(); })
    .on('error', (e) => post({ type: 'log', level: 'warn', message: `Watcher error for ${s.path}: ${(e as Error).message}` }));
  watchers.set(s.id, w);
}

async function unwatch(id: number) { await watchers.get(id)?.close(); watchers.delete(id); }

async function pump() {
  if (busy || paused) return state();
  busy = true;
  state();
  await ensureEmbedder();
  try {
    while (queue.length && !paused) {
      const job = queue.shift()!;
      const src = 'sourceId' in job ? (db.prepare('SELECT * FROM sources WHERE id = ? AND enabled = 1').get(job.sourceId) as unknown as SourceRow | undefined) : undefined;
      try {
        if (job.kind === 'scan' && src) {
          watchSource(src);
          const r = await scanSource(db, src, { ...opts(), signal: abort.signal, onProgress: (progress) => post({ type: 'progress', progress }) });
          if (r.phase === 'paused') queue.unshift(job);
        } else if (job.kind === 'file' && src) {
          await indexFile(db, src, job.path, opts());
        } else if (job.kind === 'unlink') {
          removeFile(db, job.path);
        } else if (job.kind === 'unlinkDir') {
          removeUnder(db, job.path);
        }
      } catch (e) {
        post({ type: 'log', level: 'error', message: `Indexing job failed: ${(e as Error).message}` });
      }
      post({ type: 'changed' });
    }
  } finally {
    busy = false;
    state();
  }
}

function enqueueScan(id?: number) {
  for (const s of sources()) if (id === undefined || s.id === id) if (!queue.some((q) => q.kind === 'scan' && q.sourceId === s.id)) queue.push({ kind: 'scan', sourceId: s.id });
  pump();
}

parentPort?.on('message', async (m: WorkerIn) => {
  switch (m.type) {
    case 'scan': enqueueScan(m.sourceId); break;
    case 'pause': paused = true; abort.abort(); abort = new AbortController(); state(); break;
    case 'resume': paused = false; pump(); break;
    case 'removeSource':
      await unwatch(m.sourceId);
      for (let i = queue.length - 1; i >= 0; i--) { const q = queue[i]; if ('sourceId' in q && q.sourceId === m.sourceId) queue.splice(i, 1); }
      removeSourceDocuments(db, m.sourceId);
      db.prepare('DELETE FROM sources WHERE id = ?').run(m.sourceId);
      post({ type: 'changed' });
      break;
    case 'config': config = { ...config, ...m.config }; if (!config.semantic) embedder = undefined; break;
    case 'shutdown':
      for (const id of [...watchers.keys()]) await unwatch(id);
      await terminateOcr();
      db.close();
      process.exit(0);
  }
});

recoverInterrupted(db);
enqueueScan();
setInterval(() => enqueueScan(), Math.max(5, config.reconcileMinutes) * 60_000).unref();
