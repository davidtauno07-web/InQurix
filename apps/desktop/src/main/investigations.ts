import {
  INVESTIGATIONS, foldForSearch, runInvestigation,
  type BusinessRecord, type DocumentMetadata, type FinDocument, type FinRecord, type Finding, type InvestigationResult, type InvestigationType, type SegmentLocation,
} from '@inqurix/core';
import { now, type DB } from './db/index.js';

export interface InvestigationParams { supplier?: string; docIds?: number[] }
export type ReviewStatus = 'open' | 'confirmed' | 'dismissed' | 'resolved';
export interface StoredResult extends InvestigationResult { reviews: Record<string, { status: ReviewStatus; note?: string; at: string }> }

const MAX_DOCS = 5000;

/** Loads structured records and the text of documents the checks read (records, emails, attachments). */
export function loadFinanceData(db: DB, params: InvestigationParams = {}): { records: FinRecord[]; documents: FinDocument[] } {
  const rows = db.prepare(`SELECT r.id, r.doc_id docId, r.data, d.name, d.attachment_name att, d.path, d.mtime_ms mtime FROM records r JOIN documents d ON d.id = r.doc_id WHERE d.status IN ('indexed','partial') ORDER BY r.id`).all() as { id: number; docId: number; data: string; name: string; att: string; path: string; mtime: number }[];
  const docRows = db.prepare(`SELECT id, parent_id parentId, name, attachment_name att, path, mtime_ms mtime, metadata FROM documents WHERE status IN ('indexed','partial') AND (id IN (SELECT doc_id FROM records) OR kind = 'eml' OR parent_id IS NOT NULL) ORDER BY id LIMIT ${MAX_DOCS}`).all() as { id: number; parentId: number | null; name: string; att: string; path: string; mtime: number; metadata: string | null }[];
  const segStmt = db.prepare('SELECT ordinal, text, location FROM segments WHERE doc_id = ? ORDER BY ordinal');
  const segs = new Map<number, { ordinal: number; text: string; location?: SegmentLocation }[]>();
  for (const d of docRows) segs.set(d.id, (segStmt.all(d.id) as { ordinal: number; text: string; location: string }[]).map((s) => ({ ordinal: s.ordinal, text: s.text, location: JSON.parse(s.location) as SegmentLocation })));
  let records: FinRecord[] = rows.map((r) => {
    const rec = JSON.parse(r.data) as BusinessRecord;
    const text = Object.fromEntries((segs.get(r.docId) ?? []).filter((s) => Object.values(rec.fieldSources).includes(s.ordinal)).map((s) => [s.ordinal, { text: s.text, location: s.location }]));
    return { ...rec, id: r.id, docId: r.docId, docName: r.att || r.name, docPath: r.path, modifiedMs: r.mtime, segmentText: text };
  });
  let documents: FinDocument[] = docRows.map((d) => ({ docId: d.id, parentId: d.parentId ?? undefined, name: d.att || d.name, path: d.path, modifiedMs: d.mtime, segments: segs.get(d.id) ?? [], email: d.metadata ? (JSON.parse(d.metadata) as DocumentMetadata).email : undefined }));
  if (params.docIds?.length) {
    const ids = new Set(params.docIds);
    for (const d of documents) if (d.parentId !== undefined && ids.has(d.parentId)) ids.add(d.docId);
    records = records.filter((r) => ids.has(r.docId));
    documents = documents.filter((d) => ids.has(d.docId));
  }
  if (params.supplier?.trim()) {
    const s = foldForSearch(params.supplier);
    records = records.filter((r) => r.supplierNormalized?.includes(s) || foldForSearch(r.supplier ?? '').includes(s));
    documents = documents.filter((d) => d.segments.some((x) => foldForSearch(x.text).includes(s)));
  }
  return { records, documents };
}

export function isInvestigationType(t: unknown): t is InvestigationType {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(INVESTIGATIONS, t);
}

export function runAndStore(db: DB, type: InvestigationType, params: InvestigationParams = {}): number {
  const title = `${INVESTIGATIONS[type].title}${params.supplier ? ` — ${params.supplier}` : ''}`;
  const id = Number(db.prepare('INSERT INTO investigations (type, title, params, status, created_at) VALUES (?, ?, ?, ?, ?)').run(type, title, JSON.stringify(params), 'running', now()).lastInsertRowid);
  try {
    const data = loadFinanceData(db, params);
    const result: StoredResult = { ...runInvestigation(type, { ...data, today: new Date().toISOString().slice(0, 10) }), reviews: {} };
    db.prepare('UPDATE investigations SET status = ?, completed_at = ?, result = ? WHERE id = ?').run('completed', now(), JSON.stringify(result), id);
  } catch (e) {
    db.prepare('UPDATE investigations SET status = ?, completed_at = ?, error = ? WHERE id = ?').run('failed', now(), e instanceof Error ? e.message : String(e), id);
  }
  return id;
}

