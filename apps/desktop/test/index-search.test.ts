import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DB } from '../src/main/db/index.js';
import { indexFile, scanSource, removeFile, type SourceRow } from '../src/main/indexer/pipeline.js';
import { SearchEngine, HL_START } from '../src/main/search/engine.js';
import { createEmbedder, type Embedder } from '../src/main/search/embed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const modelsDir = path.join(root, 'apps/desktop/resources/models');
const hasModel = fs.existsSync(path.join(modelsDir, 'Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inqurix-idx-'));
const docs = path.join(tmp, 'Documents');
let db: DB;
let source: SourceRow;
let engine: SearchEngine;
let embed: Embedder | undefined;

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/generate-fixtures.mjs'), docs]);
  fs.mkdirSync(path.join(docs, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'node_modules', 'ignored.txt'), 'invoice INV-1048 should never be indexed');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'secret outside the authorized folder');
  db = openDatabase(path.join(tmp, 'index.db'));
  const id = Number(db.prepare("INSERT INTO sources (path, name, created_at) VALUES (?, 'Documents', datetime('now'))").run(docs).lastInsertRowid);
  source = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as unknown as SourceRow;
  if (hasModel) embed = await createEmbedder(modelsDir);
  await scanSource(db, source, { embed });
  engine = new SearchEngine(db, () => embed);
}, 120_000);

afterAll(() => db?.close());

describe('indexing', () => {
  it('indexes supported files and records statuses', () => {
    const rows = db.prepare('SELECT name, status FROM documents WHERE parent_id IS NULL').all() as { name: string; status: string }[];
    const st = Object.fromEntries(rows.map((r) => [r.name, r.status]));
    expect(st['invoice-INV-1048.pdf']).toBe('indexed');
    expect(st['payments-2026.xlsx']).toBe('indexed');
    expect(st['scanned-delivery-note-DN-5520.pdf']).toBe('ocr_required');
    expect(st['program.exe']).toBeUndefined();
    expect(rows.some((r) => r.name === 'ignored.txt')).toBe(false);
  });
  it('indexes email attachments as child documents', () => {
    const child = db.prepare("SELECT attachment_name FROM documents WHERE parent_id IS NOT NULL").get() as { attachment_name: string };
    expect(child.attachment_name).toBe('bank-letter.txt');
  });
  it('refuses files outside the authorized folder', async () => {
    const r = await indexFile(db, source, path.join(tmp, 'outside.txt'));
    expect(r.outcome).toBe('skipped');
  });
  it('skips unchanged files on rescan', async () => {
    const r = await indexFile(db, source, path.join(docs, 'quote-Q-2207.txt'));
    expect(r.outcome).toBe('unchanged');
  });
});

describe('search', () => {
  it('finds a document by content, not filename', async () => {
    const { results } = await engine.search({ query: 'renegotiate paper pricing' });
    expect(results[0]?.name).toBe('board-meeting-2026-03.pptx');
    expect(results[0]?.evidence[0]?.location.slide).toBe(2);
    expect(results[0]?.evidence[0]?.snippet).toContain(HL_START);
  });
  it('finds exact invoice numbers including zero-padded variants', async () => {
    const { results } = await engine.search({ query: 'INV-1048' });
    const names = results.map((r) => r.name);
    expect(names).toContain('invoice-INV-1048.pdf');
    expect(names).toContain('Kavango invoice 1048 (resent).pdf');
    expect(results[0]?.reasons.join(' ')).toMatch(/reference/i);
  });
  it('finds records by amount', async () => {
    const { results } = await engine.search({ query: '14,317.50' });
    expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(['invoice-INV-1048.pdf', 'payments-2026.xlsx']));
    const xl = results.find((r) => r.name === 'payments-2026.xlsx');
    expect(xl?.evidence[0]?.location.sheet).toBe('Payments 2026');
  });
  it('finds bank account numbers', async () => {
    const { results } = await engine.search({ query: '04123987650' });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
  it('applies type filters', async () => {
    const { results } = await engine.search({ query: 'Kavango type:pdf' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.kind === 'pdf')).toBe(true);
  });
  it.skipIf(!hasModel)('finds by meaning with the local model', async () => {
    const { results, semantic } = await engine.search({ query: 'supplier wants us to pay into a different account' });
    expect(semantic).toBe(true);
    expect(results.slice(0, 5).map((r) => r.name)).toContain('bank-details-change.eml');
  });
  it('drops deleted files from results', async () => {
    const f = path.join(docs, 'quote-Q-2207.txt');
    fs.rmSync(f);
    removeFile(db, f);
    const { results } = await engine.search({ query: 'Q-2207' });
    expect(results.map((r) => r.name)).not.toContain('quote-Q-2207.txt');
  });
  it('reflects modified content after re-index', async () => {
    const f = path.join(docs, 'notes-new.txt');
    fs.writeFileSync(f, 'Kudu feed order placed with Otjiwarongo Farm Supplies');
    await indexFile(db, source, f);
    expect((await engine.search({ query: 'kudu feed' })).results[0]?.name).toBe('notes-new.txt');
    fs.writeFileSync(f, 'Springbok fencing quote replaced the earlier note');
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    await indexFile(db, source, f);
    expect((await engine.search({ query: 'kudu feed' })).results.map((r) => r.name)).not.toContain('notes-new.txt');
    expect((await engine.search({ query: '"Kudu feed order placed"' })).results.map((r) => r.name)).not.toContain('notes-new.txt');
    expect((await engine.search({ query: '"Springbok fencing quote"' })).results[0]?.name).toBe('notes-new.txt');
    expect((await engine.search({ query: 'springbok fencing' })).results[0]?.name).toBe('notes-new.txt');
  });
});
