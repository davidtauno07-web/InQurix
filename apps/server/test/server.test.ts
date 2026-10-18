import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { createHmac } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { outbox } from '../src/mail.js';

const app = createApp();
const ORIGIN = 'http://localhost:4100';
const tokenFrom = (text: string) => text.match(/token=([\w-]+)/)![1]!;
const lastMailTo = (to: string) => [...outbox].reverse().find((m) => m.to === to)!;

async function register(email: string, name = email.split('@')[0]!) {
  const r = await request(app).post('/api/auth/register').send({ email, name, password: 'correct horse battery' }).expect(201);
  const verify = tokenFrom(lastMailTo(email).text);
  await request(app).post('/api/auth/verify-email').send({ token: verify }).expect(200);
  return { token: r.body.token as string, id: r.body.user.id as string };
}
const as = (token: string) => ({
  get: (u: string) => request(app).get(u).set('authorization', `Bearer ${token}`),
  post: (u: string) => request(app).post(u).set('authorization', `Bearer ${token}`),
  put: (u: string) => request(app).put(u).set('authorization', `Bearer ${token}`),
  patch: (u: string) => request(app).patch(u).set('authorization', `Bearer ${token}`),
  delete: (u: string) => request(app).delete(u).set('authorization', `Bearer ${token}`),
});

function paddleSign(body: string, ts = Math.floor(Date.now() / 1000)) {
  return `ts=${ts};h1=${createHmac('sha256', 'pdl_ntfset_test_secret').update(`${ts}:${body}`).digest('hex')}`;
}
const webhook = (ev: object, sig?: string) => {
  const body = JSON.stringify(ev);
  return request(app).post('/api/webhooks/paddle').set('content-type', 'application/json').set('paddle-signature', sig ?? paddleSign(body)).send(body);
};

beforeAll(async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
});
afterAll(() => prisma.$disconnect());

describe('accounts', () => {
  it('registers with a personal workspace and rejects duplicates and weak passwords', async () => {
    const { token } = await register('alice@example.com', 'Alice');
    const me = await as(token).get('/api/auth/me').expect(200);
    expect(me.body.user).toMatchObject({ email: 'alice@example.com', emailVerified: true, mfaEnabled: false });
    expect(me.body.organizations).toEqual([expect.objectContaining({ personal: true, plan: 'free', role: 'owner' })]);
    await request(app).post('/api/auth/register').send({ email: 'ALICE@example.com', name: 'x', password: 'correct horse battery' }).expect(409);
    await request(app).post('/api/auth/register').send({ email: 'bob@example.com', name: 'x', password: 'short' }).expect(400);
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|argon/);
  });

  it('gives one message for unknown email and wrong password, and locks after repeated failures', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'whatever123' }).expect(401);
    const b = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'wrong password' }).expect(401);
    expect(a.body.message).toBe(b.body.message);
    for (let i = 0; i < 7; i++) await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'wrong password' });
    await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'correct horse battery' }).expect(423);
    await prisma.user.update({ where: { email: 'alice@example.com' }, data: { lockedUntil: null } });
    await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'correct horse battery' }).expect(200);
  });

  it('resets a password with a single-use emailed link and signs out other sessions', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'correct horse battery' }).expect(200);
    const forgot = await request(app).post('/api/auth/password/forgot').send({ email: 'alice@example.com' }).expect(200);
    const unknown = await request(app).post('/api/auth/password/forgot').send({ email: 'ghost@example.com' }).expect(200);
    expect(forgot.body.message).toBe(unknown.body.message);
    const token = tokenFrom(lastMailTo('alice@example.com').text);
    await request(app).post('/api/auth/password/reset').send({ token, password: 'a brand new passphrase' }).expect(200);
    await request(app).post('/api/auth/password/reset').send({ token, password: 'another passphrase' }).expect(400);
    await as(login.body.token).get('/api/auth/me').expect(401);
    await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'a brand new passphrase' }).expect(200);
  });

  it('requires a TOTP or one-time recovery code when two-factor is on', async () => {
    const { token } = await register('mfa@example.com');
    const setup = await as(token).post('/api/auth/mfa/setup').expect(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/InQurix/);
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'mfa@example.com' } });
    expect(stored.mfaSecret).not.toContain(setup.body.secret);
    await as(token).post('/api/auth/mfa/enable').send({ code: '000000' }).expect(401);
    const en = await as(token).post('/api/auth/mfa/enable').send({ code: authenticator.generate(setup.body.secret) }).expect(200);
    expect(en.body.recoveryCodes).toHaveLength(10);

    const login = await request(app).post('/api/auth/login').send({ email: 'mfa@example.com', password: 'correct horse battery' }).expect(200);
    expect(login.body.mfaRequired).toBe(true);
    const r = await as(login.body.token).get('/api/auth/me').expect(401);
    expect(r.body.error).toBe('mfa_required');
    await as(login.body.token).post('/api/auth/mfa/verify').send({ code: en.body.recoveryCodes[0] }).expect(200);
    await as(login.body.token).get('/api/auth/me').expect(200);

    const again = await request(app).post('/api/auth/login').send({ email: 'mfa@example.com', password: 'correct horse battery' });
    await as(again.body.token).post('/api/auth/mfa/verify').send({ code: en.body.recoveryCodes[0] }).expect(401);
    await as(again.body.token).post('/api/auth/mfa/verify').send({ code: authenticator.generate(setup.body.secret) }).expect(200);
  });

  it('blocks cross-site cookie requests', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: 'alice@example.com', password: 'a brand new passphrase' }).set('origin', ORIGIN).expect(200);
    await agent.get('/api/auth/me').expect(200);
    await agent.post('/api/orgs').send({ name: 'Evil' }).set('origin', 'https://evil.example').expect(403);
    await agent.post('/api/orgs').send({ name: 'Mine' }).set('origin', ORIGIN).expect(201);
  });

  it('reports Google sign-in as not configured instead of faking it', async () => {
    await request(app).get('/api/auth/google/start').expect(503);
  });
});

