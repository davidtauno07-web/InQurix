import type { ExtractedEntity, ExtractedSegment, EntityType } from './types.js';
import { CURRENCY_SYMBOLS, normalizeAccount, normalizeCompany, normalizeReference, parseAmount, parseDate, parseNumberWord } from './normalize.js';

/**
 * Entity extraction from segment text. Every entity records the exact
 * original text and its offset so the UI can highlight the evidence.
 * Patterns are deliberately conservative: an unrecognised value is better
 * than a fabricated one.
 */

const CUR = String.raw`(?:N\$|US\$|A\$|C\$|NAD|ZAR|USD|EUR|GBP|BWP|KES|NGN|AUD|CAD|CHF|JPY|INR|CNY|R(?=\s?\d)|\$|€|£|₦|¥|₹)`;
const NUM = String.raw`\(?-?\d{1,3}(?:[ ,.\u00a0']\d{3})*(?:[.,]\d{1,2})?\)?|\(?-?\d+(?:[.,]\d{1,2})?\)?`;
const AMOUNT_RE = new RegExp(String.raw`(${CUR})\s?(${NUM})(?![\d])|(${NUM})\s?(${CUR.replace('|R(?=\\s?\\d)', '').replace('|\\$', '')})(?![A-Za-z])`, 'g');

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const DATE_RE = new RegExp(
  String.raw`\b(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[ -]${MONTH}\.?,?[ -]\d{4}|${MONTH}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4})\b`,
  'gi',
);

interface RefPattern {
  type: EntityType;
  re: RegExp;
}

