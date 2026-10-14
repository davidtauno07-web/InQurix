import { createRequire } from 'node:module';
import path from 'node:path';
import type { ExtractedSegment, ExtractionResult, ExtractionWarning } from '../types.js';
import { EncryptedDocumentError, type ProcessingLimits } from '../limits.js';
import { normalizeText } from '../normalize.js';
import { segmentProse } from './text.js';
import { ocrImage, ocrSegments, type OcrOptions } from './ocr.js';

const require = createRequire(import.meta.url);

function pdfjsAssetDir(sub: string): string {
  const pkg = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return path.join(pkg, sub) + path.sep;
}

function pdfDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw);
  if (!m) return undefined;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

interface TextItem { str: string; hasEOL?: boolean; transform?: number[] }

/** Rebuild reading-order lines from positioned text items. */
export function itemsToText(items: TextItem[]): string {
  let out = '';
  let lastY: number | undefined;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = it.transform?.[5];
    if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) {
      out += Math.abs(y - lastY) > 18 ? '\n\n' : '\n';
    } else if (out && !out.endsWith('\n') && !out.endsWith(' ') && it.str && !it.str.startsWith(' ')) {
      out += ' ';
    }
    out += it.str;
    if (it.hasEOL) out += '\n';
    if (y !== undefined) lastY = y;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ');
}

export interface PdfOptions {
  ocr?: OcrOptions;
}

export async function extractPdf(buf: Uint8Array, limits: ProcessingLimits, opts: PdfOptions = {}): Promise<ExtractionResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const warnings: ExtractionWarning[] = [];
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
    standardFontDataUrl: pdfjsAssetDir('standard_fonts'),
    cMapUrl: pdfjsAssetDir('cmaps'),
    cMapPacked: true,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'PasswordException') throw new EncryptedDocumentError('PDF is password protected');
    throw e;
  }
  try {
    const meta = await doc.getMetadata().catch(() => undefined);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const pageCount = doc.numPages;
    const maxPages = Math.min(pageCount, limits.maxPdfPages);
    if (pageCount > maxPages) warnings.push({ code: 'pages_truncated', message: `Only the first ${maxPages} of ${pageCount} pages were indexed.` });
    const segments: ExtractedSegment[] = [];
    const needOcr: number[] = [];
    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const text = itemsToText(tc.items as TextItem[]);
      if (normalizeText(text).length < 16) {
        needOcr.push(p);
      } else {
        segments.push(...segmentProse(text, limits, 'pdf_text', { page: p, pageCount }, segments.length));
      }
      page.cleanup();
      if (segments.length >= limits.maxSegments) {
        warnings.push({ code: 'segments_truncated', message: 'Segment limit reached.' });
        break;
      }
    }
    let ocrConfidence: number | undefined;
    let ocrPagesDone = 0;
    if (needOcr.length && limits.ocr && opts.ocr) {
      const { createCanvas } = await import('@napi-rs/canvas');
      const confs: number[] = [];
      for (const p of needOcr.slice(0, limits.ocrMaxPages)) {
        try {
          const page = await doc.getPage(p);
          const viewport = page.getViewport({ scale: 2 });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;
          const png = await canvas.encode('png');
          const r = await ocrImage(png, opts.ocr);
          confs.push(r.confidence);
          segments.push(...ocrSegments(r.text, r.confidence, p, segments.length).map((s) => ({ ...s, location: { ...s.location, pageCount } })));
          ocrPagesDone++;
          if (r.words && r.uncertainWords / r.words > 0.3) warnings.push({ code: 'ocr_low_confidence', message: `OCR on page ${p} has many low-confidence words; verify against the original.` });
          page.cleanup();
        } catch (e) {
          warnings.push({ code: 'ocr_failed', message: `OCR failed on page ${p}: ${(e as Error).message}` });
        }
      }
      if (confs.length) ocrConfidence = confs.reduce((a, b) => a + b, 0) / confs.length;
      if (needOcr.length > limits.ocrMaxPages) warnings.push({ code: 'ocr_truncated', message: `OCR limited to ${limits.ocrMaxPages} pages.` });
    } else if (needOcr.length) {
      warnings.push({ code: 'ocr_required', message: `${needOcr.length} page(s) contain no extractable text and need OCR.` });
    }
    const status: ExtractionResult['status'] = segments.length === 0
      ? needOcr.length ? 'ocr_required' : 'empty'
      : needOcr.length > ocrPagesDone || warnings.some((w) => w.code.endsWith('truncated')) ? 'partial' : 'indexed';
    return {
      kind: 'pdf',
      status,
      segments,
      metadata: {
        title: typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : undefined,
        author: typeof info.Author === 'string' && info.Author.trim() ? info.Author.trim() : undefined,
        createdAt: pdfDate(info.CreationDate),
        modifiedAt: pdfDate(info.ModDate),
        pageCount,
      },
      warnings,
      ocrConfidence,
    };
  } finally {
    await task.destroy();
  }
}
