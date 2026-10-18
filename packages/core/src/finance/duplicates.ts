import { editDistance } from '../normalize.js';
import type { AttributeComparison, Finding, FinRecord } from './types.js';
import { blankFinding, daysApart, evidenceFor, label, money, sameAmount, sameItem, sameSupplier, withDocs } from './util.js';

const PAYMENT_TYPES = new Set(['payment', 'bank_statement', 'remittance']);

function cmp(attribute: string, a: FinRecord, b: FinRecord, va: string | undefined, vb: string | undefined, outcome: AttributeComparison['outcome'], note?: string): AttributeComparison {
  return { attribute, values: [{ recordId: a.id, docId: a.docId, value: va }, { recordId: b.id, docId: b.docId, value: vb }], outcome, note };
}

function lineItemOutcome(a: FinRecord, b: FinRecord): { outcome: AttributeComparison['outcome']; note?: string } {
  if (!a.lineItems.length || !b.lineItems.length) return { outcome: 'missing', note: 'Line items could not be read from both documents' };
  const matched = a.lineItems.filter((x) => b.lineItems.some((y) => sameItem(x.description, y.description) >= 0.8 && (x.quantity === undefined || y.quantity === undefined || x.quantity === y.quantity) && (x.unitPrice === undefined || y.unitPrice === undefined || sameAmount(x.unitPrice, y.unitPrice))));
  if (matched.length === a.lineItems.length && a.lineItems.length === b.lineItems.length) return { outcome: 'same' };
  return { outcome: 'different', note: `${matched.length} of ${Math.max(a.lineItems.length, b.lineItems.length)} line items match` };
}

/** Compare two invoices. Returns undefined when they are clearly not duplicates. */
export function compareInvoices(a: FinRecord, b: FinRecord): { grade: 'exact' | 'likely' | 'weak'; comparisons: AttributeComparison[]; reasons: string[]; differences: string[] } | undefined {
  const sup = sameSupplier(a.supplierNormalized, b.supplierNormalized);
  if (sup === 'different') return undefined;
  if (a.currency && b.currency && a.currency !== b.currency) return undefined;
  const numSame = !!a.numberNormalized && a.numberNormalized === b.numberNormalized;
  const numRawSame = !!a.number && a.number === b.number;
  const numNear = !numSame && !!a.numberNormalized && !!b.numberNormalized && editDistance(a.numberNormalized, b.numberNormalized, 2) === 1;
  const amtSame = sameAmount(a.total, b.total);
  const dd = daysApart(a.date, b.date);
  const periodDiffers = !!a.servicePeriod && !!b.servicePeriod && a.servicePeriod !== b.servicePeriod;
  const recurring = !!(a.recurring || b.recurring);
  const poSame = !!a.poReference && a.poReference === b.poReference;
  const poDiff = !!a.poReference && !!b.poReference && a.poReference !== b.poReference;
  const li = lineItemOutcome(a, b);

  const comparisons: AttributeComparison[] = [
    cmp('Supplier', a, b, a.supplier, b.supplier, sup === 'same' ? 'same' : sup === 'similar' ? 'equivalent' : 'missing'),
    cmp('Invoice number', a, b, a.number, b.number, numRawSame ? 'same' : numSame ? 'equivalent' : !a.number || !b.number ? 'missing' : 'different', numSame && !numRawSame ? 'Same number after removing formatting and leading zeros' : numNear ? 'Numbers differ by one character' : undefined),
    cmp('Invoice date', a, b, a.date, b.date, a.date && b.date ? (a.date === b.date ? 'same' : 'different') : 'missing', dd ? `${dd} days apart` : undefined),
    cmp('Total', a, b, money(a.total, a.currency), money(b.total, b.currency), a.total === undefined || b.total === undefined ? 'missing' : amtSame ? 'same' : 'different'),
    cmp('Currency', a, b, a.currency, b.currency, a.currency && b.currency ? 'same' : 'missing'),
    cmp('Purchase order', a, b, a.poReference, b.poReference, poSame ? 'same' : poDiff ? 'different' : 'missing'),
    cmp('Line items', a, b, `${a.lineItems.length} items`, `${b.lineItems.length} items`, li.outcome, li.note),
  ];
  if (a.servicePeriod || b.servicePeriod) comparisons.push(cmp('Service period', a, b, a.servicePeriod, b.servicePeriod, periodDiffers ? 'different' : a.servicePeriod && b.servicePeriod ? 'same' : 'missing'));
  if (a.bank?.accountNumber || b.bank?.accountNumber) comparisons.push(cmp('Bank account on invoice', a, b, a.bank?.accountNumber, b.bank?.accountNumber, !a.bank?.accountNumber || !b.bank?.accountNumber ? 'missing' : a.bank.accountNumber === b.bank.accountNumber ? 'same' : 'different'));

  // Meaningful distinctions that rule out a duplicate.
  if (periodDiffers || poDiff) return undefined;
  if (li.outcome === 'different' && !numSame) return undefined;
  if (!amtSame && !numSame) return undefined;
  if (recurring && !numSame) return undefined;

  const reasons: string[] = [];
  const differences = comparisons.filter((c) => c.outcome === 'different').map((c) => c.attribute);
  if (sup !== 'unknown') reasons.push('same supplier');
  if (numSame) reasons.push(numRawSame ? 'identical invoice number' : 'same invoice number after normalisation');
  if (amtSame) reasons.push('identical total');
  if (poSame) reasons.push('same purchase order');
  if (li.outcome === 'same') reasons.push('identical line items');

  let grade: 'exact' | 'likely' | 'weak';
  if (numSame && amtSame && a.date === b.date && sup === 'same' && li.outcome !== 'different') grade = 'exact';
  else if (numSame && amtSame && sup !== 'unknown') grade = 'likely';
  else if (amtSame && sup !== 'unknown' && (numNear || poSame || li.outcome === 'same') && (dd === undefined || dd <= 45)) grade = 'likely';
  else if (numSame && !amtSame) grade = 'weak';
  else if (amtSame && sup === 'same' && (dd === undefined || dd <= 31)) grade = 'weak';
  else return undefined;
  return { grade, comparisons, reasons, differences };
}

