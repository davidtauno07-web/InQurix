import { Router, type Request } from 'express';
import express from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { extractDocument } from '@inqurix/core';
import { prisma } from './db.js';
import { HttpError, ah, param, parse } from './http.js';
import { requireAuth } from './auth.js';
import { requireMember } from './orgs.js';
import { audit } from './audit.js';
import { PLANS } from './plans.js';

const MAX_UPLOAD = 50 * 1024 * 1024;

/** Sources a user may read: in an organisation they belong to AND open to all members, created by them, or granted to them. */
export async function readableSourceIds(userId: string, orgId?: string): Promise<string[]> {
  const rows = await prisma.source.findMany({
    where: {
      ...(orgId ? { orgId } : {}),
      org: { members: { some: { userId } } },
      OR: [{ allMembers: true }, { createdById: userId }, { grants: { some: { userId } } }],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Evaluated on every request, so revoked access stops working immediately. */
export async function sourceAccess(req: Request, sourceId: string) {
  const userId = req.auth!.user.id;
  const source = await prisma.source.findUnique({ where: { id: sourceId }, include: { grants: { where: { userId } }, org: { include: { members: { where: { userId } } } } } });
  const membership = source?.org.members[0];
  if (!source || !membership) throw new HttpError(404, 'Not found', 'not_found');
  const grant = source.grants[0];
  const manage = membership.role === 'owner' || membership.role === 'admin';
  const read = source.allMembers || source.createdById === userId || !!grant;
  const exportable = read && (manage || source.createdById === userId || !!grant?.canExport);
  const upload = read && membership.role !== 'viewer' && (manage || source.createdById === userId || source.allMembers || !!grant?.canUpload);
  return { source, role: membership.role, read, manage, exportable, upload };
}

async function readableDocument(req: Request, id: string) {
  const doc = await prisma.document.findUnique({ where: { id }, select: { id: true, sourceId: true, name: true, kind: true, mime: true, size: true, createdAt: true, uploadedById: true } });
  if (!doc) throw new HttpError(404, 'Not found', 'not_found');
  const access = await sourceAccess(req, doc.sourceId);
  if (!access.read) throw new HttpError(404, 'Not found', 'not_found');
  return { doc, access };
}

export const sourcesRouter = Router();
sourcesRouter.use(requireAuth);

sourcesRouter.post('/orgs/:orgId/sources', ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  const me = await requireMember(req, orgId, ['owner', 'admin']);
  const plan = PLANS[me.org.plan];
  if (!plan.features.companyWorkspace) throw new HttpError(402, 'Shared company sources need the Business plan', 'plan_required');
  if ((await prisma.source.count({ where: { orgId } })) >= plan.features.sharedSources) throw new HttpError(402, 'Shared source limit reached for this plan', 'limit_reached');
  const b = parse(z.object({ name: z.string().trim().min(1).max(120), allMembers: z.boolean().default(false) }), req.body);
  const s = await prisma.source.create({ data: { orgId, name: b.name, allMembers: b.allMembers, createdById: req.auth!.user.id } });
  await audit('source.create', { orgId, userId: req.auth!.user.id, target: s.id, meta: { allMembers: b.allMembers }, ip: req.ip });
  res.status(201).json(s);
}));

sourcesRouter.get('/orgs/:orgId/sources', ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  const me = await requireMember(req, orgId);
  const readable = new Set(await readableSourceIds(req.auth!.user.id, orgId));
  const manage = me.role === 'owner' || me.role === 'admin';
  const sources = await prisma.source.findMany({ where: { orgId }, include: { _count: { select: { documents: true } }, grants: { include: { user: true } } }, orderBy: { createdAt: 'asc' } });
  res.json(sources.filter((s) => manage || readable.has(s.id)).map((s) => ({
    id: s.id, name: s.name, allMembers: s.allMembers, documents: s._count.documents, canRead: readable.has(s.id),
    grants: manage ? s.grants.map((g) => ({ userId: g.userId, name: g.user.name, email: g.user.email, canExport: g.canExport, canUpload: g.canUpload })) : undefined,
  })));
}));

