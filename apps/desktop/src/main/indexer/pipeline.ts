import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULT_LIMITS,
  SUPPORTED_EXTENSIONS,
  buildRecords,
  extensionOf,
  extractAllEntities,
  extractDocument,
  type BusinessRecord,
  type ExtractedEntity,
  type ExtractionResult,
  type OcrOptions,
  type ProcessingLimits,
} from '@inqurix/core';
import { EXTRACTOR_VERSION, logEvent, now, tx, type DB } from '../db/index.js';
import { toBlob, type Embedder } from '../search/embed.js';

export interface SourceRow {
  id: number;
  path: string;
  name: string;
  enabled: number;
  paused: number;
  include_hidden: number;
}

export interface PipelineOptions {
  limits?: ProcessingLimits;
  ocr?: OcrOptions;
  embed?: Embedder;
}

export interface ScanProgress {
  sourceId: number;
  phase: 'discovering' | 'indexing' | 'reconciling' | 'done' | 'paused';
  discovered: number;
  processed: number;
  failed: number;
  current?: string;
}

const ALWAYS_EXCLUDED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information', '.trash', '.trashes', '.cache', '__pycache__', '.spotlight-v100', '.fseventsd']);
const SUPPORTED = new Set(SUPPORTED_EXTENSIONS);
const OK_STATUSES = new Set(['indexed', 'partial', 'empty', 'unsupported', 'encrypted', 'ocr_required', 'skipped']);

