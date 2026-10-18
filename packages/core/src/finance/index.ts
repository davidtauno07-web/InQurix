import { foldForSearch } from '../normalize.js';
import { findBankDetailChanges, findScamIndicators } from './bank.js';
import { compareInvoice } from './compare.js';
import { findDuplicateInvoices, findDuplicatePayments } from './duplicates.js';
import { findRecordGaps } from './gaps.js';
import { findObligations } from './obligations.js';
import { findCostSavings } from './savings.js';
import type { Finding, InvestigationInput, InvestigationResult, InvestigationType } from './types.js';

export * from './types.js';
export { compareInvoices, findDuplicateInvoices, findDuplicatePayments } from './duplicates.js';
export { compareInvoice, extractAgreedPrices, findCounterparts } from './compare.js';
export { accountsInText, findBankDetailChanges, findScamIndicators } from './bank.js';
export { findRecordGaps } from './gaps.js';
export { contractObligations, findObligations, parseTextDate } from './obligations.js';
export { findCostSavings } from './savings.js';

export const INVESTIGATIONS: Record<InvestigationType, { title: string; objective: string; credits: number }> = {
  duplicate_invoices: { title: 'Duplicate invoices', objective: 'Find invoices that appear more than once, including renumbered or resent copies.', credits: 2 },
  duplicate_payments: { title: 'Duplicate payments', objective: 'Find payments that may have been made more than once for the same obligation.', credits: 2 },
  invoice_comparison: { title: 'Invoice comparison', objective: 'Compare invoices with their purchase orders, quotations, contracts, delivery notes and payments.', credits: 3 },
  bank_details: { title: 'Supplier bank details', objective: 'Find suppliers whose bank account details differ across documents.', credits: 2 },
  scam_indicators: { title: 'Payment-redirection indicators', objective: 'Find correspondence with indicators commonly seen in supplier impersonation.', credits: 2 },
  record_gaps: { title: 'Missing records', objective: 'Find invoices, orders, deliveries and payments whose supporting records were not found.', credits: 2 },
  cost_savings: { title: 'Cost savings', objective: 'Find documented overcharges and recoverable amounts, counted once each.', credits: 3 },
  obligations: { title: 'Important dates', objective: 'List payment, renewal, notice and expiry dates, marking which are stated and which are calculated.', credits: 1 },
};

const INTENTS: [InvestigationType, RegExp][] = [
  ['duplicate_payments', /\b(duplicate|double|twice|repeat\w*)\b.*\bpa(id|y\w*)\b|\bpa(?:y|id)\b.*\b(twice|double|again)\b/],
  ['duplicate_invoices', /\b(duplicate|double|repeat\w*|same)\b.*\binvoices?\b|\binvoices?\b.*\b(duplicate|twice)\b/],
  ['scam_indicators', /\b(scam|fraud\w*|phish\w*|impersonat\w*|suspicious|fake)\b/],
  ['bank_details', /\bbank\b.*\b(changed?|different|new)\b|\b(changed?|new)\b.*\bbank\b/],
  ['cost_savings', /\b(sav(e|ing|ings)|overcharg\w*|overpa\w*|recover\w*|over ?bill\w*)\b/],
  ['record_gaps', /\b(missing|without|no)\b.*\b(po|purchase orders?|payments?|delivery|deliveries|invoices?|receipts?)\b/],
  ['obligations', /\b(deadlines?|renewals?|due dates?|expir\w*|notice periods?|upcoming|obligations?)\b/],
  ['invoice_comparison', /\b(compare|match|mismatch\w*|reconcil\w*|three.?way)\b/],
];

/** Suggest (never run) an investigation when a search reads like an analysis request. */
export function detectInvestigationIntent(query: string): InvestigationType | undefined {
  const q = foldForSearch(query);
  return INTENTS.find(([, re]) => re.test(q))?.[0];
}

/** Assign overlap links between findings that describe the same money, so totals are not double counted. */
function linkOverlaps(findings: Finding[]) {
  for (const a of findings) for (const b of findings) {
    if (a === b || !a.amount || !b.amount) continue;
    if (a.recordIds.some((id) => b.recordIds.includes(id)) && !a.overlapsWith.includes(b.id)) a.overlapsWith.push(b.id);
  }
}

export function runInvestigation(type: InvestigationType, input: InvestigationInput): InvestigationResult {
  const { records, documents = [], today } = input;
  let findings: Finding[];
  switch (type) {
    case 'duplicate_invoices': findings = findDuplicateInvoices(records); break;
    case 'duplicate_payments': findings = findDuplicatePayments(records); break;
    case 'invoice_comparison': {
      const seen = new Set<string>();
      findings = records.filter((r) => r.docType === 'invoice').flatMap((inv) => compareInvoice(inv, records, documents).findings).filter((f) => !seen.has(f.id) && (seen.add(f.id), true));
      findings.sort((a, b) => Number(b.classification === 'potential_discrepancy') - Number(a.classification === 'potential_discrepancy'));
      break;
    }
    case 'bank_details': findings = findBankDetailChanges(records, documents); break;
    case 'scam_indicators': findings = findScamIndicators(records, documents); break;
    case 'record_gaps': findings = findRecordGaps(records); break;
    case 'cost_savings': findings = findCostSavings(records, documents); break;
    case 'obligations': findings = findObligations(records, documents, today); break;
  }
  linkOverlaps(findings);
  const recordTypes: Record<string, number> = {};
  for (const r of records) recordTypes[r.docType] = (recordTypes[r.docType] ?? 0) + 1;
  const notes: string[] = [`Searched ${records.length} structured records from ${new Set(records.map((r) => r.docId)).size} documents in the authorised folders.`];
  if (!records.length) notes.push('No business records were found. Index folders that contain invoices, orders or payment records.');
  if (type === 'duplicate_payments' && !recordTypes.bank_statement) notes.push('No bank statements are indexed, so completed payments cannot be confirmed.');
  const result: InvestigationResult = { type, objective: INVESTIGATIONS[type].objective, scope: { records: records.length, documents: new Set(records.map((r) => r.docId)).size + documents.filter((d) => !records.some((r) => r.docId === d.docId)).length, recordTypes }, findings, notes };
  const withAmount = findings.filter((f) => f.amount);
  if (withAmount.length) {
    const counted = new Set<string>();
    const totals = { documentedOvercharge: 0, potentialSaving: 0, amountAtRisk: 0, currency: withAmount[0].amount!.currency, overlapAdjusted: false };
    for (const f of withAmount) {
      if (f.overlapsWith.some((o) => counted.has(o))) { totals.overlapAdjusted = true; continue; }
      counted.add(f.id);
      const k = f.amount!.nature === 'documented_overcharge' ? 'documentedOvercharge' : f.amount!.nature === 'potential_saving' ? 'potentialSaving' : 'amountAtRisk';
      totals[k] = Math.round((totals[k] + f.amount!.value) * 100) / 100;
    }
    result.totals = totals;
  }
  return result;
}
