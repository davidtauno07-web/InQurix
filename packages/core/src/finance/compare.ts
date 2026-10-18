import { parseAmount } from '../normalize.js';
import type { LineItem } from '../types.js';
import type { AttributeComparison, Calculation, FinDocument, Finding, FinRecord } from './types.js';
import { blankFinding, daysApart, evidenceFor, label, money, round2, sameAmount, sameItem, sameSupplier, typeName, withDocs } from './util.js';

export interface AgreedPrice { docId: number; docName: string; item: string; unitPrice: number; unit?: string; currency?: string; excerpt: string; ordinal: number; location?: FinDocument['segments'][number]['location'] }

const PRICE_CLAUSE = /(?:unit\s+)?(?:price|prices|rate|rates)\s+for\s+(.{3,80}?)\s+(?:is|are|shall be|will be)\s+(?:fixed|agreed|set)?\s*at\s+((?:[A-Z]{3}|N\$|R|\$|€|£)\s?[\d.,\s]+\d)(?:\s+per\s+(\w+))?/gi;

/** Contractual prices stated in prose, e.g. "Unit prices for A4 Copy Paper are fixed at N$ 200.00 per box". */
export function extractAgreedPrices(doc: FinDocument): AgreedPrice[] {
  const out: AgreedPrice[] = [];
  for (const s of doc.segments) {
    for (const m of s.text.matchAll(PRICE_CLAUSE)) {
      const v = parseAmount(m[2]);
      if (v === undefined) continue;
      out.push({ docId: doc.docId, docName: doc.name, item: m[1].trim(), unitPrice: v, unit: m[3], excerpt: s.text.slice(0, 300), ordinal: s.ordinal, location: s.location });
    }
  }
  return out;
}

export interface Counterparts { po?: FinRecord; quotes: FinRecord[]; deliveries: FinRecord[]; contracts: FinRecord[]; payments: FinRecord[]; links: Record<number, 'direct_evidence' | 'inferred_relationship'> }

export function findCounterparts(inv: FinRecord, records: FinRecord[]): Counterparts {
  const links: Counterparts['links'] = {};
  const sup = (r: FinRecord) => sameSupplier(inv.supplierNormalized, r.supplierNormalized) !== 'different';
  const po = inv.poReference ? records.find((r) => r.docType === 'purchase_order' && r.numberNormalized === inv.poReference) : undefined;
  if (po) links[po.id] = 'direct_evidence';
  const quotes = records.filter((r) => r.docType === 'quotation' && sup(r) && ((inv.quoteReference && r.numberNormalized === inv.quoteReference) || (!inv.quoteReference && (!r.date || !inv.date || r.date <= inv.date) && overlap(inv.lineItems, r.lineItems) >= 0.5)));
  for (const q of quotes) links[q.id] = inv.quoteReference ? 'direct_evidence' : 'inferred_relationship';
  const deliveries = records.filter((r) => r.docType === 'delivery_note' && ((inv.poReference && r.poReference === inv.poReference) || (r.invoiceReference && r.invoiceReference === inv.numberNormalized)));
  for (const d of deliveries) links[d.id] = 'direct_evidence';
  const contracts = records.filter((r) => r.docType === 'contract' && sup(r) && r.supplierNormalized);
  for (const c of contracts) links[c.id] = 'inferred_relationship';
  const payments = records.filter((r) => (r.docType === 'payment' || r.docType === 'bank_statement' || r.docType === 'remittance') && r.invoiceReference && r.invoiceReference === inv.numberNormalized);
  for (const p of payments) links[p.id] = 'direct_evidence';
  // Same delivery note can be indexed twice (scan + photo); keep one per number.
  const uniqDeliveries = [...new Map(deliveries.map((d) => [d.numberNormalized ?? String(d.id), d])).values()];
  return { po, quotes, deliveries: uniqDeliveries, contracts, payments, links };
}

function overlap(a: LineItem[], b: LineItem[]): number {
  if (!a.length || !b.length) return 0;
  return a.filter((x) => b.some((y) => sameItem(x.description, y.description) >= 0.8)).length / a.length;
}

const matchLine = (li: LineItem, others: LineItem[]) => others.map((o) => ({ o, s: sameItem(li.description, o.description) })).filter((x) => x.s >= 0.8).sort((x, y) => y.s - x.s)[0]?.o;

