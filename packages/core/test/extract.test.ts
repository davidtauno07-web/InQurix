import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocument, extractAllEntities, terminateOcr, identify, inspectZip, assertSafeZip, DEFAULT_LIMITS, parseAmount, parseDate, normalizeReference } from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inqurix-fx-'));
const TESSDATA = ['/usr/share/tesseract-ocr/5/tessdata', '/usr/share/tesseract-ocr/4.00/tessdata'].find((d) => fs.existsSync(path.join(d, 'eng.traineddata')));
const read = (f: string) => fs.readFileSync(path.join(dir, f));

beforeAll(() => {
  execFileSync(process.execPath, [path.join(root, 'scripts/generate-fixtures.mjs'), dir]);
}, 60_000);

describe('identification', () => {
  it('rejects executables regardless of extension', () => {
    expect(identify(new Uint8Array([0x4d, 0x5a, 0x90, 0]), 'invoice.pdf').dangerous).toBe(true);
    expect(identify(new Uint8Array([0x25, 0x50]), 'macro.docm').dangerous).toBe(true);
  });
  it('detects macro-enabled OOXML by content', () => {
    const id = identify(new Uint8Array([0x50, 0x4b, 3, 4]), 'report.docx', ['word/document.xml', 'word/vbaProject.bin']);
    expect(id.dangerous).toBe(true);
  });
  it('flags text masquerading as PDF', async () => {
    const o = await extractDocument(read('looks-like-text.pdf'), 'looks-like-text.pdf');
    expect(o.identification.kind).toBe('txt');
    expect(o.identification.mismatch).toBe(true);
    expect(o.result.warnings.map((w) => w.code)).toContain('extension_mismatch');
  });
});

describe('zip safety', () => {
  it('rejects path traversal and bombs', () => {
    expect(() => assertSafeZip([{ name: '../evil.txt', compressedSize: 10, uncompressedSize: 10, encrypted: false }], DEFAULT_LIMITS)).toThrow();
    expect(() => assertSafeZip([{ name: 'a.xml', compressedSize: 1000, uncompressedSize: 900_000_000, encrypted: false }], DEFAULT_LIMITS)).toThrow();
  });
  it('reads the central directory of real OOXML', () => {
    const entries = inspectZip(read('purchase-order-PO-7731.docx'));
    expect(entries.map((e) => e.name)).toContain('word/document.xml');
  });
});

describe('normalization', () => {
  it('parses money in local conventions', () => {
    expect(parseAmount('N$ 14,317.50')).toBe(14317.5);
    expect(parseAmount('18250,00')).toBe(18250);
    expect(parseAmount('(1 200.00)')).toBe(-1200);
  });
  it('parses day-first dates', () => {
    expect(parseDate('14/03/2026')).toBe('2026-03-14');
    expect(parseDate('1 April 2025')).toBe('2025-04-01');
  });
  it('normalizes references with leading zeros', () => {
    expect(normalizeReference('INV-01048', true)).toBe(normalizeReference('INV 1048', true));
  });
});

