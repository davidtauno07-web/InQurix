import { addDays, addMonths } from '../normalize.js';
import type { Finding, FinDocument, FinRecord, Obligation } from './types.js';
import { blankFinding, evidenceFor, label, money, withDocs } from './util.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[/.](\d{1,2})[/.](\d{4})|(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i;

export function parseTextDate(s: string): string | undefined {
  const m = s.match(DATE_RE);
  if (!m) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (m[1]) return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4]) return `${m[6]}-${pad(+m[5])}-${pad(+m[4])}`;
  return `${m[9]}-${pad(MONTHS.indexOf(m[8].toLowerCase()) + 1)}-${pad(+m[7])}`;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

interface Found { ob: Obligation; title: string; record?: FinRecord; doc?: FinDocument; ordinal?: number; excerpt?: string; amount?: number; currency?: string }

/** Contract dates written in prose: start, term, renewal and notice. */
export function contractObligations(doc: FinDocument): Found[] {
  const out: Found[] = [];
  const text = doc.segments.map((s) => s.text).join('\n');
  const seg = (re: RegExp) => doc.segments.find((s) => re.test(s.text));
  const startRe = /(?:commenc\w*|start\w*|effective)\s+(?:on|from)?\s*([^.;\n]{6,40})/i;
  const startSeg = seg(startRe);
  const start = startSeg ? parseTextDate(startSeg.text.match(startRe)![1]) : undefined;
  const termRe = /(?:period|term)\s+of\s+(\d{1,3})\s+months/i;
  const months = text.match(termRe)?.[1];
  const endRe = /(?:expir\w*|end\w*|terminat\w*)\s+on\s+([^.;\n]{6,40})/i;
  const explicitEndSeg = seg(endRe);
  const explicitEnd = explicitEndSeg ? parseTextDate(explicitEndSeg.text.match(endRe)![1]) : undefined;
  const noticeDays = text.match(/(\d{1,3})\s+days['’]?\s+(?:prior\s+)?(?:written\s+)?notice/i)?.[1];
  const autoRenew = /automatic(?:ally)?\s+renew|auto-?renew/i.test(text);
  const ex = (s?: { text: string }) => s?.text.slice(0, 300);
  if (start) out.push({ ob: { kind: 'contract_start', date: start, basis: 'explicit' }, title: `Contract start: ${doc.name}`, doc, ordinal: startSeg?.ordinal, excerpt: ex(startSeg) });
  const end = explicitEnd ?? (start && months ? addDays(addMonths(start, +months), -1) : undefined);
  if (end) out.push({ ob: { kind: autoRenew ? 'renewal' : 'contract_end', date: end, basis: explicitEnd ? 'explicit' : 'calculated', sourceDate: explicitEnd ? undefined : start, method: explicitEnd ? undefined : `start ${start} + ${months} months − 1 day` }, title: `${autoRenew ? 'Automatic renewal' : 'Contract end'}: ${doc.name}`, doc, ordinal: (explicitEndSeg ?? seg(termRe))?.ordinal, excerpt: ex(explicitEndSeg ?? seg(termRe)) });
  if (end && noticeDays) {
    const nseg = seg(/days['’]?\s+(?:prior\s+)?(?:written\s+)?notice/i);
    out.push({ ob: { kind: 'notice_deadline', date: addDays(end, -+noticeDays + 1), basis: 'calculated', sourceDate: end, method: `${autoRenew ? 'renewal' : 'end'} date ${end} − ${noticeDays} days notice` }, title: `Last day to give notice${autoRenew ? ' before automatic renewal' : ''}: ${doc.name}`, doc, ordinal: nseg?.ordinal, excerpt: ex(nseg) });
  }
  return out;
}

export function findObligations(records: FinRecord[], documents: FinDocument[] = [], today = iso(new Date())): Finding[] {
  const found: Found[] = [];
  const seenInvoice = new Set<string>();
  for (const r of records) {
    if (r.docType === 'invoice') {
      const key = r.numberNormalized ?? String(r.id);
      if (seenInvoice.has(key)) continue;
      seenInvoice.add(key);
      if (r.dueDate) found.push({ ob: { kind: 'payment_due', date: r.dueDate, basis: 'explicit' }, title: `Payment due: ${label(r)}`, record: r, amount: r.total, currency: r.currency });
      else if (r.date && r.paymentTermsDays !== undefined) found.push({ ob: { kind: 'payment_due', date: addDays(r.date, r.paymentTermsDays), basis: 'calculated', sourceDate: r.date, method: `invoice date ${r.date} + ${r.paymentTermsDays} days payment terms` }, title: `Payment due: ${label(r)}`, record: r, amount: r.total, currency: r.currency });
    }
    if (r.docType === 'quotation' && r.dueDate) found.push({ ob: { kind: 'quote_expiry', date: r.dueDate, basis: 'explicit' }, title: `Quotation valid until: ${label(r)}`, record: r });
    if (r.docType === 'subscription' && r.dueDate) found.push({ ob: { kind: 'renewal', date: r.dueDate, basis: 'explicit' }, title: `Subscription renewal: ${label(r)}`, record: r, amount: r.total, currency: r.currency });
  }
  for (const d of documents) found.push(...contractObligations(d));
  const soon = addDays(today, 60);
  return found
    .sort((a, b) => a.ob.date.localeCompare(b.ob.date))
    .map((x, i) => {
      const upcoming = x.ob.date >= today && x.ob.date <= soon;
      const f = blankFinding({
        id: `ob-${i}-${x.record?.id ?? `d${x.doc?.docId}`}-${x.ob.kind}`,
        investigation: 'obligations',
        kind: x.ob.kind,
        label: x.ob.basis === 'explicit' ? 'Date stated in document' : 'Calculated date',
        title: x.title,
        summary: `${x.ob.date}${x.ob.basis === 'calculated' ? ` (calculated: ${x.ob.method})` : ''}${x.amount !== undefined ? ` — ${money(x.amount, x.currency)}` : ''}${x.ob.date < today ? ' — in the past' : upcoming ? ' — within 60 days' : ''}.`,
        classification: x.ob.basis === 'explicit' ? 'direct_evidence' : 'inferred_relationship',
        strength: x.ob.basis === 'explicit' ? 'strong' : 'moderate',
        obligation: x.ob,
        evidence: x.record ? [evidenceFor(x.record, x.ob.kind === 'payment_due' && x.ob.basis === 'calculated' ? 'date' : 'dueDate', x.ob.date)] : [{ documentId: String(x.doc!.docId), documentName: x.doc!.name, segmentOrdinal: x.ordinal, excerpt: x.excerpt, field: x.ob.kind, originalValue: x.ob.date }],
        assumptions: x.ob.basis === 'calculated' ? ['Calculated in calendar days; weekends, public holidays and amendments are not considered.'] : [],
        limitations: x.ob.kind === 'notice_deadline' ? ['Check the contract for how notice must be delivered.'] : [],
      });
      return x.record ? withDocs(f, [x.record]) : Object.assign(f, { docIds: [x.doc!.docId] });
    });
}
