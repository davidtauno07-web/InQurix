const HL_START = '\u0002';
const HL_END = '\u0003';

/** Renders engine snippets with highlight markers as React text nodes (never as HTML). */
export function Snippet({ text }: { text: string }) {
  const parts: { t: string; hl: boolean }[] = [];
  let hl = false;
  let buf = '';
  for (const ch of text) {
    if (ch === HL_START || ch === HL_END) { if (buf) parts.push({ t: buf, hl }); buf = ''; hl = ch === HL_START; }
    else buf += ch;
  }
  if (buf) parts.push({ t: buf, hl });
  return <span className="snippet">{parts.map((p, i) => (p.hl ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>))}</span>;
}

export interface Loc { page?: number; pageCount?: number; sheet?: string; row?: number; cell?: string; slide?: number; section?: string; heading?: string; paragraph?: number; line?: number; part?: string; attachment?: string }

export function describeLocation(l: Loc): string {
  const bits: string[] = [];
  if (l.attachment) bits.push(`attachment ${l.attachment}`);
  if (l.page) bits.push(`page ${l.page}${l.pageCount ? ` of ${l.pageCount}` : ''}`);
  if (l.sheet) bits.push(`sheet “${l.sheet}”`);
  if (l.row) bits.push(`row ${l.row}`);
  if (l.cell) bits.push(`cell ${l.cell}`);
  if (l.slide) bits.push(`slide ${l.slide}`);
  if (l.heading) bits.push(`under “${l.heading}”`);
  else if (l.section) bits.push(`section “${l.section}”`);
  if (l.paragraph && !l.page) bits.push(`paragraph ${l.paragraph}`);
  if (l.line && !l.row) bits.push(`line ${l.line}`);
  if (l.part) bits.push(l.part);
  return bits.join(', ');
}
