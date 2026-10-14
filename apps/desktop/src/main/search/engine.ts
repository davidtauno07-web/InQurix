import { extractEntities, foldForSearch, normalizeRefFor, parseAmount, parseDate, formatMoney, type FileKind, type SegmentLocation } from '@inqurix/core';
import type { DB } from '../db/index.js';
import { dot, fromBlob, type Embedder } from './embed.js';

export const HL_START = '\u0002';
export const HL_END = '\u0003';

export interface SearchFilters {
  kinds?: FileKind[];
  sourceIds?: number[];
  docTypes?: string[];
  modifiedAfter?: string;
  modifiedBefore?: string;
  folder?: string;
}

export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  limit?: number;
  mode?: 'auto' | 'exact' | 'semantic';
  /** Restrict to these document ids (used by permission-filtered company search). */
  allowedDocIds?: Set<number>;
}

export interface EvidenceHit {
  segmentId: number;
  ordinal: number;
  location: SegmentLocation;
  snippet: string;
  method: string;
  confidence?: number | null;
  channels: string[];
}

export interface SearchResult {
  docId: number;
  name: string;
  path: string;
  attachmentName?: string;
  kind: string;
  title?: string | null;
  status: string;
  modifiedMs: number;
  size: number;
  score: number;
  reasons: string[];
  evidence: EvidenceHit[];
  duplicates: string[];
  ocr: boolean;
}

export interface ParsedQuery {
  raw: string;
  terms: string[];
  phrases: string[];
  amounts: number[];
  refs: { type: string; normalized: string; original: string }[];
  dates: string[];
  accounts: string[];
  emails: string[];
  filters: SearchFilters;
}

const STOP = new Set('a an the of for in on at to and or is are was were be by with from that this these those my our your me i we find show search look where what which who when how about any all some document documents file files record records doc docs please get give list'.split(' '));
const KIND_ALIASES: Record<string, FileKind[]> = { pdf: ['pdf'], word: ['docx'], docx: ['docx'], excel: ['xlsx', 'csv'], xlsx: ['xlsx'], spreadsheet: ['xlsx', 'csv'], csv: ['csv'], powerpoint: ['pptx'], pptx: ['pptx'], slides: ['pptx'], email: ['eml'], eml: ['eml'], image: ['image'], scan: ['image', 'pdf'], txt: ['txt'], text: ['txt'], html: ['html'], rtf: ['rtf'] };

export function parseQuery(raw: string): ParsedQuery {
  const filters: SearchFilters = {};
  let q = raw;
  q = q.replace(/\b(type|kind|ext):(\w+)/gi, (_, __, v: string) => { filters.kinds = [...(filters.kinds ?? []), ...(KIND_ALIASES[v.toLowerCase()] ?? [v.toLowerCase() as FileKind])]; return ' '; });
  q = q.replace(/\b(after|since):(\S+)/gi, (_, __, v: string) => { const d = parseDate(v); if (d) filters.modifiedAfter = d; return ' '; });
  q = q.replace(/\bbefore:(\S+)/gi, (_, v: string) => { const d = parseDate(v); if (d) filters.modifiedBefore = d; return ' '; });
  q = q.replace(/\bin:("[^"]+"|\S+)/gi, (_, v: string) => { filters.folder = v.replace(/"/g, ''); return ' '; });
  const phrases: string[] = [];
  q = q.replace(/"([^"]{2,})"/g, (_, p: string) => { phrases.push(p.trim()); return ` ${p} `; });
  const ents = extractEntities({ text: q, ordinal: 0 });
  const amounts = ents.filter((e) => e.type === 'amount' && e.numeric !== undefined).map((e) => e.numeric!);
  for (const m of q.matchAll(/(?<![\w.-])(\d{1,3}(?:[ ,]\d{3})+(?:[.,]\d{2})?|\d+[.,]\d{2})(?![\w.-])/g)) {
    const v = parseAmount(m[1]);
    if (v !== undefined && !amounts.includes(v)) amounts.push(v);
  }
  const refs: ParsedQuery['refs'] = ents.filter((e) => /_number$|payment_reference|transaction_id/.test(e.type)).map((e) => ({ type: e.type, normalized: e.normalized, original: e.original }));
  for (const m of q.matchAll(/\b([A-Za-z]{1,5}[-/]?\d{2,}[\w-]*|\d{3,})\b/g)) {
    const tok = m[1];
    if (refs.some((r) => r.original === tok) || ents.some((e) => e.type === 'date' && e.original.includes(tok))) continue;
    refs.push({ type: 'any', normalized: normalizeRefFor('payment_reference', tok), original: tok });
  }
  const dates = ents.filter((e) => e.type === 'date' && e.isoDate).map((e) => e.isoDate!);
  const accounts = ents.filter((e) => e.type === 'bank_account' || e.type === 'iban').map((e) => e.normalized);
  const emails = ents.filter((e) => e.type === 'email').map((e) => e.normalized);
  const terms = [...new Set(foldForSearch(q).split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOP.has(t) && (t.length > 1 || /\d/.test(t))))];
  return { raw, terms, phrases, amounts, refs, dates, accounts, emails, filters };
}

