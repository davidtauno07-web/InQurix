import type { FileKind } from './types.js';

/**
 * Identify a file's real format from its leading bytes (magic numbers), using
 * the extension only to disambiguate containers (e.g. ZIP-based OOXML) and
 * plain-text families. Documents are untrusted input: callers must check
 * `dangerous` and `kind === 'unknown'` before handing bytes to an extractor.
 */
export interface Identification {
  kind: FileKind;
  mime: string;
  /** Extension claims one format but the content is another. */
  mismatch: boolean;
  /** Executables, scripts and macro-enabled formats are never parsed. */
  dangerous: boolean;
  reason?: string;
}

const TEXT_EXT: Record<string, FileKind> = {
  txt: 'txt',
  md: 'txt',
  log: 'txt',
  csv: 'csv',
  tsv: 'csv',
  htm: 'html',
  html: 'html',
  rtf: 'rtf',
  eml: 'eml',
};

const DANGEROUS_EXT = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'msi', 'scr', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'sh', 'app', 'dmg', 'pkg',
  'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm', 'jar', 'lnk',
]);

const MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  rtf: 'application/rtf',
  html: 'text/html',
  eml: 'message/rfc822',
  image: 'image/*',
  zip: 'application/zip',
  unknown: 'application/octet-stream',
};

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

function startsWith(buf: Uint8Array, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[offset + i] !== sig[i]) return false;
  return true;
}

function looksLikeText(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return true;
  // UTF-16 BOM
  if (startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) return true;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / n < 0.02;
}

/**
 * @param head first bytes of the file (>= 8 KB recommended)
 * @param name file name (for extension disambiguation)
 * @param zipEntries optional list of entry names when the file is a ZIP (lets us tell DOCX/XLSX/PPTX apart without trusting the extension)
 */
export function identify(head: Uint8Array, name: string, zipEntries?: string[]): Identification {
  const ext = extensionOf(name);
  const mk = (kind: FileKind, extra: Partial<Identification> = {}): Identification => {
    const expected = ext ? extToKind(ext) : undefined;
    const mismatch = expected !== undefined && expected !== kind && !(expected === 'txt' && (kind === 'csv' || kind === 'html'));
    return { kind, mime: MIME[kind], mismatch, dangerous: false, ...extra };
  };

  if (DANGEROUS_EXT.has(ext)) {
    return { kind: 'unknown', mime: MIME.unknown, mismatch: false, dangerous: true, reason: `.${ext} files may contain executable or macro content and are never processed` };
  }
  // Executables disguised with a document extension
  if (startsWith(head, [0x4d, 0x5a]) || startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(head, [0xfe, 0xed, 0xfa, 0xcf])) {
    return { kind: 'unknown', mime: MIME.unknown, mismatch: true, dangerous: true, reason: 'File content is an executable program' };
  }
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return mk('pdf');
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    if (zipEntries) {
      if (zipEntries.some((e) => /vbaProject\.bin$/i.test(e))) {
        return { kind: 'unknown', mime: MIME.unknown, mismatch: false, dangerous: true, reason: 'Document contains macros (vbaProject.bin); macros are never executed or parsed' };
      }
      if (zipEntries.includes('word/document.xml')) return mk('docx');
      if (zipEntries.includes('xl/workbook.xml')) return mk('xlsx');
      if (zipEntries.includes('ppt/presentation.xml')) return mk('pptx');
      return mk('zip');
    }
    const byExt = extToKind(ext);
    if (byExt === 'docx' || byExt === 'xlsx' || byExt === 'pptx') return mk(byExt);
    return mk('zip');
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // Legacy OLE compound file: .doc / .xls / encrypted OOXML
    const byExt = extToKind(ext);
    if (byExt === 'xls') return mk('xls');
    if (byExt === 'doc') return mk('doc');
    if (byExt === 'docx' || byExt === 'xlsx' || byExt === 'pptx') {
      return { kind: byExt, mime: MIME[byExt], mismatch: false, dangerous: false, reason: 'encrypted' };
    }
    return mk('doc');
  }
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47]) || startsWith(head, [0xff, 0xd8, 0xff]) || startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]) || startsWith(head, [0x42, 0x4d])) {
    return mk('image');
  }
  if (startsWith(head, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return mk('rtf');
  if (looksLikeText(head)) {
    const textKind = TEXT_EXT[ext];
    const sample = new TextDecoder('utf-8', { fatal: false }).decode(head.slice(0, 2048)).trimStart().toLowerCase();
    if (textKind === 'rtf' && !sample.startsWith('{\\rtf')) return mk('txt');
    if (textKind) return mk(textKind);
    if (sample.startsWith('<!doctype html') || sample.startsWith('<html')) return mk('html');
    if (/^(received|from|return-path|message-id|mime-version|date|subject):/im.test(sample) && /\n(from|subject):/i.test(sample)) return mk('eml');
    if (!ext || ext === 'text') return mk('txt');
    return { kind: 'unknown', mime: MIME.unknown, mismatch: false, dangerous: false, reason: `Unsupported text format .${ext}` };
  }
  return { kind: 'unknown', mime: MIME.unknown, mismatch: false, dangerous: false, reason: ext ? `Unsupported format .${ext}` : 'Unrecognised binary format' };
}

export function extToKind(ext: string): FileKind | undefined {
  switch (ext) {
    case 'pdf': return 'pdf';
    case 'docx': return 'docx';
    case 'doc': return 'doc';
    case 'xlsx': return 'xlsx';
    case 'xls': return 'xls';
    case 'pptx': return 'pptx';
    case 'png': case 'jpg': case 'jpeg': case 'tif': case 'tiff': case 'bmp': return 'image';
    case 'zip': return 'zip';
    default: return TEXT_EXT[ext];
  }
}

export const SUPPORTED_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'log', 'csv', 'tsv', 'rtf', 'htm', 'html', 'eml', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp'];
