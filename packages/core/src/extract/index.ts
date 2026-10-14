import type { ExtractionResult } from '../types.js';
import { identify, type Identification } from '../identify.js';
import { DEFAULT_LIMITS, EncryptedDocumentError, LimitExceededError, withTimeout, type ProcessingLimits } from '../limits.js';
import { extractCsv, extractPlainText } from './text.js';
import { extractRtf } from './rtf.js';
import { extractHtml } from './html.js';
import { extractDocx, extractPptx, extractXlsx } from './ooxml.js';
import { extractPdf } from './pdf.js';
import { extractEml } from './eml.js';
import { inspectZip } from './zip.js';
import { ocrImage, ocrSegments, type OcrOptions } from './ocr.js';

export interface ExtractOptions {
  limits?: ProcessingLimits;
  ocr?: OcrOptions;
  /** Internal: attachment nesting depth. */
  depth?: number;
}

export interface ExtractOutcome {
  identification: Identification;
  result: ExtractionResult;
}

function fail(kind: ExtractionResult['kind'], status: ExtractionResult['status'], code: string, message: string): ExtractionResult {
  return { kind, status, segments: [], metadata: {}, warnings: [{ code, message }] };
}

/**
 * Identify and extract a document. Never executes document content; every
 * failure is reported as a status rather than thrown so indexing can continue.
 */
export async function extractDocument(buf: Uint8Array, name: string, opts: ExtractOptions = {}): Promise<ExtractOutcome> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const head = buf.subarray(0, 4096);
  let zipEntries: string[] | undefined;
  if (head[0] === 0x50 && head[1] === 0x4b) {
    try { zipEntries = inspectZip(buf).map((e) => e.name); } catch { zipEntries = []; }
  }
  const identification = identify(head, name, zipEntries);
  const kind = identification.kind;
  if (buf.length > limits.maxFileBytes) return { identification, result: fail(kind, 'unsupported', 'too_large', `File exceeds the ${Math.round(limits.maxFileBytes / 1e6)} MB processing limit.`) };
  if (identification.dangerous) return { identification, result: fail(kind, 'unsupported', 'dangerous', identification.reason ?? 'File type is not processed for safety reasons.') };
  try {
    const run = async (): Promise<ExtractionResult> => {
      switch (kind) {
        case 'txt': return extractPlainText(buf, limits);
        case 'csv': return extractCsv(buf, limits);
        case 'rtf': return extractRtf(buf, limits);
        case 'html': return extractHtml(buf, limits);
        case 'docx': return extractDocx(buf, limits);
        case 'xlsx': return extractXlsx(buf, limits);
        case 'pptx': return extractPptx(buf, limits);
        case 'pdf': return extractPdf(buf, limits, { ocr: opts.ocr });
        case 'image': {
          if (!limits.ocr || !opts.ocr) return fail('image', 'ocr_required', 'ocr_required', 'Image needs OCR, which is disabled.');
          const r = await ocrImage(buf, opts.ocr);
          const segments = ocrSegments(r.text, r.confidence, undefined, 0);
          return { kind: 'image', status: segments.length ? 'indexed' : 'empty', segments, metadata: {}, warnings: r.words && r.uncertainWords / r.words > 0.3 ? [{ code: 'ocr_low_confidence', message: 'Many OCR words have low confidence; verify against the original.' }] : [], ocrConfidence: r.confidence };
        }
        case 'eml': {
          const { result, attachments } = await extractEml(buf, limits);
          if ((opts.depth ?? 0) < 1) {
            result.children = [];
            for (const a of attachments.slice(0, 20)) {
              const child = await extractDocument(a.content, a.filename, { ...opts, depth: (opts.depth ?? 0) + 1 });
              result.children.push({ name: a.filename, result: child.result });
            }
          }
          return result;
        }
        case 'doc':
        case 'xls':
          return fail(kind, 'unsupported', 'legacy_binary', 'Legacy binary Office format (.doc/.xls) is not supported; save as .docx/.xlsx.');
        case 'zip':
          return fail(kind, 'unsupported', 'archive', 'Archives are not expanded for indexing.');
        default:
          return fail(kind, 'unsupported', 'unsupported', 'Unsupported or unrecognised file type.');
      }
    };
    const result = await withTimeout(run(), limits.timeoutMs, `Extracting ${name}`);
    if (identification.mismatch) result.warnings.push({ code: 'extension_mismatch', message: `Content is ${identification.mime}, which does not match the file extension.` });
    return { identification, result };
  } catch (e) {
    if (e instanceof EncryptedDocumentError) return { identification, result: fail(kind, 'encrypted', 'encrypted', e.message) };
    if (e instanceof LimitExceededError) return { identification, result: fail(kind, 'failed', 'limit_exceeded', e.message) };
    return { identification, result: fail(kind, 'failed', 'extract_error', `Could not read file: ${(e as Error).message}`) };
  }
}

export { extractPdf, extractEml, extractDocx, extractXlsx, extractPptx, extractCsv, extractPlainText, extractRtf, extractHtml };
export { inspectZip, assertSafeZip } from './zip.js';
export { ocrImage, terminateOcr } from './ocr.js';
export type { OcrOptions } from './ocr.js';
