import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { parse as parseHtml } from 'node-html-parser';
import type { DocumentMetadata, ExtractedSegment, ExtractionResult } from '../types.js';
import { EncryptedDocumentError, type ProcessingLimits } from '../limits.js';
import { assertSafeZip, inspectZip } from './zip.js';
import { columnLetter, detectHeader, splitLong } from './text.js';
import { normalizeText } from '../normalize.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', processEntities: true, htmlEntities: false, allowBooleanAttributes: true });

async function openZip(buf: Uint8Array, limits: ProcessingLimits): Promise<JSZip> {
  const entries = inspectZip(buf);
  if (entries.some((e) => e.encrypted)) throw new EncryptedDocumentError();
  assertSafeZip(entries, limits);
  return JSZip.loadAsync(buf);
}

async function coreProps(zip: JSZip): Promise<DocumentMetadata> {
  const f = zip.file('docProps/core.xml');
  if (!f) return {};
  const doc = xml.parse(await f.async('string'));
  const cp = doc['cp:coreProperties'] ?? {};
  const val = (k: string) => {
    const v = cp[k];
    return typeof v === 'object' ? (v?.['#text'] as string | undefined) : (v as string | undefined);
  };
  return {
    title: val('dc:title') ? String(val('dc:title')) : undefined,
    author: val('dc:creator') ? String(val('dc:creator')) : undefined,
    createdAt: val('dcterms:created') ? String(val('dcterms:created')) : undefined,
    modifiedAt: val('dcterms:modified') ? String(val('dcterms:modified')) : undefined,
  };
}

/** DOCX: paragraphs with heading context, tables as row segments. Macros/OLE objects are ignored. */
export async function extractDocx(buf: Uint8Array, limits: ProcessingLimits): Promise<ExtractionResult> {
  const zip = await openZip(buf, limits);
  const metadata = await coreProps(zip);
  const { value: html, messages } = await mammoth.convertToHtml({ buffer: Buffer.from(buf) }, { includeDefaultStyleMap: true, convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
  const root = parseHtml(html);
  const segments: ExtractedSegment[] = [];
  let heading: string | undefined;
  let paragraph = 0;
  let tableNo = 0;
  for (const node of root.childNodes) {
    const el = node as unknown as { tagName?: string; text: string; querySelectorAll: (s: string) => { querySelectorAll: (s: string) => { text: string }[] }[] };
    const tag = el.tagName?.toLowerCase();
    if (!tag) continue;
    if (/^h[1-6]$/.test(tag)) {
      heading = normalizeText(el.text);
      if (heading) segments.push({ ordinal: segments.length, kind: 'heading', text: heading, method: 'ooxml', location: { heading } });
      continue;
    }
    if (tag === 'table') {
      tableNo++;
      const rows = el.querySelectorAll('tr').map((tr) => tr.querySelectorAll('td,th').map((c) => normalizeText(c.text)));
      const header = detectHeader(rows) ? rows[0] : undefined;
      rows.forEach((cells, r) => {
        if (header && r === 0) return;
        if (!cells.some(Boolean)) return;
        const fields: Record<string, string> = {};
        cells.forEach((c, i) => { if (c) fields[header?.[i] || columnLetter(i)] = c; });
        segments.push({ ordinal: segments.length, kind: 'row', text: cells.map((c, i) => (header?.[i] ? `${header[i]}: ${c}` : c)).filter(Boolean).join(' | '), method: 'ooxml', location: { heading, section: `Table ${tableNo}`, row: r + 1 }, fields });
      });
      continue;
    }
    const text = normalizeText(el.text);
    if (!text) continue;
    paragraph++;
    for (const chunk of splitLong(text, limits.maxSegmentChars)) {
      segments.push({ ordinal: segments.length, kind: 'paragraph', text: chunk, method: 'ooxml', location: { heading, paragraph } });
    }
    if (segments.length >= limits.maxSegments) break;
  }
  const warnings = messages.filter((m) => m.type === 'error').map((m) => ({ code: 'docx_warning', message: m.message }));
  return { kind: 'docx', status: segments.length ? 'indexed' : 'empty', segments, metadata, warnings };
}

function cellText(v: ExcelJS.CellValue): { v: string; f?: string } {
  if (v === null || v === undefined) return { v: '' };
  if (v instanceof Date) return { v: v.toISOString().slice(0, 10) };
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('formula' in o || 'sharedFormula' in o) {
      const res = o.result as ExcelJS.CellValue;
      return { v: res === undefined || res === null ? '' : cellText(res).v, f: String(o.formula ?? o.sharedFormula ?? '') };
    }
    if ('richText' in o) return { v: (o.richText as { text: string }[]).map((t) => t.text).join('') };
    if ('text' in o) return { v: String(o.text) };
    if ('error' in o) return { v: String(o.error) };
    return { v: '' };
  }
  return { v: String(v) };
}

/** XLSX: one segment per row with sheet/row/cell addresses, header mapping, formulas and displayed values. */
export async function extractXlsx(buf: Uint8Array, limits: ProcessingLimits): Promise<ExtractionResult> {
  const zip = await openZip(buf, limits);
  const metadata = await coreProps(zip);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buf) as unknown as ArrayBuffer);
  const segments: ExtractedSegment[] = [];
  const warnings: ExtractionResult['warnings'] = [];
  metadata.sheetNames = [];
  for (const ws of wb.worksheets) {
    metadata.sheetNames.push(ws.name);
    if (ws.state === 'veryHidden') continue;
    const rows: { n: number; cells: { v: string; f?: string; col: number }[] }[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (rows.length >= limits.maxSheetRows) return;
      const cells: { v: string; f?: string; col: number }[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const t = cellText(cell.value);
        if (t.v !== '' || t.f) cells.push({ ...t, v: cell.numFmt && typeof cell.value === 'number' && /0\.00/.test(cell.numFmt) ? (cell.value as number).toFixed(2) : t.v, col: col - 1 });
      });
      if (cells.length) rows.push({ n, cells });
    });
    if (ws.rowCount > limits.maxSheetRows) warnings.push({ code: 'rows_truncated', message: `Sheet ${ws.name}: only the first ${limits.maxSheetRows} rows were indexed` });
    const grid = rows.map((r) => {
      const a: string[] = [];
      for (const c of r.cells) a[c.col] = c.v;
      return Array.from(a, (x) => x ?? '');
    });
    const hasHeader = detectHeader(grid);
    const header = hasHeader ? grid[0] : undefined;
    rows.forEach((r, idx) => {
      if (hasHeader && idx === 0) return;
      const fields: Record<string, string> = {};
      const cells: NonNullable<ExtractedSegment['cells']> = {};
      const parts: string[] = [];
      for (const c of r.cells) {
        const letter = columnLetter(c.col);
        const h = header?.[c.col] ? normalizeText(header[c.col]) : undefined;
        const v = normalizeText(c.v);
        cells[letter] = { v, ...(c.f ? { f: c.f } : {}), ...(h ? { h } : {}) };
        if (!v) continue;
        fields[h ?? letter] = v;
        parts.push(h ? `${h}: ${v}` : v);
      }
      if (!parts.length) return;
      const first = columnLetter(Math.min(...r.cells.map((c) => c.col)));
      const last = columnLetter(Math.max(...r.cells.map((c) => c.col)));
      segments.push({ ordinal: segments.length, kind: 'row', text: parts.join(' | ').slice(0, limits.maxSegmentChars), method: 'spreadsheet', location: { sheet: ws.name, row: r.n, range: `${first}${r.n}:${last}${r.n}` }, fields, cells });
    });
    if (segments.length >= limits.maxSegments) break;
  }
  return { kind: 'xlsx', status: segments.length ? (warnings.length ? 'partial' : 'indexed') : 'empty', segments, metadata, warnings };
}