sourcesRouter.patch('/sources/:sourceId', ah(async (req, res) => {
  const a = await sourceAccess(req, param(req, 'sourceId'));
  if (!a.manage) throw new HttpError(403, 'Only owners and admins can change source settings', 'forbidden');
  const b = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), allMembers: z.boolean().optional() }), req.body);
  await prisma.source.update({ where: { id: a.source.id }, data: b });
  await audit('source.update', { orgId: a.source.orgId, userId: req.auth!.user.id, target: a.source.id, meta: b, ip: req.ip });
  res.json({ ok: true });
}));

sourcesRouter.put('/sources/:sourceId/grants/:userId', ah(async (req, res) => {
  const a = await sourceAccess(req, param(req, 'sourceId'));
  const userId = param(req, 'userId');
  if (!a.manage) throw new HttpError(403, 'Only owners and admins can share sources', 'forbidden');
  const b = parse(z.object({ canExport: z.boolean().default(false), canUpload: z.boolean().default(false) }), req.body ?? {});
  if (!(await prisma.membership.findUnique({ where: { orgId_userId: { orgId: a.source.orgId, userId } } }))) throw new HttpError(400, 'Only members of this organisation can be given access', 'not_member');
  await prisma.sourceGrant.upsert({ where: { sourceId_userId: { sourceId: a.source.id, userId } }, create: { sourceId: a.source.id, userId, canExport: b.canExport, canUpload: b.canUpload }, update: { canExport: b.canExport, canUpload: b.canUpload } });
  await audit('source.grant', { orgId: a.source.orgId, userId: req.auth!.user.id, target: `${a.source.id}:${userId}`, meta: b, ip: req.ip });
  res.json({ ok: true });
}));

sourcesRouter.delete('/sources/:sourceId/grants/:userId', ah(async (req, res) => {
  const a = await sourceAccess(req, param(req, 'sourceId'));
  const userId = param(req, 'userId');
  if (!a.manage) throw new HttpError(403, 'Only owners and admins can revoke access', 'forbidden');
  await prisma.sourceGrant.deleteMany({ where: { sourceId: a.source.id, userId } });
  await audit('source.revoke', { orgId: a.source.orgId, userId: req.auth!.user.id, target: `${a.source.id}:${userId}`, ip: req.ip });
  res.json({ ok: true });
}));

sourcesRouter.delete('/sources/:sourceId', ah(async (req, res) => {
  const a = await sourceAccess(req, param(req, 'sourceId'));
  if (!a.manage) throw new HttpError(403, 'Only owners and admins can delete sources', 'forbidden');
  await prisma.source.delete({ where: { id: a.source.id } });
  await audit('source.delete', { orgId: a.source.orgId, userId: req.auth!.user.id, target: a.source.id, ip: req.ip });
  res.json({ ok: true });
}));

sourcesRouter.post('/sources/:sourceId/documents', express.raw({ type: '*/*', limit: MAX_UPLOAD }), ah(async (req, res) => {
  const a = await sourceAccess(req, param(req, 'sourceId'));
  if (!a.upload) throw new HttpError(403, 'You cannot add documents to this source', 'forbidden');
  const name = decodeURIComponent(String(req.get('x-file-name') ?? '')).replace(/[/\\]/g, '_').slice(0, 255);
  const buf = req.body as Buffer;
  if (!name || !Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, 'Send the file as the request body with an X-File-Name header', 'invalid_request');
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const dupe = await prisma.document.findUnique({ where: { sourceId_sha256: { sourceId: a.source.id, sha256 } } });
  if (dupe) return res.json({ id: dupe.id, duplicate: true });
  const { identification, result } = await extractDocument(new Uint8Array(buf), name);
  if (identification.dangerous) throw new HttpError(415, identification.reason ?? 'This file type is not accepted', 'dangerous_file');
  if (identification.kind === 'unknown') throw new HttpError(415, 'This file type is not supported', 'unsupported');
  const doc = await prisma.document.create({
    data: {
      sourceId: a.source.id, name, kind: identification.kind, mime: identification.mime, sha256, size: buf.length, content: new Uint8Array(buf), uploadedById: req.auth!.user.id,
      segments: { create: result.segments.map((s) => ({ ord: s.ordinal, kind: s.kind, location: s.location as unknown as Prisma.InputJsonValue, text: s.text.slice(0, 100_000) })) },
    },
  });
  await audit('document.upload', { orgId: a.source.orgId, userId: req.auth!.user.id, target: doc.id, meta: { name, status: result.status }, ip: req.ip });
  res.status(201).json({ id: doc.id, status: result.status, segments: result.segments.length, warnings: result.warnings });
}));

