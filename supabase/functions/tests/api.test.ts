import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, loginEmailFor } from '../api/handler.ts';
import { verifyAccessToken } from '../api/auth.ts';
import { cleanSmsBody } from '../api/profjero.ts';
import { resetConfigCache } from '../api/supa.ts';
import { b64urlEncode, utf8 } from '../api/util.ts';
import type { Env } from '../api/env.ts';

const SB = 'https://proj.supabase.test';
const env: Env = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key', PROFJERO_BASE_URL: 'https://pj.test' };

let signer: CryptoKey;
let jwks: unknown;
beforeEach(() => resetConfigCache());
beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  signer = kp.privateKey;
  const pub = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  jwks = { keys: [{ ...pub, kid: 'kid-1', alg: 'ES256' }] };
});
afterEach(() => vi.unstubAllGlobals());

async function token(sub: string, over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64urlEncode(utf8(JSON.stringify({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' })));
  const p = b64urlEncode(utf8(JSON.stringify({ iss: `${SB}/auth/v1`, sub, role: 'authenticated', exp: now + 3600, iat: now, ...over })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, utf8(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(sig)}`;
}

const ROLES: Record<string, string[]> = {
  super_admin: ['users.manage', 'roles.manage', 'system.monitor', 'messaging.sms', 'people.manage'],
  developer: ['users.manage', 'roles.manage', 'system.monitor', 'messaging.sms', 'people.manage'],
  admin: ['users.manage', 'messaging.sms', 'people.manage'],
  pastor: ['messaging.sms', 'people.manage'],
  member: [],
};
type Call = { url: URL; init: RequestInit; body: unknown };
let calls: Call[] = [];
let config: Record<string, string> = {};

function backend(users: Record<string, string>, extra?: (c: Call) => Response | undefined) {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    let body: unknown = undefined;
    try { body = init.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init.body; }
    const c = { url, init, body };
    calls.push(c);
    const hit = extra?.(c);
    if (hit) return hit;
    if (url.pathname === '/auth/v1/.well-known/jwks.json') return Response.json(jwks);
    if (url.pathname === '/rest/v1/rpc/server_config') return Response.json(config);
    if (url.pathname === '/rest/v1/rpc/hit_rate_limit') return Response.json(true);
    if (url.pathname === '/rest/v1/rpc/server_email_reserved') return Response.json((body as { p_email: string }).p_email === 'christianworshipcentre.ch@gmail.com');
    if (url.pathname === '/rest/v1/rpc/server_set_config') { const b = body as { p_key: string; p_value: string }; config[b.p_key] ??= b.p_value; return Response.json(config[b.p_key]); }
    if (url.pathname === '/rest/v1/users' && (init.method ?? 'GET') === 'GET') {
      const id = url.searchParams.get('id')?.replace('eq.', '');
      if (id && users[id]) return Response.json([{ id, full_name: 'Tester', role: users[id], is_active: users[id] !== 'disabled', is_guest: false, roles: { permissions: ROLES[users[id]] ?? [] } }]);
      if (url.searchParams.get('role') === 'eq.super_admin') return Response.json(Object.entries(users).filter(([, r]) => r === 'super_admin').map(([id]) => ({ id })));
      return Response.json([]);
    }
    if (url.pathname === '/rest/v1/roles') { const key = url.searchParams.get('key')?.replace('eq.', '') ?? ''; return Response.json(ROLES[key] ? [{ key, permissions: ROLES[key] }] : []); }
    if (url.pathname === '/auth/v1/admin/users' && init.method === 'POST') return Response.json({ id: '11111111-1111-1111-1111-111111111111', email: (body as { email: string }).email });
    if (url.pathname.startsWith('/rest/v1/')) return Response.json([]);
    if (url.pathname.startsWith('/auth/v1/admin/users/')) return Response.json({});
    return new Response('not mocked: ' + url, { status: 599 });
  });
}

const U = { sa: 'aaaaaaaa-0000-0000-0000-000000000001', admin: 'aaaaaaaa-0000-0000-0000-000000000002', pastor: 'aaaaaaaa-0000-0000-0000-000000000003', member: 'aaaaaaaa-0000-0000-0000-000000000004', dev: 'aaaaaaaa-0000-0000-0000-000000000005', off: 'aaaaaaaa-0000-0000-0000-000000000006' };
const USERS = { [U.sa]: 'super_admin', [U.admin]: 'admin', [U.pastor]: 'pastor', [U.member]: 'member', [U.dev]: 'developer', [U.off]: 'disabled' };

async function call(path: string, init: RequestInit & { as?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set('origin', 'https://cwc-ch.pages.dev');
  if (init.as) headers.set('authorization', `Bearer ${await token(init.as)}`);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  return handle(new Request(`${SB}/functions/v1/api${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }), env);
}

describe('access tokens', () => {
  it('accepts a valid ES256 token from this project', async () => {
    backend(USERS);
    const r = await verifyAccessToken(await token(U.member), env);
    expect(r.uid).toBe(U.member);
  });
  it('rejects forged, expired, foreign or anonymous-role tokens', async () => {
    backend(USERS);
    const good = await token(U.member);
    const forged = good.slice(0, good.lastIndexOf('.') + 1) + b64urlEncode(new Uint8Array(64));
    await expect(verifyAccessToken(forged, env)).rejects.toThrow(/signature/);
    await expect(verifyAccessToken(await token(U.member, { exp: 1 }), env)).rejects.toThrow(/expired/);
    await expect(verifyAccessToken(await token(U.member, { iss: 'https://evil.test/auth/v1' }), env)).rejects.toThrow(/different project/);
    await expect(verifyAccessToken(await token(U.member, { role: 'anon' }), env)).rejects.toThrow();
    const none = `${b64urlEncode(utf8('{"alg":"none"}'))}.${b64urlEncode(utf8(JSON.stringify({ sub: U.sa })))}.`;
    await expect(verifyAccessToken(none, env)).rejects.toThrow(/algorithm/);
  });
  it('blocks deactivated accounts', async () => {
    backend(USERS);
    const r = await call('/v1/push/test', { method: 'POST', as: U.off });
    expect(r.status).toBe(403);
  });
});

describe('public endpoints', () => {
  it('health reports status with CORS for the Pages origin', async () => {
    backend(USERS);
    config = {};
    const r = await call('/v1/health');
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://cwc-ch.pages.dev');
    expect((await r.json()).sms).toBe(false);
  });
  it('does not reflect unknown origins', async () => {
    backend(USERS);
    const r = await handle(new Request(`${SB}/functions/v1/api/v1/health`, { headers: { origin: 'https://evil.example' } }), env);
    expect(r.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
  it('generates and stores a VAPID key pair on first use', async () => {
    config = {};
    backend(USERS);
    const r = await call('/v1/push/public-key');
    const { publicKey } = await r.json();
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(config.vapid_private_key).toBeTruthy();
  });
});

describe('registration (no full sign-up needed)', () => {
  beforeEach(() => { config = { dispatch_secret: 's'.repeat(64) }; });
  it('creates a confirmed phone-login account', async () => {
    backend(USERS);
    const r = await call('/v1/auth/register', { method: 'POST', json: { fullName: 'Yaw Asante', phone: '024 111 2222', password: 'device-secret-123', guest: true } });
    expect(r.status).toBe(200);
    expect((await r.json()).login).toBe('233241112222@phone.cwc.app');
    const create = calls.find((c) => c.url.pathname === '/auth/v1/admin/users')!;
    expect(create.body).toMatchObject({ email: '233241112222@phone.cwc.app', email_confirm: true, app_metadata: { is_guest: true } });
    expect((create.init.headers as Record<string, string>).Authorization).toBe('Bearer service-key');
  });
  it('validates input', async () => {
    backend(USERS);
    expect((await call('/v1/auth/register', { method: 'POST', json: { fullName: 'A', phone: '0241112222', password: 'longenough' } })).status).toBe(400);
    expect((await call('/v1/auth/register', { method: 'POST', json: { fullName: 'Ama', phone: '12', password: 'longenough' } })).status).toBe(400);
    expect((await call('/v1/auth/register', { method: 'POST', json: { fullName: 'Ama', phone: '0241112222', password: 'short' } })).status).toBe(400);
  });
  it('refuses reserved leader emails', async () => {
    backend(USERS);
    const r = await call('/v1/auth/register', { method: 'POST', json: { fullName: 'Impostor', phone: '0241112222', email: 'christianworshipcentre.ch@gmail.com', password: 'longenough1' } });
    expect(r.status).toBe(409);
    expect(calls.some((c) => c.url.pathname === '/auth/v1/admin/users')).toBe(false);
  });
  it('reports existing accounts clearly', async () => {
    backend(USERS, (c) => (c.url.pathname === '/auth/v1/admin/users' ? Response.json({ msg: 'A user with this email address has already been registered' }, { status: 422 }) : undefined));
    const r = await call('/v1/auth/register', { method: 'POST', json: { fullName: 'Ama Mensah', phone: '0241112222', password: 'longenough1' } });
    expect(r.status).toBe(409);
  });
  it('is rate limited', async () => {
    backend(USERS, (c) => (c.url.pathname === '/rest/v1/rpc/hit_rate_limit' ? Response.json(false) : undefined));
    expect((await call('/v1/auth/register', { method: 'POST', json: {} })).status).toBe(429);
  });
  it('maps phone and email identifiers to logins', () => {
    expect(loginEmailFor('0241234567')).toBe('233241234567@phone.cwc.app');
    expect(loginEmailFor(' Pastor@CWC.org ')).toBe('pastor@cwc.org');
  });
});

describe('staff account administration', () => {
  it('an admin creates a pastor account and the role is set with the admin’s own token', async () => {
    backend(USERS);
    const r = await call('/v1/admin/users', { method: 'POST', as: U.admin, json: { fullName: 'Rev. Kofi', email: 'kofi@cwc.org', password: 'temp-pass-1', role: 'pastor' } });
    expect(r.status).toBe(200);
    const patch = calls.find((c) => c.url.pathname === '/rest/v1/users' && c.init.method === 'PATCH')!;
    expect(patch.body).toEqual({ role: 'pastor' });
    expect((patch.init.headers as Record<string, string>).Authorization).not.toBe('Bearer service-key');
  });
  it('an admin cannot create a super admin or developer', async () => {
    backend(USERS);
    expect((await call('/v1/admin/users', { method: 'POST', as: U.admin, json: { fullName: 'X', email: 'x@cwc.org', password: 'temp-pass-1', role: 'super_admin' } })).status).toBe(403);
    expect((await call('/v1/admin/users', { method: 'POST', as: U.admin, json: { fullName: 'X', email: 'x@cwc.org', password: 'temp-pass-1', role: 'developer' } })).status).toBe(403);
  });
  it('members and pastors cannot manage accounts', async () => {
    backend(USERS);
    expect((await call('/v1/admin/users', { method: 'POST', as: U.member, json: {} })).status).toBe(403);
    expect((await call(`/v1/admin/users/${U.member}/password`, { method: 'POST', as: U.pastor, json: { password: 'newpass123' } })).status).toBe(403);
  });
  it('an admin cannot reset the super admin’s password; the super admin can reset an admin’s', async () => {
    backend(USERS);
    expect((await call(`/v1/admin/users/${U.sa}/password`, { method: 'POST', as: U.admin, json: { password: 'newpass123' } })).status).toBe(403);
    expect((await call(`/v1/admin/users/${U.admin}/password`, { method: 'POST', as: U.sa, json: { password: 'newpass123' } })).status).toBe(200);
  });
  it('never deletes the last super admin', async () => {
    backend(USERS);
    expect((await call(`/v1/me/account`, { method: 'DELETE', as: U.sa })).status).toBe(409);
    expect((await call(`/v1/admin/users/${U.sa}`, { method: 'DELETE', as: U.dev })).status).toBe(403);
  });
});

describe('developer tools', () => {
  it('diagnostics are developer-only and run on demand', async () => {
    backend(USERS);
    config = { vapid_public_key: 'x', vapid_private_key: 'y' };
    expect((await call('/v1/dev/diagnostics', { as: U.admin })).status).toBe(403);
    const r = await call('/v1/dev/diagnostics', { as: U.dev });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ vapid: true, sms: { configured: false } });
  });
});

describe('internal endpoints', () => {
  it('dispatch and daily job require the shared secret', async () => {
    config = { dispatch_secret: 'a'.repeat(64) };
    backend(USERS);
    expect((await call('/v1/push/dispatch', { method: 'POST', json: { id: 'x' } })).status).toBe(401);
    expect((await call('/v1/jobs/daily', { method: 'POST', headers: { 'x-cwc-secret': 'b'.repeat(64) } })).status).toBe(401);
  });
});

describe('SMS proxy', () => {
  it('requires messaging permission and a configured key', async () => {
    config = {};
    backend(USERS);
    expect((await call('/v1/sms/balance', { as: U.member })).status).toBe(403);
    const r = await call('/v1/sms/balance', { as: U.pastor });
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe('not_configured');
  });
  it('relays sends with the stored key and idempotency key', async () => {
    config = { profjero_api_key: 'pk_live_db' };
    backend(USERS, (c) => (c.url.host === 'pj.test' ? Response.json({ batchId: 'b1' }, { status: 202 }) : undefined));
    const r = await call('/v1/sms/send', { method: 'POST', as: U.pastor, headers: { 'Idempotency-Key': 'cwc-12345678' }, json: { message: 'Hello', recipients: ['0241234567', '0241234567', 'x'] } });
    expect(r.status).toBe(202);
    const up = calls.find((c) => c.url.host === 'pj.test')!;
    expect((up.init.headers as Record<string, string>).Authorization).toBe('Bearer pk_live_db');
    expect((up.init.headers as Record<string, string>)['Idempotency-Key']).toBe('cwc-12345678');
    expect((up.body as { recipients: string[] }).recipients).toEqual(['233241234567']);
  });
  it('cleans and validates bodies', () => {
    expect(() => cleanSmsBody({ message: '', recipients: ['0241234567'] })).toThrow();
    expect(() => cleanSmsBody({ message: 'x', recipients: [] })).toThrow();
    const b = cleanSmsBody({ message: 'Hi {first_name}', recipients: [{ phone: '0241234567', fields: { first_name: 'Ama', 'bad key': 'x' } }] }, 'CWC');
    expect(b).toEqual({ message: 'Hi {first_name}', recipients: [{ phone: '233241234567', fields: { first_name: 'Ama' } }], senderId: 'CWC' });
  });
});
