import nodemailer from 'nodemailer';
import { config } from './config.js';
import { log } from './log.js';

export interface Mail { to: string; subject: string; text: string }

/** Messages sent while no SMTP server is configured (development and tests only). */
export const outbox: Mail[] = [];

/** Links in dev emails are printed only for a development server on this machine, never on a shared host. */
const printLinks = config.NODE_ENV === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.APP_URL).hostname);

const transport = config.SMTP_URL ? nodemailer.createTransport(config.SMTP_URL) : undefined;

export async function sendMail(m: Mail): Promise<void> {
  if (transport) {
    await transport.sendMail({ from: config.MAIL_FROM, ...m });
    return;
  }
  if (config.NODE_ENV === 'production') throw new Error('SMTP_URL is required in production');
  outbox.push(m);
  if (outbox.length > 100) outbox.shift();
  log.info({ to: m.to, subject: m.subject }, 'SMTP not configured; email kept in the development outbox');
  if (printLinks) console.log(`\n--- Email to ${m.to}: ${m.subject} ---\n${m.text}\n---\n`);
}