export interface LineDiscrepancy { invoiceId: number; item: string; kind: 'unit_price' | 'quantity_delivered' | 'quantity_ordered'; invoiced: number; reference: number; quantity: number; unitPrice: number; against: FinRecord | AgreedPrice; againstType: string; currency?: string }

/** Invoice ↔ PO / quotation / contract / delivery / payment comparison. */
export function compareInvoice(inv: FinRecord, records: FinRecord[], documents: FinDocument[] = []): { findings: Finding[]; discrepancies: LineDiscrepancy[] } {
  const cp = findCounterparts(inv, records);
  const findings: Finding[] = [];
  const discrepancies: LineDiscrepancy[] = [];
  const cur = inv.currency;
  const against = (other: FinRecord, kind: 'purchase_order' | 'quotation' | 'delivery_note') => {
    const comparisons: AttributeComparison[] = [];
    const calcs: Calculation[] = [];
    const v = (r: FinRecord, value?: string) => ({ recordId: r.id, docId: r.docId, value });
    const sup = sameSupplier(inv.supplierNormalized, other.supplierNormalized);
    comparisons.push({ attribute: 'Supplier', values: [v(inv, inv.supplier), v(other, other.supplier)], outcome: sup === 'same' ? 'same' : sup === 'similar' ? 'equivalent' : sup === 'unknown' ? 'missing' : 'different' });
    if (inv.currency || other.currency) comparisons.push({ attribute: 'Currency', values: [v(inv, inv.currency), v(other, other.currency)], outcome: inv.currency && other.currency ? (inv.currency === other.currency ? 'same' : 'different') : 'missing' });
    for (const li of inv.lineItems) {
      const o = matchLine(li, other.lineItems);
      if (!o) {
        if (other.lineItems.length) comparisons.push({ attribute: `Line: ${li.description}`, values: [v(inv, li.original), v(other, undefined)], outcome: 'missing', note: `Not found on the ${typeName(kind).toLowerCase()}` });
        continue;
      }
      if (kind !== 'delivery_note' && li.unitPrice !== undefined && o.unitPrice !== undefined) {
        const same = sameAmount(li.unitPrice, o.unitPrice);
        comparisons.push({ attribute: `Unit price: ${li.description}`, values: [v(inv, money(li.unitPrice, cur)), v(other, money(o.unitPrice, other.currency ?? cur))], outcome: same ? 'same' : 'different' });
        if (!same && li.unitPrice > o.unitPrice) {
          const q = li.quantity ?? 1;
          calcs.push({ description: `${li.description}: invoiced unit price above ${typeName(kind).toLowerCase()}`, expression: `(${money(li.unitPrice, cur)} − ${money(o.unitPrice, cur)}) × ${q}`, result: round2((li.unitPrice - o.unitPrice) * q), currency: cur });
          discrepancies.push({ invoiceId: inv.id, item: li.description, kind: 'unit_price', invoiced: li.unitPrice, reference: o.unitPrice, quantity: q, unitPrice: li.unitPrice, against: other, againstType: kind, currency: cur });
        }
      }
      if (li.quantity !== undefined && o.quantity !== undefined) {
        const same = li.quantity === o.quantity;
        comparisons.push({ attribute: `Quantity: ${li.description}`, values: [v(inv, String(li.quantity)), v(other, String(o.quantity))], outcome: same ? 'same' : 'different', note: kind === 'delivery_note' && !same ? 'Delivered quantity differs from invoiced quantity' : undefined });
        if (!same && li.quantity > o.quantity && (kind === 'delivery_note' || kind === 'purchase_order')) {
          const up = li.unitPrice ?? 0;
          calcs.push({ description: `${li.description}: invoiced quantity above ${kind === 'delivery_note' ? 'delivered' : 'ordered'} quantity`, expression: `(${li.quantity} − ${o.quantity}) × ${money(up, cur)}`, result: round2((li.quantity - o.quantity) * up), currency: cur });
          discrepancies.push({ invoiceId: inv.id, item: li.description, kind: kind === 'delivery_note' ? 'quantity_delivered' : 'quantity_ordered', invoiced: li.quantity, reference: o.quantity, quantity: li.quantity - o.quantity, unitPrice: up, against: other, againstType: kind, currency: cur });
        }
      }
    }
    const invNet = inv.subtotal ?? (inv.total !== undefined && inv.tax !== undefined ? round2(inv.total - inv.tax) : undefined);
    if (kind !== 'delivery_note' && invNet !== undefined && other.total !== undefined) {
      comparisons.push({ attribute: 'Total before tax', values: [v(inv, money(invNet, cur)), v(other, money(other.total, other.currency ?? cur))], outcome: sameAmount(invNet, other.total) ? 'same' : 'different', note: inv.subtotal === undefined ? 'Invoice net calculated as total minus tax' : undefined });
      if (!sameAmount(invNet, other.total)) calcs.push({ description: `Invoice net vs ${typeName(kind).toLowerCase()} total`, expression: `${money(invNet, cur)} − ${money(other.total, cur)}`, result: round2(invNet - other.total), currency: cur });
    }
    if (inv.paymentTermsDays !== undefined && other.paymentTermsDays !== undefined) comparisons.push({ attribute: 'Payment terms', values: [v(inv, `${inv.paymentTermsDays} days`), v(other, `${other.paymentTermsDays} days`)], outcome: inv.paymentTermsDays === other.paymentTermsDays ? 'same' : 'different' });
    const diffs = comparisons.filter((c) => c.outcome === 'different');
    const isLink = cp.links[other.id];
    const f = blankFinding({
      id: `cmp-${inv.id}-${other.id}`,
      investigation: 'invoice_comparison',
      kind: `invoice_vs_${kind}`,
      label: diffs.length ? (kind === 'purchase_order' ? 'Invoice and purchase-order mismatch' : kind === 'delivery_note' ? 'Invoice and delivery mismatch' : 'Invoice differs from quotation') : `Invoice consistent with ${typeName(kind).toLowerCase()}`,
      title: `${label(inv)} vs ${label(other)}`,
      summary: diffs.length ? `${diffs.length} difference${diffs.length > 1 ? 's' : ''}: ${diffs.map((d) => d.attribute).join('; ')}.` : 'No differences in the compared attributes.',
      classification: diffs.length ? 'potential_discrepancy' : 'direct_evidence',
      strength: diffs.length && isLink === 'direct_evidence' ? 'strong' : 'moderate',
      comparisons,
      calculations: calcs,
      evidence: [evidenceFor(inv, 'number', inv.number), evidenceFor(other, 'number', other.number)],
      assumptions: isLink === 'inferred_relationship' ? [`The ${typeName(kind).toLowerCase()} is not referenced on the invoice; it was matched by supplier and line items.`] : [],
      limitations: [
        kind === 'quotation' ? 'A quotation is an offer, not an agreed price; a later negotiated price may legitimately differ.' : kind === 'delivery_note' ? 'A delivery note records what was received on one delivery; partial or later deliveries may exist outside the indexed folders.' : 'A purchase order states what was ordered; approved changes may exist outside the indexed folders.',
        ...(other.docName && records.find((r) => r.id === other.id)?.segmentText ? [] : []),
      ],
      verification: diffs.length ? ['Open both originals and confirm the values.', 'Ask the supplier or approver whether a price or quantity change was agreed.'] : [],
    });
    findings.push(withDocs(f, [inv, other]));
  };
  if (cp.po) against(cp.po, 'purchase_order');
  for (const q of cp.quotes) against(q, 'quotation');
  for (const d of cp.deliveries) against(d, 'delivery_note');

  // Contract pricing stated in prose
  const contractDocs = new Set(cp.contracts.map((c) => c.docId));
  for (const doc of documents.filter((d) => contractDocs.has(d.docId))) {
    const contract = cp.contracts.find((c) => c.docId === doc.docId)!;
    for (const ap of extractAgreedPrices(doc)) {
      const li = inv.lineItems.find((l) => sameItem(l.description, ap.item) >= 0.8);
      if (!li || li.unitPrice === undefined) continue;
      const diff = !sameAmount(li.unitPrice, ap.unitPrice);
      const q = li.quantity ?? 1;
      const f = blankFinding({
        id: `cmp-${inv.id}-contract-${doc.docId}-${ap.ordinal}`,
        investigation: 'invoice_comparison',
        kind: 'invoice_vs_contract',
        label: diff ? 'Invoiced price differs from contract price' : 'Invoiced price matches contract price',
        title: `${label(inv)} vs ${doc.name}: ${li.description}`,
        summary: diff ? `Invoiced at ${money(li.unitPrice, inv.currency)} per unit; the contract states ${money(ap.unitPrice, inv.currency)}${ap.unit ? ` per ${ap.unit}` : ''}.` : 'The invoiced unit price matches the contract clause.',
        classification: diff ? 'potential_discrepancy' : 'direct_evidence',
        strength: diff ? 'strong' : 'moderate',
        comparisons: [{ attribute: `Unit price: ${li.description}`, values: [{ recordId: inv.id, docId: inv.docId, value: money(li.unitPrice, inv.currency) }, { recordId: contract.id, docId: doc.docId, value: money(ap.unitPrice, inv.currency) }], outcome: diff ? 'different' : 'same' }],
        calculations: diff && li.unitPrice > ap.unitPrice ? [{ description: `${li.description}: invoiced above contract price`, expression: `(${money(li.unitPrice, inv.currency)} − ${money(ap.unitPrice, inv.currency)}) × ${q}`, result: round2((li.unitPrice - ap.unitPrice) * q), currency: inv.currency }] : [],
        evidence: [evidenceFor(inv, 'number', inv.number), { documentId: String(doc.docId), documentName: doc.name, segmentOrdinal: ap.ordinal, location: ap.location, excerpt: ap.excerpt, field: 'agreed price', originalValue: money(ap.unitPrice, inv.currency), method: 'record' }],
        assumptions: ['The contract was matched to the invoice by supplier; check that the invoice falls within the contract term.'],
        limitations: ['Only price clauses written as "price(s) for <item> … at <amount>" are read. Other contract wording is not interpreted.'],
        verification: diff ? ['Check whether a price amendment to the contract exists.'] : [],
      });
      findings.push(withDocs(f, [inv, contract]));
      if (diff && li.unitPrice > ap.unitPrice) discrepancies.push({ invoiceId: inv.id, item: li.description, kind: 'unit_price', invoiced: li.unitPrice, reference: ap.unitPrice, quantity: q, unitPrice: li.unitPrice, against: ap, againstType: 'contract', currency: inv.currency });
    }
  }

  // Payments against the invoice
  for (const p of cp.payments) {
    if (inv.total === undefined || p.total === undefined) continue;
    const same = sameAmount(inv.total, p.total);
    const dd = daysApart(inv.date, p.date);
    if (same && (!inv.bank?.accountNumber || !p.bank?.accountNumber || inv.bank.accountNumber === p.bank.accountNumber)) continue;
    const f = blankFinding({
      id: `cmp-${inv.id}-pay-${p.id}`,
      investigation: 'invoice_comparison',
      kind: 'payment_vs_invoice',
      label: same ? 'Payment made to a different account than the invoice states' : 'Payment amount differs from invoice',
      title: `${label(p)} vs ${label(inv)}`,
      summary: same ? `Paid to ${p.bank?.accountNumber}; this invoice gives ${inv.bank?.accountNumber}.` : `Paid ${money(p.total, p.currency ?? inv.currency)} against an invoice total of ${money(inv.total, inv.currency)}.`,
      classification: 'potential_discrepancy',
      strength: 'moderate',
      comparisons: [
        { attribute: 'Amount', values: [{ recordId: inv.id, docId: inv.docId, value: money(inv.total, inv.currency) }, { recordId: p.id, docId: p.docId, value: money(p.total, p.currency ?? inv.currency) }], outcome: same ? 'same' : 'different' },
        { attribute: 'Account', values: [{ recordId: inv.id, docId: inv.docId, value: inv.bank?.accountNumber }, { recordId: p.id, docId: p.docId, value: p.bank?.accountNumber }], outcome: !inv.bank?.accountNumber || !p.bank?.accountNumber ? 'missing' : inv.bank.accountNumber === p.bank.accountNumber ? 'same' : 'different' },
      ],
      calculations: same ? [] : [{ description: 'Difference between invoice and payment', expression: `${money(inv.total, inv.currency)} − ${money(p.total, inv.currency)}`, result: round2(inv.total - p.total), currency: inv.currency }],
      evidence: [evidenceFor(inv, 'total', money(inv.total, inv.currency)), evidenceFor(p, 'total', money(p.total, p.currency))],
      limitations: ['A partial payment, discount or instalment can legitimately differ from the invoice total.', ...(dd !== undefined ? [`Payment recorded ${dd} days after the invoice date.`] : [])],
      verification: ['Confirm the payment against the bank statement and the supplier’s statement of account.'],
    });
    findings.push(withDocs(f, [inv, p]));
  }
  return { findings, discrepancies };
}
