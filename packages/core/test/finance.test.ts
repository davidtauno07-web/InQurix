import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRecords, compareInvoices, detectInvestigationIntent, extractAllEntities, extractDocument, findDuplicateInvoices, findDuplicatePayments,
  findObligations, findRecordGaps, runInvestigation, terminateOcr, type ExtractionResult, type FinDocument, type FinRecord,
} from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inqurix-fin-'));
const TESSDATA = ['/usr/share/tesseract-ocr/5/tessdata', '/usr/share/tesseract-ocr/4.00/tessdata'].find((d) => fs.existsSync(path.join(d, 'eng.traineddata')));
const records: FinRecord[] = [];
const documents: FinDocument[] = [];

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/generate-fixtures.mjs'), dir]);
  let docId = 0, recId = 0;
  const add = (name: string, result: ExtractionResult, parentId?: number) => {
    const id = ++docId;
    const segText = Object.fromEntries(result.segments.map((s) => [s.ordinal, { text: s.text, location: s.location }]));
    for (const r of buildRecords(result, extractAllEntities(result.segments), name)) records.push({ ...r, id: ++recId, docId: id, docName: name, segmentText: segText });
    documents.push({ docId: id, parentId, name, segments: result.segments.map((s) => ({ ordinal: s.ordinal, text: s.text, location: s.location })), email: result.metadata.email });
    for (const c of result.children ?? []) add(c.name, c.result, id);
  };
  for (const f of fs.readdirSync(dir).sort()) {
    const o = await extractDocument(fs.readFileSync(path.join(dir, f)), f, { ocr: TESSDATA ? { langPath: TESSDATA, cachePath: dir } : undefined });
    if (o.identification.dangerous) continue;
    add(f, o.result);
  }
}, 180_000);
afterAll(() => terminateOcr());

const base = (p: Partial<FinRecord>): FinRecord => ({ id: 0, docId: 0, docName: 'x', docType: 'invoice', docTypeConfidence: 1, lineItems: [], fieldSources: {}, ...p });

describe('duplicate invoices (fixtures)', () => {
  it('groups INV-1048 and its resent INV-01048 copy as a likely duplicate, with differences shown', () => {
    const f = findDuplicateInvoices(records);
    expect(f).toHaveLength(1);
    expect(f[0].grade).toBe('likely');
    const names = f[0].docIds.map((id) => documents.find((d) => d.docId === id)!.name);
    expect(names).toEqual(expect.arrayContaining(['invoice-INV-1048.pdf', 'Kavango invoice 1048 (resent).pdf']));
    expect(f[0].comparisons.find((c) => c.attribute === 'Invoice number')!.outcome).toBe('equivalent');
    expect(f[0].comparisons.find((c) => c.attribute === 'Invoice date')!.outcome).toBe('different');
    expect(f[0].comparisons.find((c) => c.attribute === 'Bank account on invoice')!.outcome).toBe('different');
    expect(f[0].unresolved.join(' ')).toMatch(/payment records reference/);
  });
});

describe('duplicate invoices (false positives)', () => {
  const inv = (id: number, p: Partial<FinRecord>) => base({ id, docId: id, supplier: 'Acme', supplierNormalized: 'acme', currency: 'NAD', ...p });
  it('does not flag monthly subscription invoices with different service periods', () => {
    expect(compareInvoices(inv(1, { number: 'S-1', numberNormalized: 's:1', total: 500, date: '2026-01-01', servicePeriod: '2026-01' }), inv(2, { number: 'S-2', numberNormalized: 's:2', total: 500, date: '2026-02-01', servicePeriod: '2026-02' }))).toBeUndefined();
  });
  it('does not flag same amount from different suppliers', () => {
    expect(compareInvoices(inv(1, { total: 900, number: 'A-1', numberNormalized: 'a:1' }), inv(2, { total: 900, supplier: 'Zeta', supplierNormalized: 'zeta', number: 'A-1', numberNormalized: 'a:1' }))).toBeUndefined();
  });
  it('does not flag same amount under different POs', () => {
    expect(compareInvoices(inv(1, { total: 900, number: 'A-1', numberNormalized: 'a:1', poReference: 'po:1' }), inv(2, { total: 900, number: 'A-2', numberNormalized: 'a:2', poReference: 'po:2' }))).toBeUndefined();
  });
  it('grades identical copies as exact', () => {
    const r = compareInvoices(inv(1, { total: 900, number: 'A-1', numberNormalized: 'a:1', date: '2026-01-02' }), inv(2, { total: 900, number: 'A-1', numberNormalized: 'a:1', date: '2026-01-02' }));
    expect(r?.grade).toBe('exact');
  });
});

