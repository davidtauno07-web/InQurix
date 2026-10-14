import type { ExtractedSegment, ExtractionResult } from '../types.js';
import { normalizeText } from '../normalize.js';
import type { ProcessingLimits } from '../limits.js';

export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf);
  // Fall back to windows-1252 when the file is clearly not UTF-8
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (bad > 0 && bad / Math.max(utf8.length, 1) > 0.001) return new TextDecoder('windows-1252').decode(buf);
  return utf8;
}

/**
 * Split prose into paragraph segments, keeping headings as their own segment
 * and carrying the most recent heading as context. Long paragraphs are split
 * on sentence boundaries so a single match keeps a readable amount of context.
 */
export function segmentProse(text: string, limits: ProcessingLimits, method: ExtractedSegment['method'], base: Partial<ExtractedSegment['location']> = {}, startOrdinal = 0): ExtractedSegment[] {
  const segments: ExtractedSegment[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n+/);
  let heading: string | undefined;
  let paragraph = 0;
  let line = 1;
  for (const rawBlock of blocks) {
    const blockLines = rawBlock.split('\n').length;
    const block = normalizeText(rawBlock);
    const startLine = line;
    line += blockLines + 1;
    if (!block) continue;
    const isHeading = block.length < 90 && !/[.:;,]$/.test(block) && !block.includes('\n') && (/^(\d+(\.\d+)*\.?\s+)?[A-Z]/.test(block)) && (block === block.toUpperCase() || /^(\d+(\.\d+)*\.?\s+)/.test(block) || /^(section|clause|article|part|schedule)\b/i.test(block));
    if (isHeading) {
      heading = block;
      segments.push({ ordinal: startOrdinal + segments.length, kind: 'heading', text: block, method, location: { ...base, heading: block, line: startLine } });
      continue;
    }
    paragraph++;
    for (const chunk of splitLong(block, limits.maxSegmentChars)) {
      segments.push({ ordinal: startOrdinal + segments.length, kind: 'paragraph', text: chunk, method, location: { ...base, heading, paragraph, line: startLine } });
      if (segments.length >= limits.maxSegments) return segments;
    }
  }
  return segments;
}

export function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).length > max && cur) {
      out.push(cur.trim());
      cur = '';
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
    } else cur += (cur ? ' ' : '') + s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function extractPlainText(buf: Uint8Array, limits: ProcessingLimits): ExtractionResult {
  const text = decodeText(buf);
  const segments = segmentProse(text, limits, 'text');
  return { kind: 'txt', status: segments.length ? 'indexed' : 'empty', segments, metadata: {}, warnings: [] };
}

/** RFC 4180 CSV parser with delimiter sniffing (comma, semicolon, tab). */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : text.length);
  const delims = [',', ';', '\t', '|'];
  const delim = delims.map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((c) => c.trim() !== '')) rows.push(row); }
  return rows;
}

export function columnLetter(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Heuristic: first row is a header when it is mostly non-numeric and distinct. */
export function detectHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0].map((c) => c.trim()).filter(Boolean);
  if (first.length < 2) return false;
  const numeric = first.filter((c) => /^-?[\d.,\s$€£%N]+$/.test(c)).length;
  return numeric / first.length < 0.3 && new Set(first).size === first.length;
}

/**
 * Turn tabular rows into row segments. Each row keeps its sheet, row number
 * and a header->value map so a match can be shown as "Sheet1!B14" and
 * structured fields can be searched without guessing column meaning.
 */
export function rowsToSegments(rows: string[][], limits: ProcessingLimits, method: ExtractedSegment['method'], sheet?: string, startOrdinal = 0, rowNumbers?: number[]): ExtractedSegment[] {
  const segments: ExtractedSegment[] = [];
  const hasHeader = detectHeader(rows);
  const header = hasHeader ? rows[0].map((h, i) => normalizeText(h) || columnLetter(i)) : undefined;
  const limit = Math.min(rows.length, limits.maxSheetRows);
  for (let r = hasHeader ? 1 : 0; r < limit; r++) {
    const row = rows[r];
    const cells = row.map((c) => normalizeText(String(c ?? '')));
    if (!cells.some(Boolean)) continue;
    const rowNumber = rowNumbers?.[r] ?? r + 1;
    const fields: Record<string, string> = {};
    const parts: string[] = [];
    cells.forEach((c, i) => {
      if (!c) return;
      const key = header?.[i] ?? columnLetter(i);
      fields[key] = c;
      parts.push(header ? `${key}: ${c}` : c);
    });
    const lastCol = columnLetter(Math.max(cells.length - 1, 0));
    segments.push({
      ordinal: startOrdinal + segments.length,
      kind: 'row',
      text: parts.join(' | ').slice(0, limits.maxSegmentChars),
      method,
      location: { sheet, row: rowNumber, range: `A${rowNumber}:${lastCol}${rowNumber}` },
      fields,
    });
    if (segments.length >= limits.maxSegments) break;
  }
  return segments;
}

export function extractCsv(buf: Uint8Array, limits: ProcessingLimits): ExtractionResult {
  const rows = parseCsv(decodeText(buf));
  const segments = rowsToSegments(rows, limits, 'spreadsheet');
  const warnings = rows.length > limits.maxSheetRows ? [{ code: 'rows_truncated', message: `Only the first ${limits.maxSheetRows} rows were indexed` }] : [];
  return { kind: 'csv', status: segments.length ? (warnings.length ? 'partial' : 'indexed') : 'empty', segments, metadata: {}, warnings };
}