/** Glob subset: `*`, `**`, `?`. Patterns without a slash match any path component. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return g.includes('/') ? new RegExp(`^${re}(?:/.*)?$`, 'i') : new RegExp(`(?:^|/)${re}(?:/.*)?$`, 'i');
}

export function loadExclusions(db: DB, sourceId: number): RegExp[] {
  const rows = db.prepare('SELECT pattern FROM exclusions WHERE source_id = ? OR source_id IS NULL').all(sourceId) as { pattern: string }[];
  return rows.map((r) => globToRegExp(r.pattern));
}

export function isExcluded(rel: string, patterns: RegExp[]): boolean {
  const p = rel.replace(/\\/g, '/');
  return patterns.some((re) => re.test(p));
}

export function isHiddenName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~$') || name.toLowerCase() === 'desktop.ini' || name.toLowerCase() === 'thumbs.db';
}

/** Is `file` (after resolving symlinks) inside `root`? Prevents indexing outside an authorized folder. */
export function isInsideRoot(root: string, file: string): boolean {
  try {
    const r = fs.realpathSync(root);
    const f = fs.realpathSync(file);
    const rel = path.relative(r, f);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

export interface Discovered { abs: string; size: number; mtimeMs: number }

export async function discover(root: string, opts: { includeHidden: boolean; exclusions: RegExp[]; signal?: AbortSignal; onError?: (p: string, e: Error) => void }): Promise<Discovered[]> {
  const out: Discovered[] = [];
  const stack = [root];
  while (stack.length) {
    if (opts.signal?.aborted) break;
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      opts.onError?.(dir, e as Error);
      continue;
    }
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      if (!opts.includeHidden && isHiddenName(d.name)) continue;
      const abs = path.join(dir, d.name);
      const rel = path.relative(root, abs);
      if (isExcluded(rel, opts.exclusions)) continue;
      if (d.isDirectory()) {
        if (!ALWAYS_EXCLUDED_DIRS.has(d.name.toLowerCase())) stack.push(abs);
      } else if (d.isFile() && SUPPORTED.has(extensionOf(d.name))) {
        try {
          const st = await fsp.stat(abs);
          out.push({ abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        } catch (e) {
          opts.onError?.(abs, e as Error);
        }
      }
    }
  }
  return out;
}

interface DocRow { id: number; size: number; mtime_ms: number; hash: string | null; status: string; extractor_version: number }

function getDoc(db: DB, abs: string): DocRow | undefined {
  return db.prepare("SELECT id, size, mtime_ms, hash, status, extractor_version FROM documents WHERE path = ? AND attachment_name = ''").get(abs) as DocRow | undefined;
}

function upsertDoc(db: DB, source: SourceRow, abs: string, fields: { size: number; mtimeMs: number; status: string; detail?: string | null; parentId?: number; attachment?: string }): number {
  const name = fields.attachment ?? path.basename(abs);
  const row = db.prepare(`
    INSERT INTO documents (source_id, parent_id, path, attachment_name, name, ext, size, mtime_ms, status, status_detail, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path, attachment_name) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, status = excluded.status, status_detail = excluded.status_detail, source_id = excluded.source_id
    RETURNING id`).get(source.id, fields.parentId ?? null, abs, fields.attachment ?? '', name, extensionOf(name), fields.size, fields.mtimeMs, fields.status, fields.detail ?? null, now()) as { id: number };
  return row.id;
}

function clearContent(db: DB, docId: number): void {
  const children = db.prepare('SELECT id FROM documents WHERE parent_id = ?').all(docId) as { id: number }[];
  for (const c of children) deleteDocRow(db, c.id);
  db.prepare('DELETE FROM segments WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM entities WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM records WHERE doc_id = ?').run(docId);
  db.prepare('DELETE FROM embeddings WHERE doc_id = ?').run(docId);
}

function deleteDocRow(db: DB, docId: number): void {
  clearContent(db, docId);
  db.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(docId);
  db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
}

function writeResult(db: DB, docId: number, abs: string, displayName: string, result: ExtractionResult, entities: ExtractedEntity[], records: BusinessRecord[], hash: string | null): void {
  clearContent(db, docId);
  const insSeg = db.prepare('INSERT INTO segments (doc_id, ordinal, kind, text, heading, location, method, confidence, fields, cells) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const segIds = new Map<number, number>();
  for (const s of result.segments) {
    const r = insSeg.run(docId, s.ordinal, s.kind, s.text, s.location.heading ?? null, JSON.stringify(s.location), s.method, s.confidence ?? null, s.fields ? JSON.stringify(s.fields) : null, s.cells ? JSON.stringify(s.cells) : null);
    segIds.set(s.ordinal, Number(r.lastInsertRowid));
  }
  const insEnt = db.prepare('INSERT INTO entities (doc_id, segment_id, type, original, normalized, numeric, iso_date, currency, label, confidence, offset, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const e of entities) insEnt.run(docId, segIds.get(e.segmentOrdinal) ?? null, e.type, e.original, e.normalized, e.numeric ?? null, e.isoDate ?? null, e.currency ?? null, e.label ?? null, e.confidence, e.offset, e.origin);
  const insRec = db.prepare('INSERT INTO records (doc_id, segment_id, doc_type, number, number_norm, supplier, supplier_norm, date, total, currency, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of records) {
    const segOrd = r.fieldSources.number ?? r.fieldSources.total ?? r.fieldSources.supplier;
    insRec.run(docId, segOrd !== undefined ? segIds.get(segOrd) ?? null : null, r.docType, r.number ?? null, r.numberNormalized ?? null, r.supplier ?? null, r.supplierNormalized ?? null, r.date ?? null, r.total ?? null, r.currency ?? null, JSON.stringify(r));
  }
  const m = result.metadata;
  db.prepare(`UPDATE documents SET kind = ?, status = ?, status_detail = ?, warnings = ?, title = ?, author = ?, doc_created_at = ?, doc_modified_at = ?, page_count = ?, metadata = ?, ocr_confidence = ?, segment_count = ?, extractor_version = ?, indexed_at = ?, hash = ? WHERE id = ?`).run(
    result.kind, result.status, result.warnings[0]?.message ?? null, JSON.stringify(result.warnings), m.title ?? null, m.author ?? null, m.createdAt ?? null, m.modifiedAt ?? null, m.pageCount ?? m.slideCount ?? null, JSON.stringify(m), result.ocrConfidence ?? null, result.segments.length, EXTRACTOR_VERSION, now(), hash, docId,
  );
  db.prepare('DELETE FROM documents_fts WHERE rowid = ?').run(docId);
  db.prepare('INSERT INTO documents_fts (rowid, name, title, folder) VALUES (?, ?, ?, ?)').run(docId, displayName.replace(/[_\-.]+/g, ' '), m.title ?? '', path.dirname(abs).split(/[\\/]/).slice(-3).join(' '));
}

export interface IndexFileResult { outcome: 'unchanged' | 'indexed' | 'failed' | 'skipped' | 'unavailable'; docId?: number; status?: string }

export async function indexFile(db: DB, source: SourceRow, abs: string, opts: PipelineOptions = {}): Promise<IndexFileResult> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  let st: fs.Stats;
  try {
    st = await fsp.stat(abs);
  } catch {
    const existing = getDoc(db, abs);
    if (existing) tx(db, () => deleteDocRow(db, existing.id));
    return { outcome: 'skipped' };
  }
  if (!st.isFile()) return { outcome: 'skipped' };
  if (!isInsideRoot(source.path, abs)) return { outcome: 'skipped' };
  const mtimeMs = Math.floor(st.mtimeMs);
  const existing = getDoc(db, abs);
  if (existing && existing.size === st.size && existing.mtime_ms === mtimeMs && existing.extractor_version === EXTRACTOR_VERSION && OK_STATUSES.has(existing.status)) {
    return { outcome: 'unchanged', docId: existing.id, status: existing.status };
  }
  if (st.size > limits.maxFileBytes) {
    const id = tx(db, () => {
      const id = upsertDoc(db, source, abs, { size: st.size, mtimeMs, status: 'skipped', detail: `Larger than the ${Math.round(limits.maxFileBytes / 1e6)} MB limit` });
      clearContent(db, id);
      db.prepare('UPDATE documents SET extractor_version = ? WHERE id = ?').run(EXTRACTOR_VERSION, id);
      return id;
    });
    return { outcome: 'skipped', docId: id, status: 'skipped' };
  }
  let buf: Buffer;
  try {
    buf = await fsp.readFile(abs);
  } catch (e) {
    const id = upsertDoc(db, source, abs, { size: st.size, mtimeMs, status: 'unavailable', detail: `Cannot read file: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` });
    logEvent(db, 'warn', 'unreadable', `${abs}: ${(e as Error).message}`, { docId: id, sourceId: source.id });
    return { outcome: 'unavailable', docId: id, status: 'unavailable' };
  }
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (existing && existing.hash === hash && existing.extractor_version === EXTRACTOR_VERSION && OK_STATUSES.has(existing.status)) {
    db.prepare('UPDATE documents SET size = ?, mtime_ms = ? WHERE id = ?').run(st.size, mtimeMs, existing.id);
    return { outcome: 'unchanged', docId: existing.id, status: existing.status };
  }
  const docId = upsertDoc(db, source, abs, { size: st.size, mtimeMs, status: 'processing' });
  db.prepare('UPDATE documents SET attempts = attempts + 1 WHERE id = ?').run(docId);

  const name = path.basename(abs);
  const { identification, result } = await extractDocument(buf, name, { limits, ocr: opts.ocr });
  const entities = extractAllEntities(result.segments);
  const records = buildRecords(result, entities, name);
  const childData = (result.children ?? []).map((c) => {
    const ents = extractAllEntities(c.result.segments);
    return { name: c.name, result: c.result, entities: ents, records: buildRecords(c.result, ents, c.name) };
  });
  tx(db, () => {
    writeResult(db, docId, abs, name, result, entities, records, hash);
    db.prepare('UPDATE documents SET mime = ? WHERE id = ?').run(identification.mime, docId);
    for (const c of childData) {
      const cid = upsertDoc(db, source, abs, { size: 0, mtimeMs, status: 'processing', parentId: docId, attachment: c.name });
      writeResult(db, cid, abs, c.name, c.result, c.entities, c.records, null);
    }
  });
  if (result.status === 'failed') logEvent(db, 'error', 'extract_failed', `${name}: ${result.warnings[0]?.message ?? 'failed'}`, { docId, sourceId: source.id });

  if (opts.embed && result.segments.length) {
    try {
      await embedDocument(db, docId, opts.embed);
      for (const c of db.prepare('SELECT id FROM documents WHERE parent_id = ?').all(docId) as { id: number }[]) await embedDocument(db, c.id, opts.embed);
    } catch (e) {
      logEvent(db, 'warn', 'embed_failed', `${name}: ${(e as Error).message}`, { docId, sourceId: source.id });
    }
  }
  return { outcome: result.status === 'failed' ? 'failed' : 'indexed', docId, status: result.status };
}

const MAX_EMBED_SEGMENTS = 400;

export async function embedDocument(db: DB, docId: number, embed: Embedder): Promise<void> {
  const segs = db.prepare('SELECT id, text, heading FROM segments WHERE doc_id = ? ORDER BY ordinal LIMIT ?').all(docId, MAX_EMBED_SEGMENTS) as { id: number; text: string; heading: string | null }[];
  const doc = db.prepare('SELECT name, title FROM documents WHERE id = ?').get(docId) as { name: string; title: string | null } | undefined;
  if (!doc) return;
  const ins = db.prepare('INSERT OR REPLACE INTO embeddings (segment_id, doc_id, vec) VALUES (?, ?, ?)');
  for (let i = 0; i < segs.length; i += 16) {
    const batch = segs.slice(i, i + 16);
    const vecs = await embed(batch.map((s) => `${doc.title ?? doc.name}${s.heading ? ` - ${s.heading}` : ''}\n${s.text}`));
    if (!db.prepare('SELECT 1 FROM documents WHERE id = ?').get(docId)) return;
    tx(db, () => batch.forEach((s, j) => ins.run(s.id, docId, toBlob(vecs[j]))));
  }
}

export function removeFile(db: DB, abs: string): boolean {
  const ids = db.prepare('SELECT id FROM documents WHERE path = ? AND parent_id IS NULL').all(abs) as { id: number }[];
  if (!ids.length) return false;
  tx(db, () => ids.forEach((r) => deleteDocRow(db, r.id)));
  return true;
}

export function removeUnder(db: DB, dir: string): number {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const ids = (db.prepare('SELECT id, path FROM documents WHERE parent_id IS NULL').all() as { id: number; path: string }[]).filter((r) => r.path.startsWith(prefix));
  tx(db, () => ids.forEach((r) => deleteDocRow(db, r.id)));
  return ids.length;
}

export function removeSourceDocuments(db: DB, sourceId: number): void {
  const ids = db.prepare('SELECT id FROM documents WHERE source_id = ? AND parent_id IS NULL').all(sourceId) as { id: number }[];
  tx(db, () => ids.forEach((r) => deleteDocRow(db, r.id)));
}

/** Documents left mid-processing by a crash/forced quit are re-queued at start-up. */
export function recoverInterrupted(db: DB): number {
  return Number(db.prepare("UPDATE documents SET status = 'queued' WHERE status IN ('processing', 'discovered')").run().changes);
}

/** Full scan of one authorized source: discover, index new/changed files, reconcile deletions. */
export async function scanSource(db: DB, source: SourceRow, opts: PipelineOptions & { signal?: AbortSignal; onProgress?: (p: ScanProgress) => void } = {}): Promise<ScanProgress> {
  const progress: ScanProgress = { sourceId: source.id, phase: 'discovering', discovered: 0, processed: 0, failed: 0 };
  const emit = () => opts.onProgress?.({ ...progress });
  if (!fs.existsSync(source.path)) {
    db.prepare("UPDATE sources SET status = 'unavailable', error = ? WHERE id = ?").run('Folder not found or not connected', source.id);
    logEvent(db, 'warn', 'source_unavailable', `${source.path} is not available`, { sourceId: source.id });
    progress.phase = 'done';
    emit();
    return progress;
  }
  db.prepare("UPDATE sources SET status = 'scanning', error = NULL, last_scan_started_at = ? WHERE id = ?").run(now(), source.id);
  emit();
  let dirErrors = 0;
  const files = await discover(source.path, {
    includeHidden: !!source.include_hidden,
    exclusions: loadExclusions(db, source.id),
    signal: opts.signal,
    onError: (p, e) => { dirErrors++; logEvent(db, 'warn', 'discover_error', `${p}: ${e.message}`, { sourceId: source.id }); },
  });
  progress.discovered = files.length;
  progress.phase = 'indexing';
  emit();
  const seen = new Set(files.map((f) => f.abs));
  for (const f of files) {
    if (opts.signal?.aborted) {
      progress.phase = 'paused';
      db.prepare("UPDATE sources SET status = 'paused' WHERE id = ?").run(source.id);
      emit();
      return progress;
    }
    progress.current = f.abs;
    try {
      const r = await indexFile(db, source, f.abs, opts);
      if (r.outcome === 'failed' || r.outcome === 'unavailable') progress.failed++;
    } catch (e) {
      progress.failed++;
      logEvent(db, 'error', 'index_error', `${f.abs}: ${(e as Error).message}`, { sourceId: source.id });
    }
    progress.processed++;
    if (progress.processed % 5 === 0 || progress.processed === files.length) emit();
  }
  progress.phase = 'reconciling';
  progress.current = undefined;
  emit();
  const known = db.prepare('SELECT id, path FROM documents WHERE source_id = ? AND parent_id IS NULL').all(source.id) as { id: number; path: string }[];
  const gone = known.filter((d) => !seen.has(d.path));
  if (gone.length) {
    tx(db, () => gone.forEach((d) => deleteDocRow(db, d.id)));
    logEvent(db, 'info', 'reconciled', `Removed ${gone.length} deleted or excluded file(s)`, { sourceId: source.id });
  }
  db.prepare("UPDATE sources SET status = ?, error = ?, last_scan_at = ? WHERE id = ?").run('ready', dirErrors ? `${dirErrors} folder(s) could not be read` : null, now(), source.id);
  progress.phase = 'done';
  emit();
  return progress;
}
