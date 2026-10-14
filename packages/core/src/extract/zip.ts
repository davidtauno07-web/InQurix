import { LimitExceededError, type ProcessingLimits } from '../limits.js';

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
}

/**
 * Read the ZIP central directory without inflating anything, so archive
 * bombs, path traversal names and encrypted entries can be rejected before
 * any decompression happens.
 */
export function inspectZip(buf: Uint8Array): ZipEntryInfo[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Corrupted ZIP container: end of central directory not found');
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const entries: ZipEntryInfo[] = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || view.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupted ZIP container: bad central directory');
    const flags = view.getUint16(p + 8, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, compressedSize, uncompressedSize, encrypted: (flags & 1) === 1 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function assertSafeZip(entries: ZipEntryInfo[], limits: ProcessingLimits): void {
  if (entries.length > limits.maxZipEntries) throw new LimitExceededError('zip_entries', `Archive has ${entries.length} entries (limit ${limits.maxZipEntries})`);
  let total = 0;
  for (const e of entries) {
    if (e.name.includes('..') || e.name.startsWith('/') || /^[a-zA-Z]:/.test(e.name) || e.name.includes('\\')) {
      throw new LimitExceededError('zip_path', `Archive entry has an unsafe path: ${e.name.slice(0, 80)}`);
    }
    total += e.uncompressedSize;
    if (e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > limits.maxCompressionRatio && e.uncompressedSize > 1_000_000) {
      throw new LimitExceededError('zip_ratio', `Archive entry ${e.name} has a suspicious compression ratio`);
    }
  }
  if (total > limits.maxUncompressedBytes) throw new LimitExceededError('zip_size', `Archive expands to ${Math.round(total / 1e6)} MB (limit ${Math.round(limits.maxUncompressedBytes / 1e6)} MB)`);
}
