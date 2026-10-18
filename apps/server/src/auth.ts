import { Router, type NextFunction, type Request, type Response } from 'express';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Session, User } from '@prisma/client';
import { prisma } from './db.js';
import { config, secureCookies } from './config.js';
import { decrypt, encrypt, randomToken, sha256 } from './crypto.js';
import { HttpError, ah, parse } from './http.js';
import { sendMail } from './mail.js';
import { audit } from './audit.js';
import { rateLimit } from './ratelimit.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { auth?: { user: User; session: Session } }
  }
}

export const SESSION_COOKIE = 'iqx_session';
const SESSION_DAYS = 30;
const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, 'Use at least 10 characters').max(200);

export const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, emailVerified: !!u.emailVerifiedAt, mfaEnabled: u.mfaEnabled, google: !!u.googleSub });

async function createSession(res: Response, user: User, req: Request, mfaPassed: boolean) {
  const token = randomToken();
  const session = await prisma.session.create({
    data: { userId: user.id, tokenHash: sha256(token), mfaPassed, userAgent: req.get('user-agent')?.slice(0, 200), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) },
  });
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/', maxAge: SESSION_DAYS * 86_400_000 });
  return { token, session };
}

/** Resolves the session from the cookie or a Bearer token (desktop app). */
export const authenticate = ah(async (req, _res, next) => {
  const bearer = req.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const cookie = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  const token = bearer ?? cookie;
  if (token) {
    const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (session && !session.revokedAt && session.expiresAt > new Date()) {
      req.auth = { user: session.user, session };
      if (Date.now() - session.lastUsedAt.getTime() > 3_600_000) await prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
    }
  }
  // Cookie-authenticated state changes must come from our own origin.
  if (!bearer && cookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin') ?? req.get('referer');
    if (!origin || new URL(origin).origin !== new URL(config.APP_URL).origin) throw new HttpError(403, 'Cross-site request blocked', 'csrf');
  }
  next();
});

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new HttpError(401, 'Sign in required', 'unauthenticated'));
  if (req.auth.user.mfaEnabled && !req.auth.session.mfaPassed) return next(new HttpError(401, 'Two-factor verification required', 'mfa_required'));
  next();
}

async function issueToken(userId: string, kind: 'verify_email' | 'reset_password', hours: number) {
  const token = randomToken();
  await prisma.userToken.create({ data: { userId, kind, tokenHash: sha256(token), expiresAt: new Date(Date.now() + hours * 3_600_000) } });
  return token;
}

async function consumeToken(token: string, kind: string) {
  const t = await prisma.userToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!t || t.kind !== kind || t.usedAt || t.expiresAt < new Date()) throw new HttpError(400, 'This link is invalid or has expired', 'invalid_token');
  const used = await prisma.userToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
  if (used.count !== 1) throw new HttpError(400, 'This link has already been used', 'invalid_token');
  return t;
}

async function sendVerification(user: User) {
  const token = await issueToken(user.id, 'verify_email', 48);
  await sendMail({ to: user.email, subject: 'Confirm your InQurix email', text: `Confirm your email address: ${config.APP_URL}/verify-email?token=${token}\n\nIf you did not create an InQurix account, ignore this email.` });
}

const recoveryHash = (code: string) => sha256(`recovery:${code.replace(/[\s-]/g, '').toLowerCase()}`);

export const authRouter = Router();
const limitLogin = rateLimit('login', 20, 15 * 60_000);
const limitMail = rateLimit('mail', 10, 60 * 60_000);

authRouter.post('/register', limitMail, ah(async (req, res) => {
  const b = parse(z.object({ email, password, name: z.string().trim().min(1).max(120) }), req.body);
  if (await prisma.user.findUnique({ where: { email: b.email } })) throw new HttpError(409, 'An account with this email already exists. Sign in or reset your password.', 'email_taken');
  const user = await prisma.user.create({ data: { email: b.email, name: b.name, passwordHash: await argonHash(b.password) } });
  await prisma.organization.create({ data: { name: `${b.name} (personal)`, personal: true, members: { create: { userId: user.id, role: 'owner' } } } });
  await sendVerification(user);
  await audit('user.register', { userId: user.id, ip: req.ip });
  const { token } = await createSession(res, user, req, true);
  res.status(201).json({ user: publicUser(user), token });
}));

authRouter.post('/login', limitLogin, ah(async (req, res) => {
  const b = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
  const user = await prisma.user.findUnique({ where: { email: b.email } });
  const generic = new HttpError(401, 'Email or password is incorrect', 'invalid_credentials');
  if (!user || !user.passwordHash) { await argonHash('timing-equaliser'); throw generic; }
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new HttpError(423, 'Too many failed attempts. Try again later or reset your password.', 'locked');
  if (!(await argonVerify(user.passwordHash, b.password))) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({ where: { id: user.id }, data: { failedLogins: failed >= LOCK_AFTER ? 0 : failed, lockedUntil: failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null } });
    await audit('user.login_failed', { userId: user.id, ip: req.ip });
    throw generic;
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  const { token } = await createSession(res, user, req, !user.mfaEnabled);
  await audit('user.login', { userId: user.id, ip: req.ip });
  res.json({ user: publicUser(user), token, mfaRequired: user.mfaEnabled });
}));

