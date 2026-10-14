import fs from 'node:fs';
import path from 'node:path';
import type { ExtractedSegment } from '../types.js';
import { normalizeText } from '../normalize.js';

export interface OcrOptions {
  /** Directory containing eng.traineddata(.gz). Required for offline OCR. */
  langPath?: string;
  cachePath?: string;
  lang?: string;
  /** Words below this confidence (0..100) are reported as uncertain. */
  minWordConfidence?: number;
}

export interface OcrPageResult {
  text: string;
  confidence: number;
  uncertainWords: number;
  words: number;
}

type TesseractWorker = { recognize: (img: Buffer | Uint8Array) => Promise<{ data: { text: string; confidence: number; blocks?: unknown } }>; terminate: () => Promise<unknown> };

let workerPromise: Promise<TesseractWorker> | undefined;
let workerKey = '';

async function getWorker(opts: OcrOptions): Promise<TesseractWorker> {
  const key = `${opts.langPath}|${opts.lang}`;
  if (!workerPromise || key !== workerKey) {
    workerKey = key;
    const { createWorker } = await import('tesseract.js');
    workerPromise = createWorker(opts.lang ?? 'eng', 1, {
      ...(opts.langPath ? { langPath: opts.langPath } : {}),
      ...(opts.cachePath ? { cachePath: opts.cachePath } : {}),
      gzip: opts.langPath ? fs.existsSync(path.join(opts.langPath, `${opts.lang ?? 'eng'}.traineddata.gz`)) : true,
      logger: () => undefined,
    }) as unknown as Promise<TesseractWorker>;
  }
  return workerPromise;
}

export async function terminateOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise.catch(() => undefined);
    workerPromise = undefined;
    await w?.terminate();
  }
}

/** Run OCR on an image buffer (PNG/JPEG/TIFF/BMP). Runs locally; nothing leaves the machine. */
export async function ocrImage(img: Uint8Array, opts: OcrOptions = {}): Promise<OcrPageResult> {
  const worker = await getWorker(opts);
  const { data } = await worker.recognize(Buffer.from(img));
  const min = opts.minWordConfidence ?? 60;
  let words = 0;
  let uncertain = 0;
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.words)) for (const w of o.words as { confidence: number }[]) { words++; if (w.confidence < min) uncertain++; }
    for (const k of ['blocks', 'paragraphs', 'lines']) if (o[k]) walk(o[k]);
  };
  walk(data.blocks);
  return { text: data.text ?? '', confidence: (data.confidence ?? 0) / 100, uncertainWords: uncertain, words };
}

export function ocrSegments(text: string, confidence: number, page: number | undefined, startOrdinal: number): ExtractedSegment[] {
  return text
    .split(/\n\s*\n+/)
    .map((b) => normalizeText(b))
    .filter((b) => b.length > 1)
    .map((b, i) => ({ ordinal: startOrdinal + i, kind: 'ocr_block' as const, text: b, method: 'ocr' as const, confidence, location: page ? { page } : {} }));
}
