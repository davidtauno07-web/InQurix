import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { Prisma } from '@prisma/client';
import { extractDocument } from '@inqurix/core';
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from './db.js';

/** Demo company with four roles and two sources (one restricted). Safe to re-run. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const password = process.env.SEED_PASSWORD ?? randomBytes(9).toString('base64url');
const people = [
  ['owner@demo.inqurix.local', 'Nangula Owner', 'owner'],
  ['admin@demo.inqurix.local', 'Tjeripo Admin', 'admin'],
  ['finance@demo.inqurix.local', 'Selma Finance', 'member'],
  ['viewer@demo.inqurix.local', 'Johan Viewer', 'viewer'],
] as const;

const passwordHash = await hash(password);
let org = await prisma.organization.findFirst({ where: { name: 'Kavango Demo Trading' } });
org ??= await prisma.organization.create({ data: { name: 'Kavango Demo Trading', plan: 'business', seats: 10 } });
const ids: Record<string, string> = {};
for (const [email, name, role] of people) {
  const u = await prisma.user.upsert({ where: { email }, create: { email, name, passwordHash, emailVerifiedAt: new Date() }, update: { passwordHash } });
  ids[role] = u.id;
  await prisma.membership.upsert({ where: { orgId_userId: { orgId: org.id, userId: u.id } }, create: { orgId: org.id, userId: u.id, role }, update: { role } });
}
const finance = await prisma.source.findFirst({ where: { orgId: org.id, name: 'Finance (restricted)' } }) ?? await prisma.source.create({ data: { orgId: org.id, name: 'Finance (restricted)', createdById: ids.owner! } });
await prisma.sourceGrant.upsert({ where: { sourceId_userId: { sourceId: finance.id, userId: ids.member! } }, create: { sourceId: finance.id, userId: ids.member!, canExport: true }, update: {} });
if (!(await prisma.source.findFirst({ where: { orgId: org.id, name: 'Company policies' } }))) await prisma.source.create({ data: { orgId: org.id, name: 'Company policies', allMembers: true, createdById: ids.owner! } });
if (!(await prisma.creditEntry.findFirst({ where: { orgId: org.id } }))) await prisma.creditEntry.create({ data: { orgId: org.id, delta: 2000, balanceAfter: 2000, reason: 'Demo starting credits', idempotencyKey: `seed:${org.id}` } });

const dir = path.join(root, 'fixtures/out');
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir)) {
    if (!fs.statSync(path.join(dir, f)).isFile()) continue;
    const buf = fs.readFileSync(path.join(dir, f));
    const sha256 = createHash('sha256').update(buf).digest('hex');
    if (await prisma.document.findUnique({ where: { sourceId_sha256: { sourceId: finance.id, sha256 } } })) continue;
    const { identification, result } = await extractDocument(new Uint8Array(buf), f);
    if (identification.dangerous || identification.kind === 'unknown') continue;
    await prisma.document.create({ data: { sourceId: finance.id, name: f, kind: identification.kind, mime: identification.mime, sha256, size: buf.length, content: new Uint8Array(buf), uploadedById: ids.owner!, segments: { create: result.segments.map((s) => ({ ord: s.ordinal, kind: s.kind, location: s.location as unknown as Prisma.InputJsonValue, text: s.text })) } } });
  }
}
console.log(`Seeded "${org.name}". Users: ${people.map((p) => p[0]).join(', ')}`);
if (!process.env.SEED_PASSWORD) console.log(`Generated password for all demo users (shown once): ${password}`);
await prisma.$disconnect();