interface Hit { segmentId: string; documentId: string; name: string; sourceId: string; ord: number; location: unknown; snippet: string; rank: number }

function snippetParts(s: string) {
  return s.split(/(⟦[^⟧]*⟧)/).filter(Boolean).map((p) => (p.startsWith('⟦') ? { text: p.slice(1, -1), hit: true } : { text: p, hit: false }));
}

/** Company search: only segments in sources the caller can read are ever queried. */
sourcesRouter.get('/search', ah(async (req, res) => {
  const q = parse(z.object({ q: z.string().trim().min(1).max(300), orgId: z.string().regex(/^[a-z0-9]{10,40}$/i).optional() }), req.query);
  const ids = await readableSourceIds(req.auth!.user.id, q.orgId);
  if (ids.length === 0) return res.json({ results: [] });
  const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const hits = await prisma.$queryRaw<Hit[]>`
    SELECT s.id AS "segmentId", d.id AS "documentId", d.name, d."sourceId", s.ord, s.location,
      ts_headline('simple', s.text, websearch_to_tsquery('simple', ${q.q}), 'StartSel=⟦,StopSel=⟧,MaxWords=35,MinWords=12,MaxFragments=2') AS snippet,
      (ts_rank(to_tsvector('simple', s.text), websearch_to_tsquery('simple', ${q.q})) + CASE WHEN s.text ILIKE ${like} THEN 1 ELSE 0 END)::float AS rank
    FROM "Segment" s JOIN "Document" d ON d.id = s."documentId"
    WHERE d."sourceId" = ANY(${ids}::text[])
      AND (to_tsvector('simple', s.text) @@ websearch_to_tsquery('simple', ${q.q}) OR s.text ILIKE ${like})
    ORDER BY rank DESC, d."createdAt" DESC
    LIMIT 100`;
  const byDoc = new Map<string, Hit & { matches: number }>();
  for (const h of hits) {
    const prev = byDoc.get(h.documentId);
    if (prev) prev.matches++;
    else byDoc.set(h.documentId, { ...h, matches: 1 });
  }
  res.json({ results: [...byDoc.values()].slice(0, 30).map((h) => ({ documentId: h.documentId, name: h.name, sourceId: h.sourceId, location: h.location, segment: h.ord, matches: h.matches, snippet: snippetParts(h.snippet) })) });
}));

sourcesRouter.get('/documents/:id', ah(async (req, res) => {
  const { doc, access } = await readableDocument(req, param(req, 'id'));
  const segments = await prisma.segment.findMany({ where: { documentId: doc.id }, orderBy: { ord: 'asc' }, select: { ord: true, kind: true, location: true, text: true } });
  await audit('document.preview', { orgId: access.source.orgId, userId: req.auth!.user.id, target: doc.id, ip: req.ip });
  res.json({ ...doc, canExport: access.exportable, segments });
}));

sourcesRouter.get('/documents/:id/download', ah(async (req, res) => {
  const { doc, access } = await readableDocument(req, param(req, 'id'));
  if (!access.exportable) throw new HttpError(403, 'You can view this document but not download it', 'forbidden');
  const full = await prisma.document.findUniqueOrThrow({ where: { id: doc.id }, select: { content: true } });
  await audit('document.export', { orgId: access.source.orgId, userId: req.auth!.user.id, target: doc.id, ip: req.ip });
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.send(Buffer.from(full.content));
}));

sourcesRouter.delete('/documents/:id', ah(async (req, res) => {
  const { doc, access } = await readableDocument(req, param(req, 'id'));
  if (!access.manage && doc.uploadedById !== req.auth!.user.id) throw new HttpError(403, 'Only the uploader or an admin can remove this document', 'forbidden');
  await prisma.document.delete({ where: { id: doc.id } });
  await audit('document.delete', { orgId: access.source.orgId, userId: req.auth!.user.id, target: doc.id, ip: req.ip });
  res.json({ ok: true });
}));