describe('extractors', () => {
  it('PDF keeps page locations and invoice entities', async () => {
    const o = await extractDocument(read('invoice-INV-1048.pdf'), 'invoice-INV-1048.pdf');
    expect(o.result.status).toBe('indexed');
    expect(o.result.metadata.pageCount).toBe(1);
    expect(o.result.segments.every((s) => s.location.page === 1)).toBe(true);
    const ents = extractAllEntities(o.result.segments);
    const amounts = ents.filter((e) => e.type === 'amount').map((e) => e.numeric);
    expect(amounts).toContain(14317.5);
    expect(amounts).not.toContain(40);
    expect(ents.find((e) => e.type === 'invoice_number')?.normalized).toBe('inv:1048');
    expect(ents.find((e) => e.type === 'po_number')?.normalized).toBe('po:7731');
    expect(ents.find((e) => e.type === 'bank_account')?.normalized).toBe('62012345678');
  });
  it('DOCX keeps headings and table rows', async () => {
    const o = await extractDocument(read('purchase-order-PO-7731.docx'), 'purchase-order-PO-7731.docx');
    expect(o.result.metadata.title).toBe('Purchase Order PO-7731');
    const row = o.result.segments.find((s) => s.text.includes('Toner'));
    expect(row?.fields?.['Unit Price']).toBe('N$ 650.00');
  });
  it('XLSX keeps sheet, row and formula cells', async () => {
    const o = await extractDocument(read('payments-2026.xlsx'), 'payments-2026.xlsx');
    const row = o.result.segments.find((s) => s.text.includes('PAY-2297'));
    expect(row?.location.sheet).toBe('Payments 2026');
    expect(row?.location.row).toBe(5);
    const total = o.result.segments.find((s) => Object.values(s.cells ?? {}).some((c) => c.f));
    expect(Object.values(total?.cells ?? {}).find((c) => c.f)?.f).toContain('SUM');
  });
  it('PPTX keeps slide numbers and speaker notes', async () => {
    const o = await extractDocument(read('board-meeting-2026-03.pptx'), 'board-meeting-2026-03.pptx');
    expect(o.result.segments.find((s) => s.text.includes('renegotiate'))?.location.slide).toBe(2);
    expect(o.result.segments.find((s) => s.location.section === 'Speaker notes')?.text).toContain('compare the last three invoices');
  });
  it('EML extracts headers, body and attachments', async () => {
    const o = await extractDocument(read('bank-details-change.eml'), 'bank-details-change.eml');
    expect(o.result.metadata.email?.from).toContain('supp1ies');
    expect(o.result.children?.[0]?.result.segments.map((s) => s.text).join(' ')).toContain('04123987650');
  });
  it('HTML drops scripts; RTF and CSV are readable', async () => {
    const h = await extractDocument(read('intranet-supplier-policy.html'), 'intranet-supplier-policy.html');
    expect(h.result.segments.map((s) => s.text).join(' ')).not.toContain('alert');
    const r = await extractDocument(read('meeting-notes-procurement.rtf'), 'meeting-notes-procurement.rtf');
    expect(r.result.segments.map((s) => s.text).join(' ')).toContain('two approvals');
    const c = await extractDocument(read('transactions-march.csv'), 'transactions-march.csv');
    expect(c.result.segments[1]?.fields?.Reference).toBe('TRX-88121');
  });
  it('rejects executables', async () => {
    const o = await extractDocument(read('program.exe'), 'program.exe');
    expect(o.result.status).toBe('unsupported');
  });
  it('reports scanned PDFs as needing OCR when OCR is off', async () => {
    const o = await extractDocument(read('scanned-delivery-note-DN-5520.pdf'), 'scanned.pdf');
    expect(o.result.status).toBe('ocr_required');
  });
  it.skipIf(!TESSDATA)('OCRs scanned PDFs locally', async () => {
    const o = await extractDocument(read('scanned-delivery-note-DN-5520.pdf'), 'scanned.pdf', { ocr: { langPath: TESSDATA } });
    expect(o.result.status).toBe('indexed');
    expect(o.result.segments[0]?.method).toBe('ocr');
    expect(o.result.segments.map((s) => s.text).join(' ')).toContain('DN-5520');
    await terminateOcr();
  }, 60_000);
  it.skipIf(!TESSDATA)('reports a damaged image as failed without crashing, and OCR keeps working', async () => {
    const damaged = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF damaged image data '.repeat(20))]);
    const bad = await extractDocument(damaged, 'photo.jpg', { ocr: { langPath: TESSDATA } });
    expect(bad.result.status).toBe('failed');
    const good = await extractDocument(read('scanned-delivery-note-DN-5520.pdf'), 'scanned.pdf', { ocr: { langPath: TESSDATA } });
    expect(good.result.status).toBe('indexed');
    await terminateOcr();
  }, 60_000);
  it('reports missing or undownloadable OCR language data as a failure instead of crashing', async () => {
    const damaged = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'inqurix-notess-'));
    const missing = await extractDocument(damaged, 'scan.jpg', { ocr: { langPath: empty } });
    expect(missing.result.status).toBe('failed');
    expect(missing.result.warnings[0]?.message).toMatch(/language data/);
    const offline = await extractDocument(damaged, 'scan2.jpg', { ocr: { langPath: 'http://127.0.0.1:9/tessdata', cachePath: empty } });
    expect(offline.result.status).toBe('failed');
    expect(offline.result.warnings[0]?.message).toMatch(/needs internet/);
    await terminateOcr();
  }, 60_000);
});