function ftsQuote(t: string): string {
  return `"${t.replace(/"/g, '""')}"`;
}

export function buildFtsQueries(p: ParsedQuery): { and?: string; or?: string } {
  if (!p.terms.length && !p.phrases.length) return {};
  const parts = p.terms.map((t, i) => (i === p.terms.length - 1 && t.length >= 3 && !/^\d+$/.test(t) ? `${ftsQuote(t)}*` : ftsQuote(t)));
  const phraseParts = p.phrases.map((ph) => ftsQuote(foldForSearch(ph)));
  return { and: [...phraseParts, ...parts].join(' AND '), or: parts.length > 1 ? parts.join(' OR ') : undefined };
}

function filterSql(f: SearchFilters, alias = 'd'): { sql: string; params: (string | number)[] } {
  const w: string[] = [`${alias}.status IN ('indexed','partial')`];
  const params: (string | number)[] = [];
  if (f.kinds?.length) { w.push(`${alias}.kind IN (${f.kinds.map(() => '?').join(',')})`); params.push(...f.kinds); }
  if (f.sourceIds?.length) { w.push(`${alias}.source_id IN (${f.sourceIds.map(() => '?').join(',')})`); params.push(...f.sourceIds); }
  if (f.modifiedAfter) { w.push(`${alias}.mtime_ms >= ?`); params.push(Date.parse(f.modifiedAfter)); }
  if (f.modifiedBefore) { w.push(`${alias}.mtime_ms < ?`); params.push(Date.parse(f.modifiedBefore) + 86_400_000); }
  if (f.folder) { w.push(`${alias}.path LIKE ?`); params.push(`%${f.folder.replace(/[%_]/g, '')}%`); }
  if (f.docTypes?.length) { w.push(`EXISTS (SELECT 1 FROM records r WHERE r.doc_id = ${alias}.id AND r.doc_type IN (${f.docTypes.map(() => '?').join(',')}))`); params.push(...f.docTypes); }
  return { sql: w.join(' AND '), params };
}

