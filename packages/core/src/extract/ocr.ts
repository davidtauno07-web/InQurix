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
let loadFailure: { key: string; at: number; message: string } | undefined;
const LOAD_RETRY_MS = 5 * 60_000;

async function getWorker(opts: OcrOptions): Promise<TesseractWorker> {
  const key = `${opts.langPath}|${opts.lang}`;
  if (loadFailure?.key === key && Date.now() - loadFailure.at < LOAD_RETRY_MS) throw new Error(loadFailure.message);
  if (!workerPromise || key !== workerKey) {
    if (workerPromise) void discardWorker();
    workerKey = key;
    const lang = opts.lang ?? 'eng';
    if (opts.langPath && !/^https?:/.test(opts.langPath) && ![`${lang}.traineddata`, `${lang}.traineddata.gz`].some((f) => fs.existsSync(path.join(opts.langPath!, f)))) {
      throw new Error(`OCR language data (${lang}.traineddata) was not found in ${opts.langPath}.`);
    }
    const { createWorker } = await import('tesseract.js');
    // Language-data load errors (e.g. no internet for the first download) only reach errorHandler, so they are raced here.
    let ready = false;
    let failLoad: (e: Error) => void = () => undefined;
    const loadError = new Promise<never>((_, reject) => { failLoad = reject; });
    const created = (createWorker(lang, 1, {
      ...(opts.langPath ? { langPath: opts.langPath } : {}),
      ...(opts.cachePath ? { cachePath: opts.cachePath } : {}),
      gzip: opts.langPath && !/^https?:/.test(opts.langPath) ? fs.existsSync(path.join(opts.langPath, `${lang}.traineddata.gz`)) : true,
      logger: () => undefined,
      // Without a handler tesseract.js rethrows worker errors outside any promise, which kills the process.
      errorHandler: (e: unknown) => { if (!ready) failLoad(new Error(errorMessage(e))); },
    }) as unknown as Promise<TesseractWorker>).then((w) => { ready = true; return w; });
    loadError.catch(() => created.then((w) => w.terminate()).catch(() => undefined));
    const p: Promise<TesseractWorker> = Promise.race([created, loadError]).catch((e: unknown) => {
      const message = `OCR language data could not be loaded (the first OCR run needs internet to download it): ${errorMessage(e)}`;
      if (workerPromise === p) { workerPromise = undefined; loadFailure = { key, at: Date.now(), message }; }
      throw new Error(message);
    });
    workerPromise = p;
  }
  return workerPromise;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A worker that failed mid-job may be left in a broken state (e.g. aborted WASM), so it is replaced. */
async function discardWorker(): Promise<void> {
  const p = workerPromise;
  workerPromise = undefined;
  const w = await p?.catch(() => undefined);
  await w?.terminate().catch(() => undefined);
}

export async function terminateOcr(): Promise<void> {
  loadFailure = undefined;
  await discardWorker();
}

/** Run OCR on an image buffer (PNG/JPEG/TIFF/BMP). Runs locally; nothing leaves the machine. */
export async function ocrImage(img: Uint8Array, opts: OcrOptions = {}): Promise<OcrPageResult> {
  const worker = await getWorker(opts);
  let data: { text: string; confidence: number; blocks?: unknown };
  try {
    ({ data } = await worker.recognize(Buffer.from(img)));
  } catch (e) {
    await discardWorker();
    throw new Error(`OCR could not read this image (it may be damaged or in an unsupported format): ${errorMessage(e)}`);
  }
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
