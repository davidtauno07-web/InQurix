import { compareInvoice, findCounterparts, type LineDiscrepancy } from './compare.js';
import { findDuplicateInvoices, findDuplicatePayments } from './duplicates.js';
import type { FinDocument, Finding, FinRecord } from './types.js';
import { blankFinding, label, money, round2, sameItem } from './util.js';

const REF_RANK: Record<string, number> = { contract: 3, purchase_order: 2, quotation: 1 };

/**
 * Cost-saving and recovery opportunities. Each overcharged invoice line is counted once, against the
 * strongest price reference (contract > purchase order > quotation); undelivered quantities are valued at
 * the reference price so price and quantity differences never overlap.
 */
export function findCostSavings(records: FinRecord[], documents: FinDocument[] = []): Finding[] {
  const out: Finding[] = [];
  const invoices = records.filter((r) => r.docType === 'invoice');
  const dupes = findDuplicateInvoices(records).filter((d) => d.grade !== 'weak');
  // Analyse one invoice per duplicate group so the same overcharge is not counted for each copy.
  const skip = new Set<number>();
  for (const d of dupes) {
    const members = invoices.filter((i) => d.recordIds.includes(i.id)).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    for (const m of members.slice(1)) skip.add(m.id);
  }
  for (const inv of invoices) {
    if (skip.has(inv.id)) continue;
    const { discrepancies } = compareInvoice(inv, records, documents);
    if (!discrepancies.length) continue;
    const priceByItem = new Map<string, LineDiscrepancy>();
    for (const d of discrepancies.filter((x) => x.kind === 'unit_price')) {
      const key = [...priceByItem.keys()].find((k) => sameItem(k, d.item) >= 0.8) ?? d.item;
      const cur = priceByItem.get(key);
      if (!cur || REF_RANK[d.againstType] > REF_RANK[cur.againstType]) priceByItem.set(key, d);
    }
    const undelivered = discrepancies.filter((x) => x.kind === 'quantity_delivered');
    const calcs: Finding['calculations'] = [];
    const notes: string[] = [];
    const po = findCounterparts(inv, records).po;
    for (const [k, d] of [...priceByItem]) {
      if (d.againstType !== 'quotation' || !po) continue;
      const poLine = po.lineItems.find((l) => sameItem(l.description, d.item) >= 0.8);
      if (poLine?.unitPrice !== undefined && Math.abs(poLine.unitPrice - d.invoiced) < 0.005) {
        priceByItem.delete(k);
        notes.push(`${d.item}: the invoiced price differs from the quotation but matches the purchase order, so it is not counted.`);
      }
    }
    for (const [, d] of priceByItem) {
      const refName = d.againstType === 'contract' ? `contract price (${'docName' in d.against ? d.against.docName : ''})` : d.againstType === 'purchase_order' ? 'purchase-order price' : 'quoted price';
      calcs.push({ description: `${d.item}: invoiced at ${money(d.invoiced, d.currency)} vs ${refName} ${money(d.reference, d.currency)}`, expression: `(${d.invoiced} − ${d.reference}) × ${d.quantity}`, result: round2((d.invoiced - d.reference) * d.quantity), currency: d.currency });
      const weaker = discrepancies.filter((x) => x.kind === 'unit_price' && x !== d && sameItem(x.item, d.item) >= 0.8);
      if (weaker.length) notes.push(`${d.item}: also differs from the ${weaker.map((w) => w.againstType.replace('_', ' ')).join(' and ')}; counted once, against the ${d.againstType.replace('_', ' ')}.`);
    }
    for (const u of undelivered) {
      const price = [...priceByItem.values()].find((p) => sameItem(p.item, u.item) >= 0.8)?.reference ?? u.unitPrice;
      calcs.push({ description: `${u.item}: ${u.quantity} invoiced but not on the delivery note`, expression: `${u.quantity} × ${price}`, result: round2(u.quantity * price), currency: u.currency });
    }
    if (!calcs.length) continue;
    const total = round2(calcs.reduce((s, c) => s + c.result, 0));
    const hasContract = [...priceByItem.values()].some((p) => p.againstType === 'contract');
    out.push(blankFinding({
      id: `save-${inv.id}`,
      investigation: 'cost_savings',
      kind: 'recoverable_overcharge',
      label: hasContract || undelivered.length ? 'Documented overcharge' : 'Potential saving',
      title: `${label(inv)}: ${money(total, inv.currency)} above the agreed or delivered amounts`,
      summary: `${calcs.length} line difference${calcs.length > 1 ? 's' : ''}, before tax.`,
      classification: 'potential_discrepancy',
      strength: hasContract ? 'strong' : 'moderate',
      recordIds: [inv.id],
      docIds: [inv.docId, ...discrepancies.map((d) => ('docId' in d.against ? d.against.docId : -1)).filter((x) => x >= 0)],
      calculations: [...calcs, { description: 'Total (before tax)', expression: calcs.map((c) => c.result).join(' + '), result: total, currency: inv.currency }],
      amount: { value: total, currency: inv.currency, nature: hasContract || undelivered.length ? 'documented_overcharge' : 'potential_saving' },
      assumptions: ['Amounts exclude VAT; if the invoice charged tax on these lines, the recoverable amount is higher by the tax rate.', ...notes],
      limitations: ['A price change or later delivery may have been agreed outside the indexed documents.'],
      verification: ['Request a credit note for the difference after confirming with the supplier and the person who received the goods.'],
    }));
  }
  for (const p of findDuplicatePayments(records).filter((x) => x.strength === 'strong')) {
    out.push({ ...p, id: `save-${p.id}`, investigation: 'cost_savings', kind: 'duplicate_payment_recovery', label: 'Possible duplicate-payment recovery', title: `${p.title}: up to ${money(p.amount?.value, p.amount?.currency)} recoverable if both payments completed`, overlapsWith: [p.id] });
  }
  // Payment duplicates and overcharges on the same invoice overlap only if the overcharge is also counted on the duplicate copy, which is excluded above.
  return out;
}