const GRADE_RANK = { exact: 3, likely: 2, weak: 1 } as const;

export function findDuplicateInvoices(records: FinRecord[]): Finding[] {
  const inv = records.filter((r) => r.docType === 'invoice');
  const payments = records.filter((r) => PAYMENT_TYPES.has(r.docType) && r.direction !== 'in');
  const credits = records.filter((r) => r.docType === 'credit_note');
  const parent = new Map<number, number>();
  const find = (x: number): number => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const pairs: { a: FinRecord; b: FinRecord; res: NonNullable<ReturnType<typeof compareInvoices>> }[] = [];
  for (let i = 0; i < inv.length; i++) for (let j = i + 1; j < inv.length; j++) {
    if (inv[i].docId === inv[j].docId) continue;
    const res = compareInvoices(inv[i], inv[j]);
    if (!res) continue;
    pairs.push({ a: inv[i], b: inv[j], res });
    parent.set(find(inv[i].id), find(inv[j].id));
  }
  const groups = new Map<number, typeof pairs>();
  for (const p of pairs) { const g = find(p.a.id); groups.set(g, [...(groups.get(g) ?? []), p]); }
  const out: Finding[] = [];
  for (const [g, ps] of groups) {
    const best = ps.reduce((m, p) => (GRADE_RANK[p.res.grade] > GRADE_RANK[m.res.grade] ? p : m));
    const members = [...new Map(ps.flatMap((p) => [p.a, p.b]).map((r) => [r.id, r])).values()];
    const grade = best.res.grade;
    const nums = new Set(members.map((m) => m.numberNormalized).filter(Boolean));
    const related = payments.filter((p) => p.invoiceReference && nums.has(p.invoiceReference));
    const relatedCredits = credits.filter((c) => c.invoiceReference && nums.has(c.invoiceReference));
    const f = blankFinding({
      id: `dup-inv-${g}`,
      investigation: 'duplicate_invoices',
      kind: 'duplicate_invoice',
      label: grade === 'exact' ? 'Exact duplicate invoice' : grade === 'likely' ? 'Likely duplicate invoice' : 'Weak similarity',
      title: `${members.length} invoices from ${members[0].supplier ?? 'an unidentified supplier'} for ${money(members[0].total, members[0].currency)}`,
      summary: `Grouped because of ${best.res.reasons.join(', ')}.${best.res.differences.length ? ` Differences: ${best.res.differences.join(', ')}.` : ''}`,
      classification: grade === 'weak' ? 'unverified_indicator' : 'potential_discrepancy',
      strength: grade === 'exact' ? 'strong' : grade === 'likely' ? 'moderate' : 'weak',
      grade,
      comparisons: best.res.comparisons,
      evidence: members.flatMap((m) => [evidenceFor(m, 'number', m.number), evidenceFor(m, 'total', money(m.total, m.currency))]),
      verification: ['Open both originals and confirm whether the supplier issued the same invoice twice.', 'Check the accounting system for how many times the invoice was approved and paid.'],
      limitations: ['Only documents in the authorised folders were compared.'],
    });
    if (related.length > 1) {
      f.unresolved.push(`${related.length} payment records reference ${[...nums].join(' / ')}: ${related.map((p) => `${p.number ?? '?'} on ${p.date ?? 'unknown date'} for ${money(p.total, p.currency)}`).join('; ')}. Whether both payments completed has not been confirmed against a bank statement.`);
      f.comparisons.push({ attribute: 'Payment records', values: related.map((p) => ({ recordId: p.id, docId: p.docId, value: `${p.number} ${p.date ?? ''} ${money(p.total, p.currency)}` })), outcome: 'different', note: 'More than one payment references this invoice' });
      withDocs(f, related);
    } else if (related.length === 1) f.limitations.push(`One payment record (${label(related[0])}) references this invoice; there is no evidence that the duplicate document was paid.`);
    else f.limitations.push('No payment records referencing these invoices were found, so payment status is unknown.');
    if (relatedCredits.length) f.unresolved.push(`A credit note (${relatedCredits.map((c) => c.number).join(', ')}) references this invoice and may cancel one copy.`);
    out.push(withDocs(f, members));
  }
  return out.sort((a, b) => GRADE_RANK[b.grade!] - GRADE_RANK[a.grade!]);
}

