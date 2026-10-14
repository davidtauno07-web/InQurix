/**
 * Normalisation helpers. Normalised values are only used for matching; the
 * original text is always retained alongside them and shown as evidence.
 */

export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** For keyword matching: lower-case, accents stripped, punctuation collapsed. */
export function foldForSearch(s: string): string {
  return normalizeText(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}$%.,/@\- ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise a reference / identifier for exact matching: case-folded, with
 * spacing, dashes, slashes, dots and '#' removed. "INV-001048", "inv 1048"
 * and "INV#1048" normalise to "inv1048" when stripLeadingZeros is set.
 * Prefixes are preserved so that "PO-1048" and "INV-1048" stay distinct.
 */
export function normalizeReference(s: string, stripLeadingZeros = true): string {
  const compact = s.toLowerCase().replace(/(no\.?|number|nr\.?|#)/g, '').replace(/[\s\-_/.:#]+/g, '');
  if (!stripLeadingZeros) return compact;
  return compact.replace(/(^|[a-z])0+(\d)/g, '$1$2');
}

/** Digits-only form used for bank account comparison. */
export function normalizeAccount(s: string): string {
  return s.replace(/[^0-9a-z]/gi, '').toUpperCase();
}

const COMPANY_SUFFIXES = /\b(pty|ltd|limited|llc|inc|incorporated|cc|corp|corporation|co|company|gmbh|plc|sa|bv|nv|ag|holdings|group|\(pty\)|trading)\b\.?/g;

export function normalizeCompany(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[()[\],.'"]/g, ' ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const CURRENCY_SYMBOLS: Record<string, string> = {
  'N$': 'NAD',
  NAD: 'NAD',
  R: 'ZAR',
  ZAR: 'ZAR',
  US$: 'USD',
  USD: 'USD',
  $: 'USD',
  '€': 'EUR',
  EUR: 'EUR',
  '£': 'GBP',
  GBP: 'GBP',
  BWP: 'BWP',
  P: 'BWP',
  KES: 'KES',
  NGN: 'NGN',
  '₦': 'NGN',
  AUD: 'AUD',
  'A$': 'AUD',
  CAD: 'CAD',
  'C$': 'CAD',
  CHF: 'CHF',
  JPY: 'JPY',
  '¥': 'JPY',
  INR: 'INR',
  '₹': 'INR',
  CNY: 'CNY',
};

/**
 * Parse a monetary amount string. Supports "1,234.56", "1 234,56", "1.234,56",
 * "(1,234.56)" negatives and "-1234". Returns undefined when ambiguous.
 */
export function parseAmount(raw: string): number | undefined {
  let s = raw.trim().replace(/\s(?=\d{3}\b)/g, '').replace(/[\u00a0']/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/[^\d.,]/g, '');
  if (!s || !/\d/.test(s)) return undefined;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // the later separator is the decimal separator
    normalized = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    const commas = (s.match(/,/g) ?? []).length;
    normalized = commas === 1 && decimals !== 3 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot >= 0) {
    const dots = (s.match(/\./g) ?? []).length;
    const decimals = s.length - lastDot - 1;
    normalized = dots > 1 && decimals === 3 ? s.replace(/\./g, '') : dots > 1 ? s.replace(/\.(?=.*\.)/g, '') : s;
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return undefined;
  return Math.round((negative ? -n : n) * 100) / 100;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export type DateOrder = 'DMY' | 'MDY';

function iso(y: number, m: number, d: number): string | undefined {
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return undefined;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse a date in common business formats. Numeric dates default to
 * day-first (DMY, as used in Namibia/SA/UK) unless `order` says otherwise;
 * a value like 13/02/2025 is unambiguous either way.
 */
export function parseDate(raw: string, order: DateOrder = 'DMY'): string | undefined {
  const s = raw.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12) return iso(y, b, a);
    if (b > 12) return iso(y, a, b);
    return order === 'DMY' ? iso(y, b, a) : iso(y, a, b);
  }
  m = s.match(/^(\d{1,2})[ -]([a-z]{3,9})\.?[ -](\d{2,4})$/);
  if (m && MONTHS[m[2]]) return iso(+m[3], MONTHS[m[2]], +m[1]);
  m = s.match(/^([a-z]{3,9})\.? (\d{1,2}) (\d{4})$/);
  if (m && MONTHS[m[1]]) return iso(+m[3], MONTHS[m[1]], +m[2]);
  m = s.match(/^([a-z]{3,9})\.? (\d{4})$/);
  if (m && MONTHS[m[1]]) return iso(+m[2], MONTHS[m[1]], 1);
  return undefined;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/** "thirty" -> 30, "forty-five" -> 45, "30" -> 30 */
export function parseNumberWord(s: string): number | undefined {
  const t = s.toLowerCase().trim();
  if (/^\d+$/.test(t)) return Number(t);
  const parts = t.split(/[\s-]+/).filter((p) => p !== 'and');
  let total = 0;
  for (const p of parts) {
    const v = NUMBER_WORDS[p];
    if (v === undefined) return undefined;
    if (v === 100) total = (total || 1) * 100;
    else total += v;
  }
  return parts.length ? total : undefined;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatMoney(n: number | undefined, currency?: string): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const sym = currency === 'NAD' ? 'N$' : currency === 'ZAR' ? 'R' : currency === 'USD' ? 'US$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency ? `${currency} ` : '';
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Levenshtein distance limited to small strings (used for near-duplicate references). */
export function editDistance(a: string, b: string, max = 4): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

/** Token-set Jaccard similarity on folded words (length >= 3). */
export function jaccard(a: string, b: string): number {
  const ta = new Set(foldForSearch(a).split(' ').filter((w) => w.length >= 3));
  const tb = new Set(foldForSearch(b).split(' ').filter((w) => w.length >= 3));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}
