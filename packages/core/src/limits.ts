/** Resource limits applied to untrusted documents. All are configurable by callers. */
export interface ProcessingLimits {
  maxFileBytes: number;
  maxZipEntries: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
  maxPdfPages: number;
  maxSheetRows: number;
  maxSegments: number;
  maxSegmentChars: number;
  timeoutMs: number;
  ocr: boolean;
  ocrMaxPages: number;
}

export const DEFAULT_LIMITS: ProcessingLimits = {
  maxFileBytes: 200 * 1024 * 1024,
  maxZipEntries: 5000,
  maxUncompressedBytes: 500 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPdfPages: 2000,
  maxSheetRows: 200_000,
  maxSegments: 200_000,
  maxSegmentChars: 4000,
  timeoutMs: 120_000,
  ocr: true,
  ocrMaxPages: 50,
};

export class LimitExceededError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'LimitExceededError';
  }
}

export class EncryptedDocumentError extends Error {
  constructor(message = 'Document is password protected or encrypted') {
    super(message);
    this.name = 'EncryptedDocumentError';
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new LimitExceededError('timeout', `${what} exceeded ${Math.round(ms / 1000)}s processing limit`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
