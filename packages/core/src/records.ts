import type { BusinessDocType, BusinessRecord, EntityType, ExtractedEntity, ExtractedSegment, ExtractionResult, LineItem } from './types.js';
import { normalizeCompany, parseAmount, parseDate } from './normalize.js';
import { normalizeRefFor } from './entities.js';

const TYPE_RULES: [BusinessDocType, RegExp][] = [
  ['credit_note', /\bcredit\s+note\b/i],
  ['purchase_order', /\bpurchase\s+order\b/i],
  ['quotation', /\b(quotation|quote\s+(no|number|total)|estimate\s+(no|number))\b/i],
  ['delivery_note', /\b(delivery\s+note|goods\s+received(\s+note)?|proof\s+of\s+delivery|waybill)\b/i],
  ['remittance', /\bremittance\s+(advice|note)\b/i],
  ['bank_statement', /\b(bank\s+statement|statement\s+period|opening\s+balance|closing\s+balance)\b/i],
  ['payment', /\b(proof\s+of\s+payment|payment\s+confirmation|payment\s+advice|payment\s+receipt)\b/i],
  ['invoice', /\b(tax\s+invoice|invoice)\b/i],
  ['subscription', /\b(subscription|billing\s+period|renews?\s+(monthly|annually))\b/i],
  ['contract', /\b(agreement|contract|service\s+level)\b/i],
];

const NUMBER_TYPE: Partial<Record<BusinessDocType, EntityType>> = {
  invoice: 'invoice_number',
  purchase_order: 'po_number',
  quotation: 'quote_number',
  delivery_note: 'delivery_note_number',
  credit_note: 'credit_note_number',
  contract: 'contract_number',
  payment: 'payment_reference',
  remittance: 'payment_reference',
};

/** Classify the business document type. Title/filename hits weigh 3, body hits 1; below 3 is "other". */
export function classifyDocType(result: ExtractionResult, fileName: string): { type: BusinessDocType; confidence: number } {
  const titleText = result.kind === 'eml' ? '' : `${fileName.replace(/[_\-.]+/g, ' ')}\n${result.metadata.title ?? ''}\n${result.segments[0]?.text.slice(0, 200) ?? ''}`;
  const body = result.segments.slice(0, 40).map((s) => s.text).join('\n').slice(0, 6000);
  let best: { type: BusinessDocType; score: number } = { type: 'other', score: 0 };
  for (const [type, re] of TYPE_RULES) {
    const score = (re.test(titleText) ? 3 : 0) + (re.test(body) ? 1 : 0);
    if (score > best.score) best = { type, score };
  }
  if (best.score < 3) return { type: 'other', confidence: 0.3 };
  return { type: best.type, confidence: best.score >= 4 ? 0.9 : 0.75 };
}

const CUR = String.raw`(?:N\$|NAD|ZAR|USD|EUR|GBP|R|\$|€|£)?`;
const AMT = String.raw`(\d[\d ,]*[.,]\d{2})`;
const LINE_RES: { re: RegExp; map: (m: RegExpMatchArray) => Omit<LineItem, 'segmentOrdinal' | 'original'> }[] = [
  { re: new RegExp(String.raw`^(.{3,80}?)\s+(\d+(?:\.\d+)?)\s+${CUR}\s?${AMT}\s+${CUR}\s?${AMT}\s*$`), map: (m) => ({ description: m[1], quantity: Number(m[2]), unitPrice: parseAmount(m[3]), total: parseAmount(m[4]) }) },
  { re: new RegExp(String.raw`^(.{3,80}?)\s+x\s*(\d+(?:\.\d+)?)\s*@\s*${CUR}\s?${AMT}\s*=\s*${CUR}\s?${AMT}\s*$`, 'i'), map: (m) => ({ description: m[1], quantity: Number(m[2]), unitPrice: parseAmount(m[3]), total: parseAmount(m[4]) }) },
  { re: /^(.{3,80}?)\s+(?:qty|quantity)[:\s]*(\d+(?:\.\d+)?)\s*$/i, map: (m) => ({ description: m[1], quantity: Number(m[2]) }) },
  { re: new RegExp(String.raw`^(delivery|freight|shipping|transport|installation|labour|labor)\s*[:\-]?\s*${CUR}\s?${AMT}\s*$`, 'i'), map: (m) => ({ description: m[1], quantity: 1, unitPrice: parseAmount(m[2]), total: parseAmount(m[2]) }) },
];