export function getInvestigation(db: DB, id: number) {
  const row = db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as { id: number; type: string; title: string; params: string; status: string; created_at: string; completed_at: string | null; result: string | null; error: string | null } | undefined;
  if (!row) return undefined;
  return { ...row, params: JSON.parse(row.params) as InvestigationParams, result: row.result ? (JSON.parse(row.result) as StoredResult) : null };
}

export function reviewFinding(db: DB, id: number, findingId: string, status: ReviewStatus, note?: string): boolean {
  const inv = getInvestigation(db, id);
  if (!inv?.result || !inv.result.findings.some((f) => f.id === findingId)) return false;
  if (!['open', 'confirmed', 'dismissed', 'resolved'].includes(status)) return false;
  inv.result.reviews[findingId] = { status, note: note?.slice(0, 2000), at: now() };
  db.prepare('UPDATE investigations SET result = ? WHERE id = ?').run(JSON.stringify(inv.result), id);
  return true;
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralise spreadsheet formula injection
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function exportInvestigation(db: DB, id: number, format: 'md' | 'json' | 'csv'): string | undefined {
  const inv = getInvestigation(db, id);
  if (!inv?.result) return undefined;
  const r = inv.result;
  const docName = (f: Finding) => f.evidence.map((e) => e.documentName).filter((x, i, a) => x && a.indexOf(x) === i).join('; ');
  const review = (f: Finding) => r.reviews[f.id]?.status ?? 'open';
  if (format === 'json') return JSON.stringify({ id: inv.id, title: inv.title, created: inv.created_at, params: inv.params, ...r }, null, 2);
  if (format === 'csv') {
    const head = ['id', 'label', 'title', 'summary', 'classification', 'strength', 'grade', 'amount', 'currency', 'amount_nature', 'date', 'date_basis', 'documents', 'review', 'review_note'];
    return [head.join(','), ...r.findings.map((f) => [f.id, f.label, f.title, f.summary, f.classification, f.strength, f.grade ?? '', f.amount?.value ?? '', f.amount?.currency ?? '', f.amount?.nature ?? '', f.obligation?.date ?? '', f.obligation?.basis ?? '', docName(f), review(f), r.reviews[f.id]?.note ?? ''].map(csvCell).join(','))].join('\n');
  }
  const L: string[] = [`# ${inv.title}`, '', `Run ${inv.completed_at ?? inv.created_at} · ${r.findings.length} findings`, '', `**Objective:** ${r.objective}`, '', ...r.notes.map((n) => `- ${n}`), ''];
  if (r.totals) L.push(`**Totals (overlaps counted once):** documented overcharge ${r.totals.documentedOvercharge}, potential saving ${r.totals.potentialSaving}, amount at risk ${r.totals.amountAtRisk} ${r.totals.currency ?? ''}`, '');
  L.push('> Findings are evidence for review, not conclusions. Indicators are not proof of fraud. Absence of a record means it was not found in the authorised, indexed folders.', '');
  for (const f of r.findings) {
    L.push(`## ${f.label}: ${f.title}`, '', f.summary, '', `Classification: ${f.classification.replace(/_/g, ' ')} · Evidence strength: ${f.strength}${f.grade ? ` · Grade: ${f.grade}` : ''} · Review: ${review(f)}`, '');
    if (f.comparisons.length) {
      L.push('| Attribute | Values | Outcome |', '|---|---|---|');
      for (const c of f.comparisons) L.push(`| ${c.attribute} | ${c.values.map((v) => v.value ?? '—').join(' / ').replace(/\|/g, '\\|')} | ${c.outcome}${c.note ? ` (${c.note})` : ''} |`);
      L.push('');
    }
    const sec = (t: string, xs: string[]) => { if (xs.length) L.push(`**${t}**`, ...xs.map((x) => `- ${x}`), ''); };
    sec('Calculations', f.calculations.map((c) => `${c.description}: ${c.expression} = ${c.result} ${c.currency ?? ''}`));
    sec('Assumptions', f.assumptions);
    sec('Unresolved questions', f.unresolved);
    sec('Limitations', f.limitations);
    sec('Verification steps', f.verification);
    sec('Evidence', f.evidence.map((e) => `${e.documentName}${e.field ? ` — ${e.field}` : ''}${e.originalValue ? `: ${e.originalValue}` : ''}${e.excerpt ? ` — “${e.excerpt.replace(/\s+/g, ' ').slice(0, 160)}”` : ''}`));
    if (r.reviews[f.id]?.note) sec('Reviewer note', [r.reviews[f.id].note!]);
  }
  return L.join('\n');
}
