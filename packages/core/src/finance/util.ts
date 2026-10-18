import { editDistance, foldForSearch, formatMoney, jaccard, round2 } from '../normalize.js';
import type { EvidenceRef } from '../types.js';
import type { FinRecord, Finding } from './types.js';

export const money = (n: number | undefined, c?: string) => (n === undefined ? '—' : formatMoney(n, c));
export const sameAmount = (a?: number, b?: number) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.005;
export { round2 };

export function sameSupplier(a?: string, b?: string): 'same' | 'similar' | 'different' | 'unknown' {
  if (!a || !b) return 'unknown';
  if (a === b) return 'same';
  if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return 'similar';
  if (editDistance(a, b, 3) <= 2 && Math.min(a.length, b.length) > 8) return 'similar';
  return 'different';
}

export function supplierKey(r: FinRecord): string | undefined {
  return r.supplierNormalized;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'box', 'x', 'per', 'qty']);
export const descTokens = (s: string) => foldForSearch(s).replace(/[()]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
export function sameItem(a: string, b: string): number {
  const ta = descTokens(a), tb = descTokens(b);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  return jaccard(ta.join(' '), tb.join(' '));
}

export const daysApart = (a?: string, b?: string) => (a && b ? Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000) : undefined);

export const label = (r: FinRecord) => `${typeName(r.docType)} ${r.number ?? r.paymentReference ?? ''}`.trim() + ` (${r.docName}${r.rowLocation?.row ? `, row ${r.rowLocation.row}` : ''})`;

export function typeName(t: string): string {
  return ({ invoice: 'Invoice', purchase_order: 'Purchase order', quotation: 'Quotation', delivery_note: 'Delivery note', payment: 'Payment record', bank_statement: 'Bank transaction', credit_note: 'Credit note', contract: 'Contract', remittance: 'Remittance', subscription: 'Subscription', other: 'Document' } as Record<string, string>)[t] ?? t;
}

export function evidenceFor(r: FinRecord, field: string, value?: string): EvidenceRef {
  const ord = r.fieldSources[field];
  const seg = ord !== undefined ? r.segmentText?.[ord] : undefined;
  return {
    documentId: String(r.docId),
    documentName: r.docName,
    segmentOrdinal: ord,
    location: seg?.location ?? r.rowLocation,
    excerpt: seg?.text?.slice(0, 300),
    field,
    originalValue: value,
    method: 'record',
  };
}

export function blankFinding(partial: Pick<Finding, 'id' | 'investigation' | 'kind' | 'label' | 'title' | 'summary' | 'classification' | 'strength'> & Partial<Finding>): Finding {
  return { recordIds: [], docIds: [], comparisons: [], calculations: [], assumptions: [], limitations: [], verification: [], unresolved: [], evidence: [], overlapsWith: [], ...partial };
}

export function withDocs(f: Finding, records: FinRecord[]): Finding {
  f.recordIds = [...new Set([...f.recordIds, ...records.map((r) => r.id)])];
  f.docIds = [...new Set([...f.docIds, ...records.map((r) => r.docId)])];
  return f;
}

export const displayRef = (n?: string) => n;
