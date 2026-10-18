import { Router, type Request } from 'express';
import express from 'express';
import { SignJWT, importPKCS8, generateKeyPair, exportSPKI, type CryptoKey, type KeyObject } from 'jose';
import { z } from 'zod';
import type { Plan, Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { config } from './config.js';
import { hmac, safeEqual } from './crypto.js';
import { HttpError, ah, param, parse } from './http.js';
import { requireAuth } from './auth.js';
import { requireMember } from './orgs.js';
import { OPERATION_COSTS, PLANS } from './plans.js';
import { audit } from './audit.js';
import { log } from './log.js';

/* ---------- Credits ledger: append-only, balance carried on every entry. ---------- */

type Tx = Prisma.TransactionClient;

async function lockOrg(tx: Tx, orgId: string) {
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId} FOR UPDATE`;
}

export async function balance(orgId: string, tx: Tx | typeof prisma = prisma): Promise<number> {
  const last = await tx.creditEntry.findFirst({ where: { orgId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return last?.balanceAfter ?? 0;
}

/** Adds (or removes) credits once per idempotency key. */
export async function postCredits(orgId: string, delta: number, reason: string, opts: { idempotencyKey?: string; operation?: string; userId?: string } = {}) {
  return prisma.$transaction(async (tx) => {
    await lockOrg(tx, orgId);
    if (opts.idempotencyKey) {
      const prior = await tx.creditEntry.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });
      if (prior) return { entry: prior, duplicate: true };
    }
    const current = await balance(orgId, tx);
    if (current + delta < 0) throw new HttpError(402, `Not enough credits: this needs ${-delta}, ${current} available.`, 'insufficient_credits');
    const entry = await tx.creditEntry.create({ data: { orgId, delta, balanceAfter: current + delta, reason, ...opts } });
    return { entry, duplicate: false };
  });
}

/* ---------- Entitlements: signed so the desktop app can verify them offline. ---------- */

let signingKey: Promise<{ priv: CryptoKey | KeyObject; publicPem: string }> | undefined;
function keys() {
  signingKey ??= (async () => {
    if (config.ENTITLEMENT_PRIVATE_KEY) {
      return { priv: await importPKCS8(config.ENTITLEMENT_PRIVATE_KEY.replace(/\\n/g, '\n'), 'EdDSA'), publicPem: config.ENTITLEMENT_PUBLIC_KEY.replace(/\\n/g, '\n') };
    }
    if (config.NODE_ENV === 'production') throw new Error('ENTITLEMENT_PRIVATE_KEY is required in production');
    log.warn('ENTITLEMENT_PRIVATE_KEY not set: using a temporary key; desktop entitlements will not verify after a restart');
    const kp = await generateKeyPair('EdDSA', { extractable: true });
    return { priv: kp.privateKey, publicPem: await exportSPKI(kp.publicKey) };
  })();
  return signingKey;
}

export async function entitlementFor(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, include: { subscription: true, _count: { select: { members: true } } } });
  const def = PLANS[org.plan];
  return { orgId, plan: org.plan, planName: def.name, features: def.features, seats: org.seats, members: org._count.members, credits: await balance(orgId), subscriptionStatus: org.subscription?.status ?? null, currentPeriodEnd: org.subscription?.currentPeriodEnd ?? null };
}

export async function signEntitlement(orgId: string, userId: string) {
  const ent = await entitlementFor(orgId);
  const token = await new SignJWT({ ent }).setProtectedHeader({ alg: 'EdDSA' }).setIssuer('inqurix').setSubject(userId).setIssuedAt().setExpirationTime('7d').sign((await keys()).priv);
  return { entitlement: ent, token };
}

/* ---------- Paddle Billing ---------- */

export interface BillingProvider {
  name: string;
  configured(): boolean;
  checkout(org: { id: string; email: string }, plan: Exclude<Plan, 'free'>, seats: number): Promise<{ url: string }>;
  verifyWebhook(raw: Buffer, headers: Request['headers']): boolean;
}

const paddleApi = () => (config.PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com');
const priceFor = (plan: Exclude<Plan, 'free'>) => (plan === 'pro' ? config.PADDLE_PRICE_PRO_MONTHLY : config.PADDLE_PRICE_BUSINESS_MONTHLY);
export const planForPrice = (priceId: string | undefined): Plan | undefined =>
  priceId && priceId === config.PADDLE_PRICE_PRO_MONTHLY ? 'pro' : priceId && priceId === config.PADDLE_PRICE_BUSINESS_MONTHLY ? 'business' : undefined;

export const paddle: BillingProvider = {
  name: 'paddle',
  configured: () => !!(config.PADDLE_API_KEY && priceFor('pro') && priceFor('business')),
  async checkout(org, plan, seats) {
    const r = await fetch(`${paddleApi()}/transactions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.PADDLE_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ price_id: priceFor(plan), quantity: plan === 'business' ? seats : 1 }], custom_data: { orgId: org.id }, collection_mode: 'automatic' }),
    });
    const body = (await r.json().catch(() => ({}))) as { data?: { checkout?: { url?: string } }; error?: { detail?: string } };
    if (!r.ok || !body.data?.checkout?.url) throw new HttpError(502, `Checkout could not be started: ${body.error?.detail ?? r.status}`, 'billing_provider');
    return { url: body.data.checkout.url };
  },
  /** Paddle-Signature: ts=<unix>;h1=<hex HMAC-SHA256 of "ts:rawBody">. Rejects stale timestamps. */
  verifyWebhook(raw, headers) {
    const sig = String(headers['paddle-signature'] ?? '');
    const parts = Object.fromEntries(sig.split(';').map((p) => p.split('=') as [string, string]));
    const ts = Number(parts.ts);
    if (!config.PADDLE_WEBHOOK_SECRET || !parts.ts || !parts.h1 || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
    return safeEqual(hmac(config.PADDLE_WEBHOOK_SECRET, `${parts.ts}:${raw.toString('utf8')}`), parts.h1);
  },
};

interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: { id: string; status?: string; customer_id?: string; subscription_id?: string; custom_data?: { orgId?: string } | null; items?: { price?: { id?: string }; quantity?: number }[]; current_billing_period?: { ends_at?: string } | null };
}

async function applyPaddleEvent(ev: PaddleEvent) {
  const d = ev.data;
  const at = new Date(ev.occurred_at);
  if (ev.event_type.startsWith('subscription.')) {
    const existing = await prisma.subscription.findUnique({ where: { providerSubscriptionId: d.id } });
    const orgId = d.custom_data?.orgId ?? existing?.orgId;
    if (!orgId) throw new Error('Subscription event without an organisation reference');
    if (existing?.lastEventAt && existing.lastEventAt > at) return 'stale';
    const plan = planForPrice(d.items?.[0]?.price?.id) ?? existing?.plan;
    if (!plan) throw new Error('Unknown price in subscription event');
    const seats = Math.max(1, d.items?.[0]?.quantity ?? 1);
    const status = d.status ?? 'active';
    const effective: Plan = ['active', 'trialing', 'past_due'].includes(status) ? plan : 'free';
    await prisma.$transaction([
      prisma.subscription.upsert({
        where: { orgId },
        create: { orgId, provider: 'paddle', providerCustomerId: d.customer_id, providerSubscriptionId: d.id, plan, status, seats, currentPeriodEnd: d.current_billing_period?.ends_at ? new Date(d.current_billing_period.ends_at) : null, lastEventAt: at },
        update: { providerCustomerId: d.customer_id, providerSubscriptionId: d.id, plan, status, seats, currentPeriodEnd: d.current_billing_period?.ends_at ? new Date(d.current_billing_period.ends_at) : null, lastEventAt: at },
      }),
      prisma.organization.update({ where: { id: orgId }, data: { plan: effective, seats: effective === 'business' ? seats : 1 } }),
    ]);
    await audit('billing.subscription', { orgId, meta: { event: ev.event_type, status, plan } });
    return 'applied';
  }
  if (ev.event_type === 'transaction.completed') {
    const sub = d.subscription_id ? await prisma.subscription.findUnique({ where: { providerSubscriptionId: d.subscription_id } }) : null;
    const orgId = d.custom_data?.orgId ?? sub?.orgId;
    const plan = planForPrice(d.items?.[0]?.price?.id) ?? sub?.plan;
    if (!orgId || !plan) throw new Error('Transaction without organisation or known price');
    await postCredits(orgId, PLANS[plan].monthlyCredits, `${PLANS[plan].name} plan credits for the billing period`, { idempotencyKey: `paddle:txn:${d.id}` });
    return 'applied';
  }
  return 'ignored';
}

