import type { ExtractionResult } from '../types.js';
import type { ProcessingLimits } from '../limits.js';
import { segmentProse } from './text.js';

/**
 * Minimal, safe RTF to text converter. It never interprets embedded objects
 * (\object, \pict, \bin are skipped) and only decodes text, paragraphs and
 * escaped characters.
 */
export function rtfToText(rtf: string): string {
  const SKIP_DESTINATIONS = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'header', 'footer', 'fldinst']);
  let out = '';
  const stack: { skip: boolean; uc: number }[] = [];
  let skip = false;
  let uc = 1;
  let pendingSkipChars = 0;
  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') { stack.push({ skip, uc }); i++; continue; }
    if (ch === '}') { const s = stack.pop(); if (s) { skip = s.skip; uc = s.uc; } i++; continue; }
    if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') { if (!skip) out += next; i += 2; continue; }
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        if (pendingSkipChars > 0) pendingSkipChars--;
        else if (!skip) out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        continue;
      }
      if (next === '*') { skip = true; i += 2; continue; }
      if (next === '~') { if (!skip) out += ' '; i += 2; continue; }
      if (next === '-' || next === '_') { i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (!m) { i++; continue; }
      const word = m[1];
      const param = m[2] !== undefined ? Number(m[2]) : undefined;
      i += m[0].length;
      if (SKIP_DESTINATIONS.has(word)) { skip = true; continue; }
      if (word === 'bin' && param) { i += param; continue; }
      if (skip) continue;
      if (word === 'par' || word === 'line' || word === 'sect' || word === 'page') out += '\n\n';
      else if (word === 'tab' || word === 'cell') out += '\t';
      else if (word === 'row') out += '\n';
      else if (word === 'uc' && param !== undefined) uc = param;
      else if (word === 'u' && param !== undefined) { out += String.fromCharCode(param < 0 ? param + 65536 : param); pendingSkipChars = uc; }
      else if (word === 'emdash') out += '—';
      else if (word === 'endash') out += '–';
      else if (word === 'lquote' || word === 'rquote') out += "'";
      else if (word === 'ldblquote' || word === 'rdblquote') out += '"';
      else if (word === 'bullet') out += '•';
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (pendingSkipChars > 0) { pendingSkipChars--; i++; continue; }
    if (!skip) out += ch;
    i++;
  }
  return out;
}

export function extractRtf(buf: Uint8Array, limits: ProcessingLimits): ExtractionResult {
  const text = rtfToText(new TextDecoder('latin1').decode(buf));
  const segments = segmentProse(text, limits, 'rtf');
  return { kind: 'rtf', status: segments.length ? 'indexed' : 'empty', segments, metadata: {}, warnings: [] };
}