authRouter.post('/mfa/verify', limitLogin, ah(async (req, res) => {
  if (!req.auth) throw new HttpError(401, 'Sign in required', 'unauthenticated');
  const b = parse(z.object({ code: z.string().trim().min(6).max(20) }), req.body);
  const u = req.auth.user;
  if (!u.mfaEnabled || !u.mfaSecret) throw new HttpError(400, 'Two-factor authentication is not enabled', 'mfa_not_enabled');
  let ok = /^\d{6}$/.test(b.code) && authenticator.check(b.code, decrypt(u.mfaSecret));
  if (!ok) {
    const h = recoveryHash(b.code);
    if (u.recoveryCodes.includes(h)) {
      await prisma.user.update({ where: { id: u.id }, data: { recoveryCodes: u.recoveryCodes.filter((c) => c !== h) } });
      await audit('user.recovery_code_used', { userId: u.id, ip: req.ip });
      ok = true;
    }
  }
  if (!ok) throw new HttpError(401, 'The code is incorrect', 'invalid_code');
  await prisma.session.update({ where: { id: req.auth.session.id }, data: { mfaPassed: true } });
  res.json({ ok: true });
}));

authRouter.post('/logout', ah(async (req, res) => {
  if (req.auth) await prisma.session.update({ where: { id: req.auth.session.id }, data: { revokedAt: new Date() } });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, ah(async (req, res) => {
  const memberships = await prisma.membership.findMany({ where: { userId: req.auth!.user.id }, include: { org: true } });
  res.json({ user: publicUser(req.auth!.user), organizations: memberships.map((m) => ({ id: m.org.id, name: m.org.name, personal: m.org.personal, plan: m.org.plan, role: m.role })) });
}));

authRouter.post('/verify-email', ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
  const t = await consumeToken(b.token, 'verify_email');
  await prisma.user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } });
  res.json({ ok: true });
}));

authRouter.post('/verify-email/resend', requireAuth, limitMail, ah(async (req, res) => {
  if (!req.auth!.user.emailVerifiedAt) await sendVerification(req.auth!.user);
  res.json({ ok: true });
}));

authRouter.post('/password/forgot', limitMail, ah(async (req, res) => {
  const b = parse(z.object({ email }), req.body);
  const user = await prisma.user.findUnique({ where: { email: b.email } });
  if (user) {
    const token = await issueToken(user.id, 'reset_password', 1);
    await sendMail({ to: user.email, subject: 'Reset your InQurix password', text: `Reset your password (valid for 1 hour): ${config.APP_URL}/reset-password?token=${token}\n\nIf you did not ask for this, ignore this email; your password is unchanged.` });
    await audit('user.password_reset_requested', { userId: user.id, ip: req.ip });
  }
  res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
}));

authRouter.post('/password/reset', limitLogin, ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10).max(200), password }), req.body);
  const t = await consumeToken(b.token, 'reset_password');
  await prisma.user.update({ where: { id: t.userId }, data: { passwordHash: await argonHash(b.password), failedLogins: 0, lockedUntil: null } });
  await prisma.session.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit('user.password_reset', { userId: t.userId, ip: req.ip });
  res.json({ ok: true });
}));

authRouter.post('/password/change', requireAuth, ah(async (req, res) => {
  const b = parse(z.object({ current: z.string().max(200), password }), req.body);
  const u = req.auth!.user;
  if (!u.passwordHash || !(await argonVerify(u.passwordHash, b.current))) throw new HttpError(401, 'Current password is incorrect', 'invalid_credentials');
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await argonHash(b.password) } });
  await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null, id: { not: req.auth!.session.id } }, data: { revokedAt: new Date() } });
  await audit('user.password_changed', { userId: u.id, ip: req.ip });
  res.json({ ok: true });
}));

authRouter.post('/mfa/setup', requireAuth, ah(async (req, res) => {
  const u = req.auth!.user;
  if (u.mfaEnabled) throw new HttpError(409, 'Two-factor authentication is already enabled', 'mfa_enabled');
  const secret = authenticator.generateSecret();
  await prisma.user.update({ where: { id: u.id }, data: { mfaSecret: encrypt(secret) } });
  res.json({ secret, otpauthUrl: authenticator.keyuri(u.email, 'InQurix', secret) });
}));