// Identifier patterns. The captured group is the identifier itself; the label
// before it decides the type, so "Invoice No: 1048" and "INV-1048" both match.
const REF_PATTERNS: RefPattern[] = [
  { type: 'invoice_number', re: /\b(?:tax\s+)?invoice\s*(?:no\.?|number|nr\.?|#|ref(?:erence)?\.?)?\s*[:#]?\s*((?:[A-Z]{1,5}[-/ ]?)?\d[\w\-/]{1,24})/gi },
  { type: 'invoice_number', re: /\b(INV[-/ ]?\d[\w\-/]{1,20})\b/gi },
  { type: 'po_number', re: /\b(?:purchase\s+order|p\.?\s?o\.?)\s*(?:no\.?|number|nr\.?|#|ref(?:erence)?\.?)?\s*[:#]?\s*((?:PO[-/ ]?)?\d[\w\-/]{1,20})/gi },
  { type: 'po_number', re: /\b(PO[-/ ]?\d[\w\-/]{1,20})\b/gi },
  { type: 'quote_number', re: /\b(?:quotation|quote)\s*(?:no\.?|number|nr\.?|#|ref(?:erence)?\.?)?\s*[:#]?\s*((?:Q(?:T|UO)?[-/ ]?)?\d[\w\-/]{1,20})/gi },
  { type: 'quote_number', re: /\b(QT?[-/]\d[\w\-/]{1,20})\b/g },
  { type: 'delivery_note_number', re: /\b(?:delivery\s+note|goods\s+received\s+note|grn|dn)\s*(?:no\.?|number|nr\.?|#)?\s*[:#]?\s*((?:DN|GRN)?[-/ ]?\d[\w\-/]{1,20})/gi },
  { type: 'credit_note_number', re: /\b(?:credit\s+note)\s*(?:no\.?|number|nr\.?|#)?\s*[:#]?\s*((?:CN)?[-/ ]?\d[\w\-/]{1,20})/gi },
  { type: 'credit_note_number', re: /\b(CN[-/]\d[\w\-/]{1,20})\b/g },
  { type: 'contract_number', re: /\b(?:contract|agreement)\s*(?:no\.?|number|nr\.?|#|ref(?:erence)?\.?)\s*[:#]?\s*([A-Z0-9][\w\-/]{2,24})/gi },
  { type: 'transaction_id', re: /\b(?:transaction|txn|trans\.?)\s*(?:id|no\.?|number|ref(?:erence)?\.?)\s*[:#]?\s*([A-Z0-9][\w\-]{3,30})/gi },
  { type: 'payment_reference', re: /\b(?:payment\s+ref(?:erence)?\.?|remittance\s+ref(?:erence)?\.?|pay(?:ment)?\s+ref)\s*[:#]?\s*([A-Z0-9][\w\-/]{2,30})/gi },
  { type: 'vat_number', re: /\b(?:vat|tax)\s*(?:reg(?:istration)?\.?\s*)?(?:no\.?|number|#)\s*[:#]?\s*([0-9][0-9 \-]{5,18}[0-9])/gi },
];

const BANK_PATTERNS: RefPattern[] = [
  { type: 'bank_account', re: /\b(?:account|acc(?:t)?\.?)\s*(?:no\.?|number|nr\.?|#)\s*[:#]?\s*(\d[\d \-]{5,20}\d)/gi },
  { type: 'branch_code', re: /\b(?:branch|sort)\s*(?:code|no\.?)\s*[:#]?\s*(\d[\d \-]{3,8}\d)/gi },
  { type: 'swift', re: /\b(?:swift|bic)(?:\s*code)?\s*[:#]?\s*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/gi },
  { type: 'iban', re: /\b(?:iban\s*[:#]?\s*)([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)\b/gi },
  { type: 'bank_name', re: /\bbank(?:\s*name)?\s*:\s*([A-Z][A-Za-z&.' ]{2,40}?)(?=\s*(?:\n|,|;|$|branch|account|acc|swift))/gi },
  { type: 'account_holder', re: /\b(?:account\s*(?:holder|name)|beneficiary(?:\s*name)?)\s*:\s*([A-Z][\w&.,'() \-]{2,60}?)(?=\s*(?:\n|;|$|bank|branch|account\s*n|acc))/gi },
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s-]\d{3,4}[\s-]\d{3,4}\b/g;

const TERMS_RE = /\b(?:within|net|payable\s+within|due\s+within|paid\s+within|payment\s+(?:terms?\s*(?:of|:)?)?\s*(?:within)?)\s*\(?((?:\d{1,3})|(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?))\)?\s*(?:\(\d{1,3}\)\s*)?(?:calendar\s+|business\s+|working\s+)?days?\b/gi;
const NET_RE = /\bnet\s?(\d{1,3})\b/gi;
const NOTICE_RE = /\b((?:\d{1,3})|(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|thirty|sixty|ninety))\s*(?:\(\d{1,3}\)\s*)?(days?|months?|weeks?)['’]?\s*(?:written\s+|prior\s+|advance\s+)*notice\b/gi;
const RENEWAL_RE = /\b(?:automatically\s+renew(?:s|ed)?|auto[- ]renew(?:al|s)?|renew(?:s|ed)?\s+automatically)\b[^.\n]{0,80}?(?:for\s+(?:a\s+)?(?:further\s+|successive\s+|additional\s+)?(?:period\s+of\s+)?((?:\d{1,2})|(?:one|two|three|twelve|twenty-four|thirty-six))\s*(?:\(\d{1,2}\)\s*)?(months?|years?))?/gi;
const PERCENT_RE = /\b(\d{1,3}(?:[.,]\d{1,2})?)\s?%/g;

const SUPPLIER_LABEL_RE = /\b(?:supplier|vendor|from|billed\s+by|seller|issued\s+by|company|payee|beneficiary|contractor|service\s+provider)\s*[:\-]\s*([A-Z][\w&.,'() \-]{2,60}?)(?=\s*(?:\n|;|\||$|\s{2,}|tel|phone|email|vat|reg|address|p\.?o\.?\s*box|\d{2,}))/gi;
const COMPANY_RE = /\b([A-Z][A-Za-z&'.-]+(?:\s+[A-Z][A-Za-z&'.-]+){0,4}\s+(?:\(Pty\)\s+Ltd|Pty\s+Ltd|\(Pty\)\s+Limited|Ltd|Limited|CC|LLC|Inc\.?|GmbH|PLC|Holdings|Trading))\b/g;

function labelBefore(text: string, offset: number): string | undefined {
  const window = text.slice(Math.max(0, offset - 40), offset).toLowerCase();
  const labels: [RegExp, string][] = [
    [/(grand\s+)?total(\s+(due|payable|amount|incl\.?\s*vat|including\s+vat))?\s*[:\-]?\s*$/, 'total'],
    [/amount\s+(due|payable)\s*[:\-]?\s*$/, 'total'],
    [/balance\s+due\s*[:\-]?\s*$/, 'total'],
    [/sub[\s-]?total\s*[:\-]?\s*$/, 'subtotal'],
    [/(vat|tax|gst)(\s*\(?\d{1,2}(\.\d+)?%\)?)?\s*[:\-]?\s*$/, 'tax'],
    [/discount\s*[:\-]?\s*$/, 'discount'],
    [/unit\s+price\s*[:\-]?\s*$/, 'unit_price'],
    [/(amount\s+)?paid\s*[:\-]?\s*$/, 'paid'],
    [/payment\s+amount\s*[:\-]?\s*$/, 'paid'],
    [/(invoice|issue|document)\s+date\s*[:\-]?\s*$/, 'invoice_date'],
    [/date\s+of\s+(issue|invoice)\s*[:\-]?\s*$/, 'invoice_date'],
    [/(due|payment\s+due|pay\s+by)\s+date\s*[:\-]?\s*$|due\s*[:\-]\s*$/, 'due_date'],
    [/(order|po)\s+date\s*[:\-]?\s*$/, 'order_date'],
    [/(delivery|delivered|received)\s+(date|on)\s*[:\-]?\s*$/, 'delivery_date'],
    [/(payment|paid|value|transaction)\s+(date|on)\s*[:\-]?\s*$/, 'payment_date'],
    [/(effective|commencement|start)\s+date\s*[:\-]?\s*$/, 'effective_date'],
    [/(expiry|expiration|end|termination)\s+date\s*[:\-]?\s*$|expires?\s+(on)?\s*[:\-]?\s*$/, 'expiry_date'],
    [/renewal\s+date\s*[:\-]?\s*$/, 'renewal_date'],
    [/warranty\s+(expiry|expires|until|end)\s*[:\-]?\s*$/, 'warranty_expiry'],
    [/valid\s+(until|to)\s*[:\-]?\s*$/, 'valid_until'],
    [/^.*\bdate\s*[:\-]?\s*$/, 'date'],
  ];
  for (const [re, label] of labels) if (re.test(window)) return label;
  return undefined;
}

function cleanRef(s: string): string {
  return s.replace(/[.,;:)\]]+$/, '').trim();
}

const REF_STOPWORDS = /^(date|number|no|total|amount|due|terms?|ref|reference|to|from|of|for|and|the)$/i;

export function extractEntities(segment: Pick<ExtractedSegment, 'text' | 'ordinal'>): ExtractedEntity[] {
  const text = segment.text;
  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();
  const push = (e: Omit<ExtractedEntity, 'segmentOrdinal' | 'origin'> & { origin?: ExtractedEntity['origin'] }) => {
    const key = `${e.type}|${e.offset}|${e.normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ origin: 'extracted', segmentOrdinal: segment.ordinal, ...e });
  };

  // Amounts with an explicit currency
  for (const m of text.matchAll(AMOUNT_RE)) {
    const curRaw = (m[1] ?? m[4] ?? '').trim();
    const numRaw = (m[2] ?? m[3] ?? '').trim();
    const value = parseAmount(numRaw);
    if (value === undefined) continue;
    const currency = CURRENCY_SYMBOLS[curRaw] ?? CURRENCY_SYMBOLS[curRaw.toUpperCase()];
    push({ type: 'amount', original: m[0].trim(), normalized: `${currency ?? ''}${value.toFixed(2)}`, numeric: value, currency, label: labelBefore(text, m.index ?? 0), confidence: currency ? 0.95 : 0.7, offset: m.index ?? 0 });
  }
  // Bare amounts directly after a monetary label ("Total: 12,500.00")
  for (const m of text.matchAll(/\b(total(?:\s+(?:due|payable|amount|incl\.?\s*vat))?|amount(?:\s+(?:due|paid|payable))?|sub[\s-]?total|vat|tax|discount|unit\s+price|price|balance\s+due|paid)\s*[:\-]?\s*(\(?-?\d{1,3}(?:[ ,]\d{3})*(?:\.\d{1,2})|\(?-?\d+\.\d{2})\b/gi)) {
    const offset = (m.index ?? 0) + m[0].indexOf(m[2]);
    if (out.some((e) => e.type === 'amount' && Math.abs(e.offset - offset) < 6)) continue;
    const value = parseAmount(m[2]);
    if (value === undefined) continue;
    push({ type: 'amount', original: m[2], normalized: value.toFixed(2), numeric: value, label: labelBefore(text, offset), confidence: 0.6, offset });
  }

  for (const m of text.matchAll(DATE_RE)) {
    const isoDate = parseDate(m[1]);
    if (!isoDate) continue;
    push({ type: 'date', original: m[1], normalized: isoDate, isoDate, label: labelBefore(text, m.index ?? 0), confidence: /^\d{1,2}[-/.]\d{1,2}[-/.]/.test(m[1]) && !/^(1[3-9]|2\d|3[01])/.test(m[1]) ? 0.75 : 0.95, offset: m.index ?? 0 });
  }

  for (const { type, re } of REF_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = cleanRef(m[1]);
      if (raw.length < 2 || REF_STOPWORDS.test(raw)) continue;
      if (!/\d/.test(raw)) continue;
      // Avoid treating dates as identifiers
      if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(raw)) continue;
      const offset = (m.index ?? 0) + m[0].lastIndexOf(m[1]);
      const prefix = type === 'invoice_number' ? 'inv' : type === 'po_number' ? 'po' : type === 'quote_number' ? 'q' : type === 'delivery_note_number' ? 'dn' : type === 'credit_note_number' ? 'cn' : '';
      let normalized = normalizeReference(raw);
      if (prefix) normalized = `${prefix}:${normalized.replace(new RegExp(`^(${prefix}|inv|po|qt|quo|q|dn|grn|cn)`), '')}`;
      push({ type, original: raw, normalized, confidence: 0.9, offset });
    }
  }

  for (const { type, re } of BANK_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = cleanRef(m[1]);
      const offset = (m.index ?? 0) + m[0].lastIndexOf(m[1]);
      const normalized = type === 'bank_name' || type === 'account_holder' ? normalizeCompany(raw) : normalizeAccount(raw);
      if (!normalized) continue;
      push({ type, original: raw, normalized, confidence: 0.85, offset });
    }
  }

  for (const m of text.matchAll(EMAIL_RE)) push({ type: 'email', original: m[0], normalized: m[0].toLowerCase(), confidence: 0.99, offset: m.index ?? 0 });
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) continue;
    if (out.some((e) => (e.type === 'bank_account' || e.type === 'date' || e.type === 'amount') && Math.abs(e.offset - (m.index ?? 0)) < 4)) continue;
    push({ type: 'phone', original: m[0].trim(), normalized: digits, confidence: 0.6, offset: m.index ?? 0 });
  }

  for (const m of text.matchAll(TERMS_RE)) {
    const days = parseNumberWord(m[1]);
    if (days === undefined || days <= 0 || days > 365) continue;
    push({ type: 'payment_terms', original: m[0].trim(), normalized: `${days}d`, numeric: days, label: 'payment_terms', confidence: 0.85, offset: m.index ?? 0 });
  }
  for (const m of text.matchAll(NET_RE)) {
    const days = Number(m[1]);
    if (days <= 0 || days > 365) continue;
    push({ type: 'payment_terms', original: m[0], normalized: `${days}d`, numeric: days, label: 'payment_terms', confidence: 0.8, offset: m.index ?? 0 });
  }
  for (const m of text.matchAll(NOTICE_RE)) {
    const n = parseNumberWord(m[1]);
    if (n === undefined) continue;
    const unit = m[2].toLowerCase().startsWith('month') ? 30 : m[2].toLowerCase().startsWith('week') ? 7 : 1;
    push({ type: 'notice_period', original: m[0].trim(), normalized: `${n * unit}d`, numeric: n * unit, label: `${n} ${m[2].toLowerCase()}`, confidence: 0.8, offset: m.index ?? 0 });
  }
  for (const m of text.matchAll(RENEWAL_RE)) {
    const n = m[1] ? parseNumberWord(m[1]) : undefined;
    const months = n !== undefined ? (m[2]?.toLowerCase().startsWith('year') ? n * 12 : n) : undefined;
    push({ type: 'renewal_term', original: m[0].trim(), normalized: months ? `${months}m` : 'auto', numeric: months, label: 'auto_renewal', confidence: 0.8, offset: m.index ?? 0 });
  }
  for (const m of text.matchAll(PERCENT_RE)) {
    const v = parseAmount(m[1]);
    if (v === undefined || v > 100) continue;
    push({ type: 'percentage', original: m[0], normalized: `${v}%`, numeric: v, label: labelBefore(text, m.index ?? 0), confidence: 0.9, offset: m.index ?? 0 });
  }

  for (const m of text.matchAll(SUPPLIER_LABEL_RE)) {
    const raw = cleanRef(m[1]);
    if (raw.length < 3 || /^\d/.test(raw)) continue;
    const offset = (m.index ?? 0) + m[0].lastIndexOf(m[1]);
    push({ type: 'supplier', original: raw, normalized: normalizeCompany(raw), label: m[0].split(/[:\-]/)[0].trim().toLowerCase(), confidence: 0.85, offset });
  }
  for (const m of text.matchAll(COMPANY_RE)) {
    const raw = m[1].trim();
    const normalized = normalizeCompany(raw);
    if (!normalized || out.some((e) => e.type === 'supplier' && e.normalized === normalized)) continue;
    push({ type: 'supplier', original: raw, normalized, label: 'company_name', confidence: 0.6, offset: m.index ?? 0 });
  }

  return out.sort((a, b) => a.offset - b.offset);
}

export function extractAllEntities(segments: Pick<ExtractedSegment, 'text' | 'ordinal'>[]): ExtractedEntity[] {
  return segments.flatMap((s) => extractEntities(s));
}