function collectText(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return; }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'a:t') {
        const arr = Array.isArray(v) ? v : [v];
        for (const t of arr) out.push(typeof t === 'object' ? String((t as Record<string, unknown>)['#text'] ?? '') : String(t));
      } else if (k === 'a:p') {
        const paras = Array.isArray(v) ? v : [v];
        for (const p of paras) { const parts: string[] = []; collectText(p, parts); out.push(parts.join('') + '\n'); }
      } else if (!k.startsWith('@')) collectText(v, out);
    }
  }
}

/** PPTX: one segment per slide (plus speaker notes), keeping slide numbers. */
export async function extractPptx(buf: Uint8Array, limits: ProcessingLimits): Promise<ExtractionResult> {
  const zip = await openZip(buf, limits);
  const metadata = await coreProps(zip);
  const slideFiles = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  const segments: ExtractedSegment[] = [];
  for (const f of slideFiles) {
    const slide = Number(f.match(/(\d+)\.xml$/)![1]);
    const parts: string[] = [];
    collectText(xml.parse(await zip.file(f)!.async('string')), parts);
    const text = normalizeText(parts.join('').replace(/\n+/g, '\n'));
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${slide}.xml`);
    let notes = '';
    if (notesFile) { const np: string[] = []; collectText(xml.parse(await notesFile.async('string')), np); notes = normalizeText(np.join('').replace(/\n+/g, '\n')).replace(/^\d+$/m, ''); }
    const title = text.split('\n')[0];
    if (text) for (const chunk of splitLong(text, limits.maxSegmentChars)) segments.push({ ordinal: segments.length, kind: 'slide', text: chunk, method: 'ooxml', location: { slide, heading: title } });
    if (notes.trim()) segments.push({ ordinal: segments.length, kind: 'paragraph', text: notes.trim(), method: 'ooxml', location: { slide, section: 'Speaker notes', heading: title } });
  }
  metadata.slideCount = slideFiles.length;
  return { kind: 'pptx', status: segments.length ? 'indexed' : 'empty', segments, metadata, warnings: [] };
}

export async function zipEntryNames(buf: Uint8Array): Promise<string[]> {
  return inspectZip(buf).map((e) => e.name);
}