function cleanDesc(s: string): string {
  return s.replace(/\s{2,}/g, ' ').replace(/[\s:–-]+$/, '').trim();
}

export function extractLineItems(segments: ExtractedSegment[]): LineItem[] {
  const items: LineItem[] = [];
  for (const s of segments) {
    if (s.fields && s.kind === 'row') {
      const f = s.fields;
      const key = (re: RegExp) => Object.keys(f).find((k) => re.test(k));
      const dk = key(/desc|item|product|service|particulars/i);
      const qk = key(/qty|quantity|units?$/i);
      const uk = key(/unit|rate|price(?!.*total)/i);
      const tk = key(/line\s*total|amount|total|value/i);
      if (dk && (qk || tk) && f[dk]) {
        const it: LineItem = { description: cleanDesc(f[dk]), segmentOrdinal: s.ordinal, original: s.text };
        if (qk && f[qk]) it.quantity = parseAmount(f[qk]);
        if (uk && uk !== tk && f[uk]) it.unitPrice = parseAmount(f[uk]);
        if (tk && f[tk]) it.total = parseAmount(f[tk]);
        if (it.quantity !== undefined || it.total !== undefined) items.push(it);
      }
      continue;
    }
    for (const line of s.text.split('\n')) {
      const l = line.trim();
      if (/\b(sub\s*total|total|vat|tax|balance)\b/i.test(l.split(/\s/)[0] ?? '')) continue;
      for (const { re, map } of LINE_RES) {
        const m = l.match(re);
        if (m) {
          const it = map(m);
          if (/^(sub\s*total|total|vat|tax|balance|quote total)/i.test(it.description)) break;
          items.push({ ...it, description: cleanDesc(it.description), segmentOrdinal: s.ordinal, original: l });
          break;
        }
      }
    }
  }
  return items;
}

function windowBefore(segments: Map<number, ExtractedSegment>, e: ExtractedEntity, n = 40): string {
  const t = segments.get(e.segmentOrdinal)?.text ?? '';
  return t.slice(Math.max(0, e.offset - n), e.offset).toLowerCase();
}

function pickSupplier(type: BusinessDocType, ents: ExtractedEntity[], segs: Map<number, ExtractedSegment>): ExtractedEntity | undefined {
  const sup = ents.filter((e) => e.type === 'supplier');
  if (!sup.length) return undefined;
  const labelled = sup.find((e) => e.label && /supplier|vendor|from|billed by|seller|issued by|payee|beneficiary|contractor|service provider/.test(e.label));
  if (labelled && type !== 'purchase_order') return labelled;
  if (type === 'purchase_order') {
    return sup.find((e) => /(\bto|supplier|vendor)\s*[:-]?\s*$/.test(windowBefore(segs, e, 20))) ?? labelled ?? sup[1] ?? sup[0];
  }
  const notBuyer = sup.filter((e) => !/(bill(ed)?\s*to|customer|client|sold\s*to|deliver\s*to|ship\s*to|buyer|between)\s*[:-]?\s*$/.test(windowBefore(segs, e, 24)));
  return notBuyer[0] ?? sup[0];
}

function pick<T extends ExtractedEntity>(ents: T[], type: EntityType, labels?: string[]): T | undefined {
  const all = ents.filter((e) => e.type === type);
  if (labels) for (const l of labels) { const f = all.find((e) => e.label === l); if (f) return f; }
  return all[0];
}

