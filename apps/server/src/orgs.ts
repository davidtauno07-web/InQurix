import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { prisma } from './db.js';
import { config } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import { HttpError, ah, param, parse } from './http.js';
import { requireAuth } from './auth.js';
import { sendMail } from './mail.js';
import { audit } from './audit.js';
import { PLANS } from './plans.js';

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Returns the caller's membership. Non-members get 404 so organisation ids are not confirmed. */
export async function requireMember(req: Request, orgId: string, roles?: Role[]) {
  const m = await prisma.membership.findUnique({ where: { orgId_userId: { orgId, userId: req.auth!.user.id } }, include: { org: true } });
  if (!m) throw new HttpError(404, 'Organisation not found', 'not_found');
  if (roles && !roles.includes(m.role)) throw new HttpError(403, 'Your role does not allow this', 'forbidden');
  return m;
}

export const orgsRouter = Router();
orgsRouter.use(requireAuth);

orgsRouter.post('/orgs', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(120) }), req.body);
  const org = await prisma.organization.create({ data: { name: b.name, members: { create: { userId: req.auth!.user.id, role: 'owner' } } } });
  await audit('org.create', { orgId: org.id, userId: req.auth!.user.id, ip: req.ip });
  res.status(201).json({ id: org.id, name: org.name, plan: org.plan });
}));

orgsRouter.get('/orgs/:orgId', ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  const me = await requireMember(req, orgId);
  const members = await prisma.membership.findMany({ where: { orgId }, include: { user: true }, orderBy: { createdAt: 'asc' } });
  const invitations = RANK[me.role] >= RANK.admin ? await prisma.invitation.findMany({ where: { orgId, acceptedAt: null, expiresAt: { gt: new Date() } } }) : [];
  res.json({
    id: me.org.id, name: me.org.name, personal: me.org.personal, plan: me.org.plan, seats: me.org.seats, role: me.role,
    members: members.map((m) => ({ userId: m.userId, name: m.user.name, email: m.user.email, role: m.role })),
    invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt })),
  });
}));

orgsRouter.post('/orgs/:orgId/invitations', ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  const me = await requireMember(req, orgId, ['owner', 'admin']);
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['admin', 'member', 'viewer']) }), req.body);
  if (me.org.personal || !PLANS[me.org.plan].features.companyWorkspace) throw new HttpError(402, 'Inviting colleagues needs the Business plan', 'plan_required');
  const [members, pending] = await Promise.all([
    prisma.membership.count({ where: { orgId } }),
    prisma.invitation.count({ where: { orgId, acceptedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  if (members + pending >= me.org.seats) throw new HttpError(402, `All ${me.org.seats} seats are in use. Add seats to invite more people.`, 'seats_full');
  if (await prisma.membership.findFirst({ where: { orgId, user: { email: b.email } } })) throw new HttpError(409, 'This person is already a member', 'already_member');
  const token = randomToken();
  const inv = await prisma.invitation.create({ data: { orgId, email: b.email, role: b.role, tokenHash: sha256(token), invitedById: req.auth!.user.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
  await sendMail({ to: b.email, subject: `${req.auth!.user.name} invited you to ${me.org.name} on InQurix`, text: `Accept the invitation (valid for 7 days): ${config.APP_URL}/accept-invite?token=${token}` });
  await audit('org.invite', { orgId, userId: req.auth!.user.id, target: b.email, meta: { role: b.role }, ip: req.ip });
  res.status(201).json({ id: inv.id });
}));

orgsRouter.delete('/orgs/:orgId/invitations/:id', ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  await requireMember(req, orgId, ['owner', 'admin']);
  await prisma.invitation.deleteMany({ where: { id: String(req.params.id), orgId, acceptedAt: null } });
  res.json({ ok: true });
}));

orgsRouter.post('/invitations/accept', ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(b.token) } });
  if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw new HttpError(400, 'This invitation is invalid or has expired', 'invalid_token');
  if (inv.email !== req.auth!.user.email) throw new HttpError(403, 'This invitation was sent to a different email address', 'wrong_account');
  if (!req.auth!.user.emailVerifiedAt) throw new HttpError(403, 'Confirm your email address before joining an organisation', 'email_unverified');
  await prisma.$transaction([
    prisma.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
    prisma.membership.upsert({ where: { orgId_userId: { orgId: inv.orgId, userId: req.auth!.user.id } }, create: { orgId: inv.orgId, userId: req.auth!.user.id, role: inv.role }, update: {} }),
  ]);
  await audit('org.join', { orgId: inv.orgId, userId: req.auth!.user.id, ip: req.ip });
  res.json({ orgId: inv.orgId });
}));

async function ownerCount(orgId: string) { return prisma.membership.count({ where: { orgId, role: 'owner' } }); }

orgsRouter.patch('/orgs/:orgId/members/:userId', ah(async (req, res) => {
  const orgId = param(req, 'orgId'), userId = param(req, 'userId');
  const me = await requireMember(req, orgId, ['owner', 'admin']);
  const b = parse(z.object({ role: z.enum(['owner', 'admin', 'member', 'viewer']) }), req.body);
  const target = await prisma.membership.findUnique({ where: { orgId_userId: { orgId, userId } } });
  if (!target) throw new HttpError(404, 'Member not found', 'not_found');
  if (me.role !== 'owner' && (target.role === 'owner' || b.role === 'owner' || target.role === 'admin')) throw new HttpError(403, 'Only an owner can change owners or admins', 'forbidden');
  if (target.role === 'owner' && b.role !== 'owner' && (await ownerCount(orgId)) <= 1) throw new HttpError(409, 'An organisation needs at least one owner', 'last_owner');
  await prisma.membership.update({ where: { id: target.id }, data: { role: b.role } });
  await audit('org.role_change', { orgId, userId: req.auth!.user.id, target: userId, meta: { from: target.role, to: b.role }, ip: req.ip });
  res.json({ ok: true });
}));

/** Removing a member revokes their organisation access and every source grant immediately. */
orgsRouter.delete('/orgs/:orgId/members/:userId', ah(async (req, res) => {
  const orgId = param(req, 'orgId'), userId = param(req, 'userId');
  const self = userId === req.auth!.user.id;
  const me = await requireMember(req, orgId, self ? undefined : ['owner', 'admin']);
  const target = await prisma.membership.findUnique({ where: { orgId_userId: { orgId, userId } } });
  if (!target) throw new HttpError(404, 'Member not found', 'not_found');
  if (!self && me.role !== 'owner' && RANK[target.role] >= RANK.admin) throw new HttpError(403, 'Only an owner can remove owners or admins', 'forbidden');
  if (target.role === 'owner' && (await ownerCount(orgId)) <= 1) throw new HttpError(409, 'An organisation needs at least one owner', 'last_owner');
  await prisma.$transaction([
    prisma.sourceGrant.deleteMany({ where: { userId, source: { orgId } } }),
    prisma.source.updateMany({ where: { orgId, createdById: userId }, data: { createdById: null } }),
    prisma.membership.delete({ where: { id: target.id } }),
  ]);
  await audit('org.member_removed', { orgId, userId: req.auth!.user.id, target: userId, ip: req.ip });
  res.json({ ok: true });
}));

orgsRouter.get('/orgs/:orgId/audit', ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  const me = await requireMember(req, orgId, ['owner', 'admin']);
  if (!PLANS[me.org.plan].features.auditLog) throw new HttpError(402, 'The activity log needs the Business plan', 'plan_required');
  res.json(await prisma.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 500 }));
}));