authRouter.post('/mfa/enable', requireAuth, ah(async (req, res) => {
  const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
  const u = req.auth!.user;
  if (!u.mfaSecret || u.mfaEnabled) throw new HttpError(400, 'Start two-factor setup first', 'mfa_not_started');
  if (!authenticator.check(b.code, decrypt(u.mfaSecret))) throw new HttpError(401, 'The code is incorrect', 'invalid_code');
  const codes = Array.from({ length: 10 }, () => randomToken(6).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase().padEnd(8, '0'));
  await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true, recoveryCodes: codes.map(recoveryHash) } });
  await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null, id: { not: req.auth!.session.id } }, data: { revokedAt: new Date() } });
  await prisma.session.update({ where: { id: req.auth!.session.id }, data: { mfaPassed: true } });
  await audit('user.mfa_enabled', { userId: u.id, ip: req.ip });
  res.json({ recoveryCodes: codes });
}));

authRouter.post('/mfa/disable', requireAuth, ah(async (req, res) => {
  const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
  const u = req.auth!.user;
  if (!u.mfaEnabled || !u.mfaSecret || !authenticator.check(b.code, decrypt(u.mfaSecret))) throw new HttpError(401, 'The code is incorrect', 'invalid_code');
  await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: false, mfaSecret: null, recoveryCodes: [] } });
  await audit('user.mfa_disabled', { userId: u.id, ip: req.ip });
  res.json({ ok: true });
}));

authRouter.get('/sessions', requireAuth, ah(async (req, res) => {
  const s = await prisma.session.findMany({ where: { userId: req.auth!.user.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastUsedAt: 'desc' } });
  res.json(s.map((x) => ({ id: x.id, userAgent: x.userAgent, createdAt: x.createdAt, lastUsedAt: x.lastUsedAt, current: x.id === req.auth!.session.id })));
}));

authRouter.delete('/sessions/:id', requireAuth, ah(async (req, res) => {
  await prisma.session.updateMany({ where: { id: String(req.params.id), userId: req.auth!.user.id }, data: { revokedAt: new Date() } });
  res.json({ ok: true });
}));

/* Google sign-in: authorisation code flow with PKCE and a signed state cookie. */
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const googleRedirect = () => `${config.APP_URL}/api/auth/google/callback`;

authRouter.get('/google/start', ah(async (_req, res) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) throw new HttpError(503, 'Google sign-in is not configured on this server', 'not_configured');
  const state = randomToken(16), verifier = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  res.cookie('iqx_oauth', `${state}.${verifier}`, { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 10 * 60_000, path: '/api/auth/google' });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID, redirect_uri: googleRedirect(), response_type: 'code', scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  res.redirect(u.toString());
}));

authRouter.get('/google/callback', ah(async (req, res) => {
  const [state, verifier] = String((req.cookies as Record<string, string>)?.iqx_oauth ?? '').split('.');
  res.clearCookie('iqx_oauth', { path: '/api/auth/google' });
  if (!state || !verifier || req.query.state !== state || typeof req.query.code !== 'string') throw new HttpError(400, 'Google sign-in could not be verified. Please try again.', 'oauth_state');
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: req.query.code, client_id: config.GOOGLE_CLIENT_ID, client_secret: config.GOOGLE_CLIENT_SECRET, redirect_uri: googleRedirect(), grant_type: 'authorization_code', code_verifier: verifier }),
  });
  if (!tr.ok) throw new HttpError(502, 'Google sign-in failed', 'oauth_exchange');
  const { id_token } = (await tr.json()) as { id_token?: string };
  if (!id_token) throw new HttpError(502, 'Google sign-in failed', 'oauth_exchange');
  const { payload } = await jwtVerify(id_token, googleJwks, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: config.GOOGLE_CLIENT_ID });
  const sub = String(payload.sub), mail = String(payload.email ?? '').toLowerCase();
  if (!payload.email_verified || !mail) throw new HttpError(403, 'Your Google email address is not verified', 'oauth_unverified');
  let user = await prisma.user.findUnique({ where: { googleSub: sub } }) ?? await prisma.user.findUnique({ where: { email: mail } });
  if (user && !user.googleSub) user = await prisma.user.update({ where: { id: user.id }, data: { googleSub: sub, emailVerifiedAt: user.emailVerifiedAt ?? new Date() } });
  if (!user) {
    const name = String(payload.name ?? mail.split('@')[0]);
    user = await prisma.user.create({ data: { email: mail, name, googleSub: sub, emailVerifiedAt: new Date() } });
    await prisma.organization.create({ data: { name: `${name} (personal)`, personal: true, members: { create: { userId: user.id, role: 'owner' } } } });
  }
  await createSession(res, user, req, !user.mfaEnabled);
  await audit('user.login_google', { userId: user.id, ip: req.ip });
  res.redirect(user.mfaEnabled ? '/?mfa=1' : '/');
}));