/** Duplicate-payment investigation: a repeated amount alone is never enough. */
export function findDuplicatePayments(records: FinRecord[]): Finding[] {
  const pays = records.filter((r) => PAYMENT_TYPES.has(r.docType) && r.direction !== 'in' && r.total !== undefined);
  const incoming = records.filter((r) => PAYMENT_TYPES.has(r.docType) && r.direction === 'in');
  const bankTx = records.filter((r) => r.docType === 'bank_statement');
  const coverage = bankTx.map((r) => r.date).filter(Boolean).sort() as string[];
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < pays.length; i++) for (let j = i + 1; j < pays.length; j++) {
    const a = pays[i], b = pays[j];
    if (a.docType !== b.docType) continue; // a ledger entry and a bank line usually describe the same payment, not two
    if (!sameAmount(a.total, b.total)) continue;
    if (a.currency && b.currency && a.currency !== b.currency) continue;
    const sup = sameSupplier(a.supplierNormalized, b.supplierNormalized);
    if (sup === 'different') continue;
    if (a.installment && b.installment && a.installment.index !== b.installment.index) continue;
    if (a.paymentStatus === 'reversed' || b.paymentStatus === 'reversed' || a.paymentStatus === 'refunded' || b.paymentStatus === 'refunded') continue;
    const sameTx = !!a.transactionId && a.transactionId === b.transactionId;
    const sameRef = !!a.paymentReference && a.paymentReference === b.paymentReference;
    const sameInv = !!a.invoiceReference && a.invoiceReference === b.invoiceReference;
    const diffInv = !!a.invoiceReference && !!b.invoiceReference && a.invoiceReference !== b.invoiceReference;
    const dd = daysApart(a.date, b.date);
    if (diffInv && !sameTx) continue; // e.g. two invoices for the same amount
    const monthly = dd !== undefined && dd >= 26 && dd <= 35;
    if (!sameInv && !sameTx && !sameRef && (a.recurring || b.recurring || monthly)) continue;
    if (!sameInv && !sameTx && !sameRef && (dd === undefined || dd > 7)) continue;
    const key = [a.id, b.id].join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    const refunds = incoming.filter((r) => sameAmount(r.total, a.total) && sameSupplier(r.supplierNormalized, a.supplierNormalized) !== 'different');
    const strength = sameTx || sameRef ? 'strong' : sameInv ? 'strong' : 'weak';
    const kind = sameTx || sameRef ? 'Same transaction recorded twice' : sameInv ? 'Repeated payments associated with the same invoice' : 'Duplicate-looking transaction records';
    const f = blankFinding({
      id: `dup-pay-${key}`,
      investigation: 'duplicate_payments',
      kind: 'duplicate_payment',
      label: kind,
      title: `${money(a.total, a.currency)} to ${a.supplier ?? 'unidentified payee'} on ${a.date ?? '?'} and ${b.date ?? '?'}`,
      summary: sameInv ? `Both payment records reference invoice ${a.invoiceReference}${dd !== undefined ? `, ${dd} days apart` : ''}.` : sameTx || sameRef ? 'Both records carry the same transaction or payment reference.' : `Same payee and amount ${dd} days apart, with no invoice reference to tell them apart.`,
      classification: strength === 'strong' ? 'potential_discrepancy' : 'unverified_indicator',
      strength,
      comparisons: [
        cmp('Payee', a, b, a.supplier, b.supplier, sup === 'same' ? 'same' : sup === 'similar' ? 'equivalent' : 'missing'),
        cmp('Amount', a, b, money(a.total, a.currency), money(b.total, b.currency), 'same'),
        cmp('Date', a, b, a.date, b.date, a.date === b.date ? 'same' : 'different', dd !== undefined ? `${dd} days apart` : undefined),
        cmp('Invoice reference', a, b, a.invoiceReference, b.invoiceReference, sameInv ? 'same' : 'missing'),
        cmp('Payment reference', a, b, a.paymentReference ?? a.number, b.paymentReference ?? b.number, sameRef ? 'same' : 'different'),
        cmp('Paid to account', a, b, a.bank?.accountNumber, b.bank?.accountNumber, !a.bank?.accountNumber || !b.bank?.accountNumber ? 'missing' : a.bank.accountNumber === b.bank.accountNumber ? 'same' : 'different'),
      ],
      evidence: [a, b].map((r) => evidenceFor(r, 'total', money(r.total, r.currency))),
      calculations: [{ description: 'Amount that may have been paid twice', expression: `${money(b.total, b.currency)} (second record)`, result: b.total!, currency: b.currency }],
      amount: { value: b.total!, currency: b.currency, nature: 'amount_at_risk' },
      verification: ['Confirm on the bank statement whether both payments left the account.', 'Ask the supplier for a statement of account showing both receipts.'],
      limitations: [],
    });
    if (a.docType === 'payment') f.limitations.push('These are payment-register entries, not bank confirmations. A register entry can be an instruction that was never executed.');
    if (a.bank?.accountNumber && b.bank?.accountNumber && a.bank.accountNumber !== b.bank.accountNumber) f.unresolved.push(`The payments went to different accounts (${a.bank.accountNumber} and ${b.bank.accountNumber}). Run the bank-details investigation to see where each account appears.`);
    if (refunds.length) f.unresolved.push(`An incoming amount of ${money(refunds[0].total, refunds[0].currency)} (${label(refunds[0])}) may be a refund of one payment.`);
    const corroborated = [a, b].map((p) => bankTx.some((t) => t.id !== p.id && sameAmount(t.total, p.total) && (daysApart(t.date, p.date) ?? 99) <= 10));
    if (a.docType === 'payment') {
      if (corroborated.every(Boolean)) f.limitations.push('Both payments have a matching bank-statement line.');
      else f.unresolved.push(coverage.length ? `No matching bank-statement line was found for ${[a, b].filter((_, k) => !corroborated[k]).map((p) => p.number).join(' and ')}; indexed bank statements only cover ${coverage[0]} to ${coverage[coverage.length - 1]}.` : 'No bank statements are indexed, so completion of these payments cannot be confirmed.');
    }
    out.push(withDocs(f, [a, b]));
  }
  return out;
}