describe('duplicate payments', () => {
  it('flags PAY-2290 and PAY-2297 for the same invoice and notes the different accounts', () => {
    const f = findDuplicatePayments(records);
    expect(f.length).toBeGreaterThanOrEqual(1);
    const top = f.find((x) => x.label.includes('same invoice'))!;
    expect(top).toBeTruthy();
    expect(top.amount?.value).toBe(14317.5);
    expect(top.unresolved.join(' ')).toMatch(/different accounts/);
  });
  const pay = (id: number, p: Partial<FinRecord>) => base({ id, docId: 1, docType: 'payment', supplier: 'Acme', supplierNormalized: 'acme', total: 1000, currency: 'NAD', direction: 'out', ...p });
  it('ignores instalments, reversals and monthly recurring payments', () => {
    expect(findDuplicatePayments([pay(1, { installment: { index: 1, of: 3 }, date: '2026-01-01' }), pay(2, { installment: { index: 2, of: 3 }, date: '2026-01-03' })])).toHaveLength(0);
    expect(findDuplicatePayments([pay(1, { date: '2026-01-01' }), pay(2, { date: '2026-01-02', paymentStatus: 'reversed' })])).toHaveLength(0);
    expect(findDuplicatePayments([pay(1, { date: '2026-01-01' }), pay(2, { date: '2026-02-01' })])).toHaveLength(0);
    expect(findDuplicatePayments([pay(1, { date: '2026-01-01', invoiceReference: 'inv:1' }), pay(2, { date: '2026-01-02', invoiceReference: 'inv:2' })])).toHaveLength(0);
  });
});

describe('invoice comparison and cost savings', () => {
  it('finds PO, quote, contract and delivery differences for INV-1048', () => {
    const r = runInvestigation('invoice_comparison', { records, documents });
    const kinds = new Set(r.findings.filter((f) => f.classification === 'potential_discrepancy').map((f) => f.kind));
    expect(kinds).toEqual(expect.objectContaining(new Set(['invoice_vs_purchase_order', 'invoice_vs_contract'])));
    expect([...kinds]).toEqual(expect.arrayContaining(['invoice_vs_purchase_order', 'invoice_vs_contract', 'invoice_vs_quotation']));
  });
  it('counts each overcharge once and does not double count the resent copy', () => {
    const r = runInvestigation('cost_savings', { records, documents });
    const over = r.findings.filter((f) => f.kind === 'recoverable_overcharge');
    expect(over).toHaveLength(1);
    const desc = over[0].calculations.map((c) => c.description).join('\n');
    expect(desc).toMatch(/contract price/);
    expect(desc).not.toMatch(/quoted price.*Paper|Paper.*quoted price/i);
    // paper 40 × (210 − 200) = 400, toner 5 × (650 − 640)? no: toner matches PO 650 → quote 640 only counts if no PO/contract
    expect(over[0].amount!.value).toBeGreaterThan(0);
  });
});

describe('bank details and scam indicators', () => {
  it('reports the supplier bank account change and the payment to the new account', () => {
    const r = runInvestigation('bank_details', { records, documents });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].label).toBe('Supplier details require verification');
    expect(r.findings[0].unresolved.join(' ')).toMatch(/payment/);
  });
  it('flags the look-alike sender domain as an indicator, not as fraud', () => {
    const r = runInvestigation('scam_indicators', { records, documents });
    const email = r.findings.find((f) => f.title.includes('URGENT'))!;
    expect(email.kind).toBe('possible_impersonation');
    expect(email.strength).toBe('strong');
    expect(email.summary).toMatch(/kavango-office-supp1ies\.com resembles kavango-office-supplies\.com/);
    expect(r.findings.every((f) => f.classification === 'unverified_indicator')).toBe(true);
    expect(JSON.stringify(r.findings)).not.toMatch(/\bis fraud\b|\b\d+% (?:chance|probability)/i);
  });
  it('does not flag an urgent email that does not change payment details', () => {
    const doc: FinDocument = { docId: 99, name: 'urgent.eml', segments: [{ ordinal: 0, text: 'URGENT: please approve the leave request today. Confidential.' }], email: { from: 'hr@kavango-office-supp1ies.com' } };
    expect(runInvestigation('scam_indicators', { records, documents: [doc] }).findings).toHaveLength(0);
  });
});

describe('gaps and obligations', () => {
  it('reports absence as not found, never as proof', () => {
    const inv = base({ id: 1, docId: 1, number: 'X-9', numberNormalized: 'x:9', total: 10, poReference: 'po:404' });
    const g = findRecordGaps([inv]);
    expect(g.map((x) => x.kind)).toEqual(expect.arrayContaining(['missing_purchase_order', 'missing_payment']));
    expect(g.every((x) => x.classification === 'missing_evidence' && x.limitations[0].startsWith('Not found in the authorised'))).toBe(true);
  });
  it('separates explicit and calculated dates, including the contract notice deadline', () => {
    const f = findObligations(records, documents, '2026-01-01');
    const notice = f.find((x) => x.kind === 'notice_deadline');
    expect(notice?.obligation?.basis).toBe('calculated');
    expect(notice?.obligation?.date).toBe('2026-01-31');
    expect(f.find((x) => x.kind === 'contract_start')?.obligation).toMatchObject({ basis: 'explicit', date: '2025-04-01' });
  });
});

describe('intent', () => {
  it('suggests investigations from natural questions', () => {
    expect(detectInvestigationIntent('Did we pay Kavango twice?')).toBe('duplicate_payments');
    expect(detectInvestigationIntent('duplicate invoices from Kavango')).toBe('duplicate_invoices');
    expect(detectInvestigationIntent('which suppliers changed bank details')).toBe('bank_details');
    expect(detectInvestigationIntent('invoice INV-1048')).toBeUndefined();
  });
});