/** In-memory copy of the embedding table, refreshed when the table changes. */
export class VectorIndex {
  private key = '';
  private ids: Int32Array = new Int32Array(0);
  private docs: Int32Array = new Int32Array(0);
  private vecs: Float32Array[] = [];
  refresh(db: DB): void {
    const k = db.prepare('SELECT count(*) c, coalesce(max(segment_id),0) m, coalesce(sum(segment_id),0) s FROM embeddings').get() as { c: number; m: number; s: number };
    const key = `${k.c}:${k.m}:${k.s}`;
    if (key === this.key) return;
    const rows = db.prepare('SELECT segment_id, doc_id, vec FROM embeddings').all() as { segment_id: number; doc_id: number; vec: Uint8Array }[];
    this.ids = Int32Array.from(rows.map((r) => r.segment_id));
    this.docs = Int32Array.from(rows.map((r) => r.doc_id));
    this.vecs = rows.map((r) => fromBlob(r.vec));
    this.key = key;
  }
  get size(): number { return this.vecs.length; }
  search(q: Float32Array, k: number, minScore: number): { segmentId: number; docId: number; score: number }[] {
    const out: { segmentId: number; docId: number; score: number }[] = [];
    for (let i = 0; i < this.vecs.length; i++) {
      const s = dot(q, this.vecs[i]);
      if (s >= minScore) out.push({ segmentId: this.ids[i], docId: this.docs[i], score: s });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

interface SegHit { segId: number; docId: number; ordinal: number; location: string; method: string; confidence: number | null; text: string; snippet?: string; channels: Map<string, number>; reasons: Set<string> }

function makeSnippet(text: string, needles: string[], len = 220): string {
  const lower = foldForSearch(text);
  let pos = -1;
  let hit = '';
  for (const n of needles) {
    const i = lower.indexOf(foldForSearch(n));
    if (n && i >= 0 && (pos < 0 || i < pos)) { pos = i; hit = n; }
  }
  if (pos < 0) return text.length > len ? `${text.slice(0, len)}…` : text;
  const start = Math.max(0, pos - Math.floor(len / 3));
  const end = Math.min(text.length, start + len);
  return `${start > 0 ? '…' : ''}${text.slice(start, pos)}${HL_START}${text.slice(pos, pos + hit.length)}${HL_END}${text.slice(pos + hit.length, end)}${end < text.length ? '…' : ''}`;
}

export class SearchEngine {
  readonly vectors = new VectorIndex();
  constructor(private db: DB, private embedder?: () => Embedder | undefined) {}

  async search(req: SearchRequest): Promise<{ results: SearchResult[]; parsed: ParsedQuery; tookMs: number; semantic: boolean }> {
    const t0 = Date.now();
    const db = this.db;
    const p = parseQuery(req.query);
    const filters = { ...p.filters, ...req.filters };
    const limit = req.limit ?? 30;
    const { sql: fsql, params: fparams } = filterSql(filters);
    const hits = new Map<number, SegHit>();
    const docBoost = new Map<number, { score: number; reasons: Set<string> }>();
    const addDocBoost = (docId: number, score: number, reason: string) => {
      const b = docBoost.get(docId) ?? { score: 0, reasons: new Set<string>() };
      b.score += score;
      b.reasons.add(reason);
      docBoost.set(docId, b);
    };
    const segCols = 's.id segId, s.doc_id docId, s.ordinal, s.location, s.method, s.confidence, s.text';
    const add = (row: Omit<SegHit, 'channels' | 'reasons'>, channel: string, rank: number, reason: string, snippet?: string) => {
      if (req.allowedDocIds && !req.allowedDocIds.has(row.docId)) return;
      const h = hits.get(row.segId) ?? { ...row, channels: new Map(), reasons: new Set() };
      const prev = h.channels.get(channel);
      if (prev === undefined || rank < prev) h.channels.set(channel, rank);
      h.reasons.add(reason);
      if (snippet && !h.snippet) h.snippet = snippet;
      hits.set(row.segId, h);
    };

    // 1. Full-text over content
    const fq = buildFtsQueries(p);
    if (req.mode !== 'semantic') {
      for (const [label, match] of [['and', fq.and], ['or', fq.or]] as const) {
        if (!match) continue;
        if (label === 'or' && hits.size >= limit) break;
        try {
          const rows = db.prepare(`SELECT ${segCols}, snippet(segments_fts, 0, char(2), char(3), '…', 28) snip FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid JOIN documents d ON d.id = s.doc_id WHERE segments_fts MATCH ? AND ${fsql} ORDER BY bm25(segments_fts, 1.0, 0.6) LIMIT 400`).all(match, ...fparams) as (Omit<SegHit, 'channels' | 'reasons'> & { snip: string })[];
          rows.forEach((r, i) => add(r, label === 'and' ? 'fts' : 'fts_any', i, label === 'and' ? 'content' : 'content_partial', r.snip));
        } catch { /* malformed FTS input falls through to other channels */ }
      }
    }

    // 2. Structured / exact matches
    const entityQuery = (where: string, params: (string | number)[], reason: string) => {
      const rows = db.prepare(`SELECT ${segCols}, e.original, e.offset FROM entities e JOIN segments s ON s.id = e.segment_id JOIN documents d ON d.id = e.doc_id WHERE ${where} AND ${fsql} LIMIT 200`).all(...params, ...fparams) as (Omit<SegHit, 'channels' | 'reasons'> & { original: string })[];
      rows.forEach((r, i) => add(r, 'entity', i, reason, makeSnippet(r.text, [r.original])));
    };
    for (const a of p.amounts) entityQuery("e.type = 'amount' AND abs(e.numeric - ?) < 0.005", [a], `amount:${formatMoney(a)}`);
    for (const r of p.refs) {
      if (r.type === 'any') {
        const digits = r.original.replace(/\D/g, '').replace(/^0+/, '');
        entityQuery("(e.type LIKE '%_number' OR e.type IN ('payment_reference','transaction_id','bank_account','vat_number')) AND (e.normalized = ? OR (length(?) >= 3 AND e.normalized LIKE ?))", [r.normalized, digits, `%${digits}`], `reference:${r.original}`);
      } else {
        entityQuery('e.type = ? AND e.normalized = ?', [r.type, r.normalized], `reference:${r.original}`);
      }
    }
    for (const d of p.dates) entityQuery("e.type = 'date' AND e.iso_date = ?", [d], `date:${d}`);
    for (const acc of p.accounts) entityQuery("e.type IN ('bank_account','iban') AND e.normalized = ?", [acc], `account:${acc}`);
    for (const em of p.emails) entityQuery("e.type = 'email' AND e.normalized = ?", [em], `email:${em}`);

    // 3. File name / title / folder
    if (p.terms.length) {
      const nameMatch = p.terms.map((t, i) => (i === p.terms.length - 1 && t.length >= 3 ? `${ftsQuote(t)}*` : ftsQuote(t))).join(' OR ');
      try {
        const rows = db.prepare(`SELECT d.id docId, d.name, d.title FROM documents_fts f JOIN documents d ON d.id = f.rowid WHERE documents_fts MATCH ? AND ${fsql} ORDER BY bm25(documents_fts, 2.0, 1.5, 0.5) LIMIT 100`).all(nameMatch, ...fparams) as { docId: number; name: string; title: string | null }[];
        rows.forEach((r, i) => {
          if (req.allowedDocIds && !req.allowedDocIds.has(r.docId)) return;
          const n = foldForSearch(`${r.name} ${r.title ?? ''}`);
          const matched = p.terms.filter((t) => n.includes(t)).length;
          addDocBoost(r.docId, (matched / p.terms.length) * 0.03 + 0.01 / (i + 1), 'name');
        });
      } catch { /* ignore */ }
    }

    // 4. Semantic similarity (local model)
    let semantic = false;
    const embed = this.embedder?.();
    if (embed && req.mode !== 'exact' && p.terms.length >= 2) {
      this.vectors.refresh(db);
      if (this.vectors.size) {
        const [qv] = await embed([req.query]);
        const sims = this.vectors.search(qv, 60, 0.32);
        if (sims.length) {
          semantic = true;
          const ids = sims.map((s) => s.segmentId);
          const rows = db.prepare(`SELECT ${segCols} FROM segments s JOIN documents d ON d.id = s.doc_id WHERE s.id IN (${ids.map(() => '?').join(',')}) AND ${fsql}`).all(...ids, ...fparams) as Omit<SegHit, 'channels' | 'reasons'>[];
          const byId = new Map(rows.map((r) => [r.segId, r]));
          sims.forEach((s, i) => { const r = byId.get(s.segmentId); if (r) add(r, 'semantic', i, `semantic:${s.score.toFixed(2)}`); });
        }
      }
    }

    // Fusion (reciprocal rank) per segment, then aggregate per document
    const W: Record<string, number> = { entity: 2.2, fts: 1.0, fts_any: 0.45, semantic: 0.8 };
    const perDoc = new Map<number, { score: number; segs: (SegHit & { score: number })[] }>();
    for (const h of hits.values()) {
      let s = 0;
      for (const [ch, rank] of h.channels) s += (W[ch] ?? 0.5) / (60 + rank);
      if (h.method === 'ocr' && h.confidence != null) s *= 0.85 + 0.15 * h.confidence;
      const d = perDoc.get(h.docId) ?? { score: 0, segs: [] };
      d.segs.push({ ...h, score: s });
      perDoc.set(h.docId, d);
    }
    for (const [docId, b] of docBoost) if (!perDoc.has(docId)) perDoc.set(docId, { score: 0, segs: [] });
    for (const [docId, d] of perDoc) {
      d.segs.sort((a, b) => b.score - a.score);
      d.score = (d.segs[0]?.score ?? 0) + d.segs.slice(1, 4).reduce((a, s) => a + s.score * 0.25, 0) + (docBoost.get(docId)?.score ?? 0);
      const termsCovered = p.terms.length ? p.terms.filter((t) => d.segs.some((s) => foldForSearch(s.text).includes(t))).length / p.terms.length : 0;
      d.score += termsCovered * 0.01;
    }
    const ranked = [...perDoc.entries()].sort((a, b) => b[1].score - a[1].score);
    if (!ranked.length) return { results: [], parsed: p, tookMs: Date.now() - t0, semantic };

    const docIds = ranked.slice(0, limit * 3).map(([id]) => id);
    const docs = new Map((db.prepare(`SELECT id, name, path, attachment_name, kind, title, status, mtime_ms, size, hash, parent_id FROM documents WHERE id IN (${docIds.map(() => '?').join(',')})`).all(...docIds) as { id: number; name: string; path: string; attachment_name: string; kind: string; title: string | null; status: string; mtime_ms: number; size: number; hash: string | null; parent_id: number | null }[]).map((d) => [d.id, d]));
    const byHash = new Map<string, SearchResult>();
    const results: SearchResult[] = [];
    for (const [docId, d] of ranked) {
      const doc = docs.get(docId);
      if (!doc) continue;
      const reasons = new Set<string>();
      for (const s of d.segs) for (const r of s.reasons) reasons.add(r);
      for (const r of docBoost.get(docId)?.reasons ?? []) reasons.add(r);
      const res: SearchResult = {
        docId,
        name: doc.name,
        path: doc.path,
        attachmentName: doc.attachment_name || undefined,
        kind: doc.kind,
        title: doc.title,
        status: doc.status,
        modifiedMs: doc.mtime_ms,
        size: doc.size,
        score: Number(d.score.toFixed(5)),
        reasons: explain([...reasons], p, d.segs),
        evidence: d.segs.slice(0, 3).map((s) => ({
          segmentId: s.segId,
          ordinal: s.ordinal,
          location: JSON.parse(s.location) as SegmentLocation,
          snippet: s.snippet ?? makeSnippet(s.text, [...p.phrases, ...p.terms]),
          method: s.method,
          confidence: s.confidence,
          channels: [...s.channels.keys()],
        })),
        duplicates: [],
        ocr: d.segs.some((s) => s.method === 'ocr'),
      };
      if (doc.hash) {
        const first = byHash.get(doc.hash);
        if (first) { first.duplicates.push(doc.path); continue; }
        byHash.set(doc.hash, res);
      }
      results.push(res);
      if (results.length >= limit) break;
    }
    return { results, parsed: p, tookMs: Date.now() - t0, semantic };
  }
}

function explain(reasons: string[], p: ParsedQuery, segs: SegHit[]): string[] {
  const out: string[] = [];
  const exact = reasons.filter((r) => /^(amount|reference|date|account|email):/.test(r));
  for (const r of exact) {
    const [k, v] = [r.slice(0, r.indexOf(':')), r.slice(r.indexOf(':') + 1)];
    out.push(k === 'amount' ? `Contains the amount ${v}` : k === 'reference' ? `Contains the reference ${v}` : k === 'date' ? `Contains the date ${v}` : k === 'account' ? `Contains account ${v}` : `Contains ${v}`);
  }
  if (reasons.includes('content') || reasons.includes('content_partial')) {
    const found = p.terms.filter((t) => segs.some((s) => foldForSearch(s.text).includes(t)));
    const missing = p.terms.filter((t) => !found.includes(t));
    if (found.length) out.push(`Content matches: ${found.join(', ')}${missing.length ? ` (not found: ${missing.join(', ')})` : ''}`);
  }
  if (reasons.includes('name')) out.push('File name or title matches');
  const sem = reasons.filter((r) => r.startsWith('semantic:')).map((r) => Number(r.slice(9)));
  if (sem.length) out.push(`Similar meaning to your search (similarity ${Math.max(...sem).toFixed(2)})`);
  const ocr = segs.find((s) => s.method === 'ocr');
  if (ocr) out.push(`Text recognised by OCR${ocr.confidence != null ? ` (confidence ${Math.round(ocr.confidence * 100)}%)` : ''}; verify against the original`);
  return out;
}