function proseRecord(result: ExtractionResult, ents: ExtractedEntity[], fileName: string): BusinessRecord | undefined {
  const { type, confidence } = classifyDocType(result, fileName);
  const segs = new Map(result.segments.map((s) => [s.ordinal, s]));
  const rec: BusinessRecord = { docType: type, docTypeConfidence: confidence, lineItems: [], fieldSources: {} };
  const set = <K extends keyof BusinessRecord>(k: K, v: BusinessRecord[K] | undefined, e?: ExtractedEntity) => {
    if (v === undefined || v === null || v === '') return;
    rec[k] = v;
    if (e) rec.fieldSources[k as string] = e.segmentOrdinal;
  };
  const numType = NUMBER_TYPE[type];
  const num = numType ? pick(ents, numType) : undefined;
  set('number', num?.original, num);
  set('numberNormalized', num?.normalized);
  const sup = pickSupplier(type, ents, segs);
  set('supplier', sup?.original, sup);
  set('supplierNormalized', sup?.normalized);

  const dateLabels: Partial<Record<BusinessDocType, string[]>> = {
    invoice: ['invoice_date', 'date'], purchase_order: ['order_date', 'date'], delivery_note: ['delivery_date', 'date'], payment: ['payment_date', 'date'], quotation: ['date'], contract: ['effective_date', 'date'],
  };
  const dates = ents.filter((e) => e.type === 'date' && !['due_date', 'expiry_date', 'valid_until', 'warranty_expiry', 'renewal_date'].includes(e.label ?? ''));
  const d = pick(dates, 'date', dateLabels[type] ?? ['date']);
  set('date', d?.isoDate, d);
  const due = ents.find((e) => e.type === 'date' && e.label === 'due_date');
  set('dueDate', due?.isoDate, due);

  const amounts = ents.filter((e) => e.type === 'amount' && e.numeric !== undefined);
  const totals = amounts.filter((e) => e.label === 'total' || /total/.test(windowBefore(segs, e, 30)));
  const total = totals.length ? totals.reduce((a, b) => (b.numeric! > a.numeric! ? b : a)) : type !== 'other' && type !== 'contract' ? amounts.reduce<ExtractedEntity | undefined>((a, b) => (!a || b.numeric! > a.numeric! ? b : a), undefined) : undefined;
  set('total', total?.numeric, total);
  const subtotal = amounts.find((e) => e.label === 'subtotal');
  set('subtotal', subtotal?.numeric, subtotal);
  const tax = amounts.find((e) => e.label === 'tax');
  set('tax', tax?.numeric, tax);
  const discount = amounts.find((e) => e.label === 'discount');
  set('discount', discount?.numeric, discount);
  set('currency', total?.currency ?? amounts.find((a) => a.currency)?.currency);

  const ref = (t: EntityType, k: 'poReference' | 'invoiceReference' | 'quoteReference' | 'paymentReference' | 'transactionId') => {
    if (numType === t) return;
    const e = pick(ents, t);
    set(k, e?.normalized, e);
  };
  ref('po_number', 'poReference');
  ref('invoice_number', 'invoiceReference');
  ref('quote_number', 'quoteReference');
  ref('payment_reference', 'paymentReference');
  ref('transaction_id', 'transactionId');

  const bank: NonNullable<BusinessRecord['bank']> = {};
  const bf = (t: EntityType, k: keyof typeof bank) => { const e = pick(ents, t); if (e) { bank[k] = e.normalized; rec.fieldSources[`bank.${k}`] = e.segmentOrdinal; } };
  bf('bank_account', 'accountNumber');
  bf('bank_name', 'bankName');
  bf('branch_code', 'branchCode');
  bf('swift', 'swift');
  bf('iban', 'iban');
  const holder = pick(ents, 'account_holder');
  if (holder) { bank.accountHolder = holder.original; rec.fieldSources['bank.accountHolder'] = holder.segmentOrdinal; }
  if (Object.keys(bank).length) rec.bank = bank;
  const email = pick(ents, 'email');
  const phone = pick(ents, 'phone');
  if (email || phone) rec.contact = { email: email?.normalized, phone: phone?.normalized };
  const terms = pick(ents, 'payment_terms');
  set('paymentTermsDays', terms?.numeric, terms);
  if (['invoice', 'purchase_order', 'quotation', 'delivery_note', 'credit_note'].includes(type)) rec.lineItems = extractLineItems(result.segments);

  const hasSubstance = rec.number || rec.total !== undefined || rec.bank || (type !== 'other');
  return hasSubstance ? rec : undefined;
}