export const webhookRouter = Router();
webhookRouter.post('/paddle', express.raw({ type: '*/*', limit: '1mb' }), ah(async (req, res) => {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !paddle.verifyWebhook(raw, req.headers)) throw new HttpError(401, 'Invalid signature', 'bad_signature');
  const ev = JSON.parse(raw.toString('utf8')) as PaddleEvent;
  if (!ev.event_id || !ev.event_type) throw new HttpError(400, 'Malformed event', 'invalid_request');
  try {
    await prisma.webhookEvent.create({ data: { provider: 'paddle', eventId: ev.event_id, type: ev.event_type, payload: ev as unknown as Prisma.InputJsonValue } });
  } catch (e) {
    const prior = await prisma.webhookEvent.findUnique({ where: { provider_eventId: { provider: 'paddle', eventId: ev.event_id } } });
    if (prior?.processedAt) return res.json({ ok: true, duplicate: true });
    if (!prior) throw e;
  }
  try {
    const outcome = await applyPaddleEvent(ev);
    await prisma.webhookEvent.update({ where: { provider_eventId: { provider: 'paddle', eventId: ev.event_id } }, data: { processedAt: new Date(), error: null } });
    res.json({ ok: true, outcome });
  } catch (e) {
    await prisma.webhookEvent.update({ where: { provider_eventId: { provider: 'paddle', eventId: ev.event_id } }, data: { error: (e as Error).message.slice(0, 500) } });
    log.error({ err: e, eventId: ev.event_id }, 'Paddle webhook failed');
    throw new HttpError(500, 'Event could not be processed; it will be retried', 'webhook_failed');
  }
}));

export const billingRouter = Router();
billingRouter.get('/plans', (_req, res) => res.json({ plans: PLANS, operationCosts: OPERATION_COSTS, checkoutAvailable: paddle.configured() }));

billingRouter.get('/orgs/:orgId/entitlement', requireAuth, ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  await requireMember(req, orgId);
  res.json(await signEntitlement(orgId, req.auth!.user.id));
}));

billingRouter.get('/entitlement/public-key', ah(async (_req, res) => { res.type('text/plain').send((await keys()).publicPem); }));

billingRouter.get('/orgs/:orgId/credits', requireAuth, ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  await requireMember(req, orgId);
  const entries = await prisma.creditEntry.findMany({ where: { orgId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 });
  res.json({ balance: await balance(orgId), entries });
}));

billingRouter.post('/orgs/:orgId/credits/spend', requireAuth, ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  await requireMember(req, orgId, ['owner', 'admin', 'member']);
  const b = parse(z.object({ operation: z.string().refine((o) => o in OPERATION_COSTS, 'Unknown operation'), quantity: z.number().int().min(1).max(10_000).default(1), idempotencyKey: z.string().min(8).max(100) }), req.body);
  const cost = OPERATION_COSTS[b.operation]! * b.quantity;
  const { entry, duplicate } = await postCredits(orgId, -cost, `Used for ${b.operation}${b.quantity > 1 ? ` × ${b.quantity}` : ''}`, { idempotencyKey: `spend:${orgId}:${b.idempotencyKey}`, operation: b.operation, userId: req.auth!.user.id });
  res.json({ ok: true, duplicate, cost, balance: entry.balanceAfter });
}));

billingRouter.post('/orgs/:orgId/checkout', requireAuth, ah(async (req, res) => {
  const orgId = param(req, 'orgId');
  await requireMember(req, orgId, ['owner']);
  const b = parse(z.object({ plan: z.enum(['pro', 'business']), seats: z.number().int().min(1).max(250).default(1) }), req.body);
  if (!paddle.configured()) throw new HttpError(503, 'Online checkout is not configured on this server yet.', 'not_configured');
  res.json(await paddle.checkout({ id: orgId, email: req.auth!.user.email }, b.plan, b.seats));
}));