describe('company workspace permissions', () => {
  let owner: string, member: string, viewer: string, memberId: string, viewerId: string, orgId: string, sourceId: string, docId: string;

  beforeAll(async () => {
    owner = (await register('owner@acme.test', 'Owner')).token;
    const m = await register('member@acme.test', 'Member'); member = m.token; memberId = m.id;
    const v = await register('viewer@acme.test', 'Viewer'); viewer = v.token; viewerId = v.id;
    orgId = (await as(owner).post('/api/orgs').send({ name: 'Acme Trading' }).expect(201)).body.id;
  });

  it('needs the Business plan to invite colleagues', async () => {
    const r = await as(owner).post(`/api/orgs/${orgId}/invitations`).send({ email: 'member@acme.test', role: 'member' }).expect(402);
    expect(r.body.error).toBe('plan_required');
  });

  it('activates Business from a signed, idempotent Paddle webhook', async () => {
    const ev = { event_id: 'evt_sub_1', event_type: 'subscription.created', occurred_at: new Date().toISOString(), data: { id: 'sub_1', status: 'active', customer_id: 'ctm_1', custom_data: { orgId }, items: [{ price: { id: 'pri_business_test' }, quantity: 5 }], current_billing_period: { ends_at: '2026-12-01T00:00:00Z' } } };
    await webhook(ev, 'ts=1;h1=deadbeef').expect(401);
    await webhook({ ...ev, data: { ...ev.data, items: [{ price: { id: 'pri_business_test' }, quantity: 250 }] } }, paddleSign(JSON.stringify(ev))).expect(401);
    await webhook(ev).expect(200);
    expect((await webhook(ev).expect(200)).body.duplicate).toBe(true);
    const older = { ...ev, event_id: 'evt_sub_0', occurred_at: new Date(Date.now() - 3_600_000).toISOString(), data: { ...ev.data, status: 'canceled' } };
    expect((await webhook(older).expect(200)).body.outcome).toBe('stale');
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org).toMatchObject({ plan: 'business', seats: 5 });

    const txn = { event_id: 'evt_txn_1', event_type: 'transaction.completed', occurred_at: new Date().toISOString(), data: { id: 'txn_1', subscription_id: 'sub_1', custom_data: { orgId }, items: [{ price: { id: 'pri_business_test' }, quantity: 5 }] } };
    await webhook(txn).expect(200);
    await webhook({ ...txn, event_id: 'evt_txn_1_redelivered' }).expect(200);
    const credits = await as(owner).get(`/api/billing/orgs/${orgId}/credits`).expect(200);
    expect(credits.body.balance).toBe(2000);
    expect(credits.body.entries).toHaveLength(1);
  });

  it('invites by email; only the invited address can accept', async () => {
    for (const [email, role] of [['member@acme.test', 'member'], ['viewer@acme.test', 'viewer']] as const) {
      await as(owner).post(`/api/orgs/${orgId}/invitations`).send({ email, role }).expect(201);
    }
    const memberInvite = tokenFrom(lastMailTo('member@acme.test').text);
    await as(viewer).post('/api/invitations/accept').send({ token: memberInvite }).expect(403);
    await as(member).post('/api/invitations/accept').send({ token: memberInvite }).expect(200);
    await as(viewer).post('/api/invitations/accept').send({ token: tokenFrom(lastMailTo('viewer@acme.test').text) }).expect(200);
    const org = await as(member).get(`/api/orgs/${orgId}`).expect(200);
    expect(org.body.members.map((m: { role: string }) => m.role).sort()).toEqual(['member', 'owner', 'viewer']);
    expect(org.body.invitations).toEqual([]);
    await as(member).post(`/api/orgs/${orgId}/invitations`).send({ email: 'x@acme.test', role: 'member' }).expect(403);
  });

  it('restricted sources are invisible to search, preview and export until granted', async () => {
    sourceId = (await as(owner).post(`/api/orgs/${orgId}/sources`).send({ name: 'Finance' }).expect(201)).body.id;
    const up = await as(owner).post(`/api/sources/${sourceId}/documents`).set('x-file-name', 'invoice-INV-1048.txt').set('content-type', 'application/octet-stream')
      .send(Buffer.from('Tax Invoice INV-1048\nSupplier: Kavango Office Supplies\nTotal due N$ 14,317.50\nBank account 62012345678')).expect(201);
    docId = up.body.id;
    expect(up.body.segments).toBeGreaterThan(0);

    const ownerHits = await as(owner).get('/api/search').query({ q: 'INV-1048' }).expect(200);
    expect(ownerHits.body.results[0]).toMatchObject({ documentId: docId, name: 'invoice-INV-1048.txt' });
    expect(ownerHits.body.results[0].snippet.some((p: { hit: boolean }) => p.hit)).toBe(true);

    expect((await as(member).get('/api/search').query({ q: 'INV-1048' }).expect(200)).body.results).toEqual([]);
    expect((await as(member).get('/api/search').query({ q: 'Kavango', orgId }).expect(200)).body.results).toEqual([]);
    await as(member).get(`/api/documents/${docId}`).expect(404);
    await as(member).get(`/api/documents/${docId}/download`).expect(404);
    const listed = await as(member).get(`/api/orgs/${orgId}/sources`).expect(200);
    expect(listed.body).toEqual([]);

    await as(member).put(`/api/sources/${sourceId}/grants/${memberId}`).send({}).expect(403);
    await as(owner).put(`/api/sources/${sourceId}/grants/${memberId}`).send({ canExport: false }).expect(200);
    expect((await as(member).get('/api/search').query({ q: '14,317.50' }).expect(200)).body.results).toHaveLength(1);
    const prev = await as(member).get(`/api/documents/${docId}`).expect(200);
    expect(prev.body.segments[0].text).toContain('Kavango');
    expect(prev.body.canExport).toBe(false);
    await as(member).get(`/api/documents/${docId}/download`).expect(403);
    await as(owner).put(`/api/sources/${sourceId}/grants/${memberId}`).send({ canExport: true }).expect(200);
    const dl = await as(member).get(`/api/documents/${docId}/download`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect((dl.body as Buffer).toString()).toContain('INV-1048');

    await as(owner).delete(`/api/sources/${sourceId}/grants/${memberId}`).expect(200);
    expect((await as(member).get('/api/search').query({ q: 'INV-1048' }).expect(200)).body.results).toEqual([]);
    await as(member).get(`/api/documents/${docId}`).expect(404);

    const actions = (await prisma.auditLog.findMany({ where: { orgId } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['source.grant', 'source.revoke', 'document.preview', 'document.export']));
  });

  it('viewers can read shared sources but not upload; executables are refused', async () => {
    await as(owner).patch(`/api/sources/${sourceId}`).send({ allMembers: true }).expect(200);
    expect((await as(viewer).get('/api/search').query({ q: 'INV-1048' }).expect(200)).body.results).toHaveLength(1);
    await as(viewer).post(`/api/sources/${sourceId}/documents`).set('x-file-name', 'a.txt').set('content-type', 'application/octet-stream').send(Buffer.from('hello')).expect(403);
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
    const r = await as(owner).post(`/api/sources/${sourceId}/documents`).set('x-file-name', 'invoice.pdf.exe').set('content-type', 'application/octet-stream').send(exe).expect(415);
    expect(r.body.error).toBe('dangerous_file');
  });

  it('removing a member revokes access immediately', async () => {
    await as(owner).delete(`/api/orgs/${orgId}/members/${viewerId}`).expect(200);
    expect((await as(viewer).get('/api/search').query({ q: 'INV-1048' }).expect(200)).body.results).toEqual([]);
    await as(viewer).get(`/api/orgs/${orgId}`).expect(404);
    await as(owner).delete(`/api/orgs/${orgId}/members/${(await prisma.user.findUniqueOrThrow({ where: { email: 'owner@acme.test' } })).id}`).expect(409);
  });

  it('spends credits once per idempotency key and refuses overdraft', async () => {
    const spend = (key: string, quantity = 1) => as(member).post(`/api/billing/orgs/${orgId}/credits/spend`).send({ operation: 'investigation:cost_savings', quantity, idempotencyKey: key });
    const a = await spend('run-0001').expect(200);
    const b = await spend('run-0001').expect(200);
    expect(b.body).toMatchObject({ duplicate: true, balance: a.body.balance });
    expect(a.body.balance).toBe(2000 - a.body.cost);
    const big = await spend('run-0002', 10_000).expect(402);
    expect(big.body.error).toBe('insufficient_credits');
    await as(member).post(`/api/billing/orgs/${orgId}/credits/spend`).send({ operation: 'search', idempotencyKey: 'run-0003' }).expect(400);
  });

  it('issues a signed entitlement the desktop app can verify offline', async () => {
    const r = await as(member).get(`/api/billing/orgs/${orgId}/entitlement`).expect(200);
    const pem = (await request(app).get('/api/billing/entitlement/public-key').expect(200)).text;
    const { payload } = await jwtVerify(r.body.token, await importSPKI(pem, 'EdDSA'), { issuer: 'inqurix' });
    expect((payload.ent as { plan: string; features: { companyWorkspace: boolean } })).toMatchObject({ plan: 'business', features: { companyWorkspace: true } });
    await as(viewer).get(`/api/billing/orgs/${orgId}/entitlement`).expect(404);
  });

  it('checkout reports missing billing configuration honestly', async () => {
    const r = await as(owner).post(`/api/billing/orgs/${orgId}/checkout`).send({ plan: 'business', seats: 5 }).expect(503);
    expect(r.body.error).toBe('not_configured');
    await as(member).post(`/api/billing/orgs/${orgId}/checkout`).send({ plan: 'business' }).expect(403);
  });
});