function rowRecords(result: ExtractionResult, fileName: string): BusinessRecord[] {
  const rows = result.segments.filter((s) => s.kind === 'row' && s.fields);
  if (!rows.length) return [];
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r.fields!)))];
  const key = (re: RegExp) => headers.find((h) => re.test(h));
  const amountK = headers.find((h) => /amount|value|paid|^total$|^payment$/i.test(h) && !/date|ref|no\b|number/i.test(h));
  const debitK = key(/debit|withdrawal|money\s*out/i);
  const creditK = key(/credit|deposit|money\s*in/i);
  if (!amountK && !debitK && !creditK) return [];
  const dateK = key(/date/i);
  const supK = key(/supplier|payee|vendor|beneficiary|merchant|counterparty|name/i) ?? key(/description|details|narrative/i);
  const refK = key(/^ref|reference|payment\s*(ref|no)|trans(action)?\s*(id|ref|no)/i);
  const invK = key(/invoice/i);
  const accK = key(/account/i);
  const isStatement = !!(debitK || creditK || key(/balance/i));
  const type: BusinessDocType = isStatement ? 'bank_statement' : 'payment';
  void fileName;
  const out: BusinessRecord[] = [];
  for (const s of rows) {
    const f = s.fields!;
    if (Object.values(f).some((v) => /^(total|sub\s*total|grand total)$/i.test(v.trim()))) continue;
    let total: number | undefined;
    let direction: 'out' | 'in' | undefined;
    if (debitK && f[debitK]) { total = parseAmount(f[debitK]); direction = 'out'; }
    else if (creditK && f[creditK]) { total = parseAmount(f[creditK]); direction = 'in'; }
    else if (amountK && f[amountK]) { total = parseAmount(f[amountK]); direction = type === 'payment' ? 'out' : undefined; }
    if (total === undefined) continue;
    const supplier = supK ? f[supK]?.trim() : undefined;
    const ref = refK ? f[refK]?.trim() : undefined;
    const rec: BusinessRecord = {
      docType: type,
      docTypeConfidence: 0.7,
      supplier: supplier || undefined,
      supplierNormalized: supplier ? normalizeCompany(supplier) : undefined,
      number: ref || undefined,
      numberNormalized: ref ? normalizeRefFor('payment_reference', ref) : undefined,
      paymentReference: ref ? normalizeRefFor('payment_reference', ref) : undefined,
      invoiceReference: invK && f[invK] ? normalizeRefFor('invoice_number', f[invK]) : undefined,
      date: dateK && f[dateK] ? parseDate(f[dateK]) : undefined,
      total: Math.abs(total),
      direction,
      paymentStatus: type === 'payment' ? 'completed' : undefined,
      bank: accK && f[accK] ? { accountNumber: f[accK].replace(/[\s-]/g, '') } : undefined,
      lineItems: [],
      fieldSources: { number: s.ordinal, total: s.ordinal, supplier: s.ordinal, date: s.ordinal },
      rowLocation: s.location,
    };
    out.push(rec);
  }
  return out;
}

/** Derive structured business records from an extracted document. Values keep evidence pointers via fieldSources. */
export function buildRecords(result: ExtractionResult, entities: ExtractedEntity[], fileName: string): BusinessRecord[] {
  if (result.kind === 'xlsx' || result.kind === 'csv') {
    const rows = rowRecords(result, fileName);
    if (rows.length) return rows;
  }
  const rec = proseRecord(result, entities, fileName);
  return rec ? [rec] : [];
}
