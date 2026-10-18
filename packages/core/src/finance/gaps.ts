import type { Finding, FinRecord } from './types.js';
import { blankFinding, evidenceFor, label, money, sameAmount, typeName, withDocs } from './util.js';

const NOT_FOUND = 'Not found in the authorised, indexed sources. This does not prove the document does not exist — it may be stored elsewhere, unreadable, or not yet indexed.';

/** Missing supporting records. Absence is always reported as "not found", never as proof. */
export function findRecordGaps(records: FinRecord[]): Finding[] {
  const out: Finding[] = [];
  const byNum = (t: string, n?: string) => (n ? records.filter((r) => r.docType === t && r.numberNormalized === n) : []);
  const gap = (id: string, r: FinRecord, kind: string, title: string, summary: string, extra: Partial<Finding> = {}) =>
    out.push(withDocs(blankFinding({ id, investigation: 'record_gaps', kind, label: 'Record not found in indexed sources', title, summary, classification: 'missing_evidence', strength: 'moderate', evidence: [evidenceFor(r, 'number', r.number)], limitations: [NOT_FOUND], verification: ['Search the accounting system and shared drives, or add the folder that holds these records.'], ...extra }), [r]));

  const invoices = records.filter((r) => r.docType === 'invoice');
  const payments = records.filter((r) => ['payment', 'bank_statement', 'remittance'].includes(r.docType) && r.direction !== 'in');
  const deliveries = records.filter((r) => r.docType === 'delivery_note');
  const seenInvoiceNums = new Set<string>();
  for (const inv of invoices) {
    if (inv.poReference && !byNum('purchase_order', inv.poReference).length) gap(`gap-po-${inv.id}`, inv, 'missing_purchase_order', `${label(inv)} references a purchase order that was not found`, `The invoice cites ${inv.poReference.replace(/^po:/, 'PO-').toUpperCase()}.`);
    if (inv.numberNormalized && seenInvoiceNums.has(inv.numberNormalized)) continue;
    if (inv.numberNormalized) seenInvoiceNums.add(inv.numberNormalized);
    const paid = payments.some((p) => (p.invoiceReference && p.invoiceReference === inv.numberNormalized) || (sameAmount(p.total, inv.total) && p.supplierNormalized && p.supplierNormalized === inv.supplierNormalized));
    if (!paid) gap(`gap-pay-${inv.id}`, inv, 'missing_payment', `No payment found for ${label(inv)}`, `Invoice total ${money(inv.total, inv.currency)}${inv.dueDate ? `, due ${inv.dueDate}` : ''}.`, { limitations: [NOT_FOUND, 'The invoice may be unpaid, paid from an account whose statements are not indexed, or paid in a batch without a reference.'] });
    if (inv.poReference && byNum('purchase_order', inv.poReference).length && !deliveries.some((d) => d.poReference === inv.poReference || d.invoiceReference === inv.numberNormalized) && inv.lineItems.length) gap(`gap-dn-${inv.id}`, inv, 'missing_delivery', `No delivery confirmation found for ${label(inv)}`, 'Goods were invoiced against a purchase order but no delivery note referencing that order was found.');
  }
  for (const p of payments) {
    if (p.invoiceReference && !invoices.some((i) => i.numberNormalized === p.invoiceReference)) gap(`gap-inv-${p.id}`, p, 'missing_invoice', `${label(p)} references an invoice that was not found`, `${money(p.total, p.currency)} paid against ${p.invoiceReference.replace(/^inv:/, 'INV-').toUpperCase()}.`);
  }
  for (const d of deliveries) {
    if (d.poReference && !byNum('purchase_order', d.poReference).length) gap(`gap-dnpo-${d.id}`, d, 'missing_purchase_order', `${label(d)} references a purchase order that was not found`, `${typeName(d.docType)} cites ${d.poReference}.`);
  }
  return out;
}
