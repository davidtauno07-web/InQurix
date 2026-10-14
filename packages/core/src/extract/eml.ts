import { simpleParser, type AddressObject } from 'mailparser';
import type { ExtractedSegment, ExtractionResult } from '../types.js';
import type { ProcessingLimits } from '../limits.js';
import { segmentProse } from './text.js';
import { htmlToText } from './html.js';

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  return list.flatMap((x) => x.value.map((v) => (v.name ? `${v.name} <${v.address}>` : v.address ?? ''))).filter(Boolean);
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

/** RFC 822 email: header segment, body paragraphs, and attachments returned for child processing. */
export async function extractEml(buf: Uint8Array, limits: ProcessingLimits): Promise<{ result: ExtractionResult; attachments: EmailAttachment[] }> {
  const mail = await simpleParser(Buffer.from(buf), { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const from = addresses(mail.from)[0];
  const to = addresses(mail.to);
  const cc = addresses(mail.cc);
  const date = mail.date ? mail.date.toISOString() : undefined;
  const messageId = mail.messageId ?? undefined;
  const header = [`From: ${from ?? ''}`, `To: ${to.join(', ')}`, cc.length ? `Cc: ${cc.join(', ')}` : '', `Date: ${date ?? ''}`, `Subject: ${mail.subject ?? ''}`].filter(Boolean).join('\n');
  const segments: ExtractedSegment[] = [{ ordinal: 0, kind: 'email_header', text: header, method: 'email', location: { messageId, section: 'Header' } }];
  const body = mail.text ?? (mail.html ? htmlToText(mail.html).text : '');
  for (const s of segmentProse(body, limits, 'email', { messageId, section: 'Body' }, 1)) segments.push({ ...s, kind: 'email_body' });
  const attachments = (mail.attachments ?? [])
    .filter((a) => a.contentDisposition !== 'inline' || a.filename)
    .map((a) => ({ filename: (a.filename ?? 'attachment').replace(/[\\/]/g, '_'), contentType: a.contentType, content: new Uint8Array(a.content) }));
  return {
    result: {
      kind: 'eml',
      status: 'indexed',
      segments,
      metadata: { title: mail.subject ?? undefined, author: from, createdAt: date, email: { from, to, cc, subject: mail.subject ?? undefined, date, messageId, attachments: attachments.map((a) => ({ filename: a.filename, size: a.content.length, contentType: a.contentType })) } },
      warnings: [],
    },
    attachments,
  };
}
