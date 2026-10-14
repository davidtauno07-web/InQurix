import { parse } from 'node-html-parser';
import type { ExtractionResult } from '../types.js';
import type { ProcessingLimits } from '../limits.js';
import { decodeText, rowsToSegments, segmentProse } from './text.js';

/** Convert HTML to text without executing scripts or loading remote resources. */
export function htmlToText(html: string): { text: string; title?: string; tables: string[][][] } {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false, template: false } });
  root.querySelectorAll('script,style,noscript,template,iframe,object,embed,svg').forEach((n) => n.remove());
  const title = root.querySelector('title')?.text.trim() || undefined;
  const tables: string[][][] = [];
  root.querySelectorAll('table').forEach((t) => {
    const rows = t.querySelectorAll('tr').map((tr) => tr.querySelectorAll('th,td').map((c) => c.text.replace(/\s+/g, ' ').trim()));
    if (rows.length) tables.push(rows);
    t.remove();
  });
  root.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  const blocks = root.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,section,article,blockquote,pre,td,th,tr');
  blocks.forEach((b) => b.insertAdjacentHTML('afterend', '\n\n'));
  const body = root.querySelector('body') ?? root;
  const text = body.text.replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return { text, title, tables };
}

export function extractHtml(buf: Uint8Array, limits: ProcessingLimits): ExtractionResult {
  const { text, title, tables } = htmlToText(decodeText(buf));
  const segments = segmentProse(text, limits, 'html');
  for (const [i, t] of tables.entries()) segments.push(...rowsToSegments(t, limits, 'html', `Table ${i + 1}`, segments.length));
  return { kind: 'html', status: segments.length ? 'indexed' : 'empty', segments, metadata: { title }, warnings: [] };
}
