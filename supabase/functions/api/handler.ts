/**
 * Christian Worship Centre API — Supabase Edge Function
 *  - account creation (phone or email, device "guest" accounts), staff account admin
 *  - ProfJero Connect SMS proxy (secret key stays server-side)
 *  - Web Push fan-out (triggered by the database via pg_net)
 *  - daily jobs and on-demand developer diagnostics
 * Crafted by ProfJero.
 */
import { DEFAULT_ORIGINS, type Env } from './env.ts';
import { authenticate, canManage, requirePerm, type Caller } from './auth.ts';
import { cleanSmsBody, normalizeList, pj } from './profjero.ts';
import { dispatchNotification, ensureVapid } from './push.ts';
import { dailyJob } from './jobs.ts';
import { Supa, serverConfig } from './supa.ts';
import { sendWebPush } from './webpush.ts';
import { HttpError, normalizePhone } from './util.ts';

export const VERSION = '2.0.0';
export const PHONE_DOMAIN = 'phone.cwc.app';

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  // Cloudflare Pages preview deployments: https://<hash>.cwc-ch.pages.dev
  const ok = allowed.includes('*') || allowed.includes(origin) || /^https:\/\/[a-z0-9-]+\.cwc-ch\.pages\.dev$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : allowed[0] ?? '',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, apikey, x-client-info',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
}

function errorJson(status: number, code: string, message: string) {
  return json({ error: { code, message, requestId: crypto.randomUUID() } }, status);
}

async function relay(res: Response, transform?: (body: unknown) => unknown) {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: { code: `http_${res.status}`, message: text.slice(0, 300) || 'Unexpected response from SMS provider' } };
  }
  const extra: Record<string, string> = {};
  const ra = res.headers.get('retry-after');
  if (ra) extra['Retry-After'] = ra;
  return json(res.ok && transform ? transform(body) : body, res.status, extra);
}

async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function clientIp(req: Request) {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
}

async function rateLimit(env: Env, bucket: string, max: number, windowSeconds: number) {
  const ok = await new Supa(env).rpc<boolean>('hit_rate_limit', { p_bucket: bucket, p_max: max, p_window_seconds: windowSeconds });
  if (!ok) throw new HttpError(429, 'Too many attempts. Please wait a little and try again.', 'rate_limited');
}

/** Constant-time string comparison for shared secrets. */
function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function requireDispatchSecret(req: Request, env: Env) {
  const cfg = await serverConfig(env);
  if (!safeEqual(req.headers.get('x-cwc-secret') ?? '', cfg.dispatch_secret ?? '')) throw new HttpError(401, 'Unauthorized');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function loginEmailFor(identifier: string) {
  const v = identifier.trim();
  if (v.includes('@')) return v.toLowerCase();
  const p = normalizePhone(v);
  return p ? `${p}@${PHONE_DOMAIN}` : v.toLowerCase();
}

/* ---------------- accounts ---------------- */

interface RegisterInput {
  fullName?: string;
  phone?: string;
  email?: string;
  password?: string;
  guest?: boolean;
}

async function register(req: Request, env: Env) {
  const ip = clientIp(req);
  await rateLimit(env, `register:ip:${ip}`, 8, 3600);
  await rateLimit(env, 'register:global', 300, 3600);
  const b = await readJson<RegisterInput>(req);
  const fullName = String(b.fullName ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const phone = normalizePhone(b.phone);
  const email = String(b.email ?? '').trim().toLowerCase();
  const password = String(b.password ?? '');
  if (fullName.length < 2) throw new HttpError(400, 'Please enter your name', 'invalid_name');
  if (!/^\d{9,15}$/.test(phone)) throw new HttpError(400, 'Please enter a valid phone number', 'invalid_phone');
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address', 'invalid_email');
  if (password.length < 8) throw new HttpError(400, 'Choose a password of at least 8 characters', 'weak_password');
  if (email && (await new Supa(env).rpc<boolean>('server_email_reserved', { p_email: email }))) {
    throw new HttpError(409, 'This email is reserved for a church leader’s account. Please sign in instead.', 'reserved');
  }
  const login = email || `${phone}@${PHONE_DOMAIN}`;
  try {
    await new Supa(env).createUser({
      email: login,
      password,
      user_metadata: { full_name: fullName, phone },
      app_metadata: { is_guest: Boolean(b.guest) },
    });
  } catch (e) {
    const msg = (e as Error).message.toLowerCase();
    if (msg.includes('already') || msg.includes('exists') || (e as HttpError).status === 422) {
      throw new HttpError(409, email ? 'An account already exists with this email. Try signing in.' : 'This phone number already has an account. Try signing in.', 'exists');
    }
    throw e;
  }
  return json({ ok: true, login });
}

async function adminCreateUser(caller: Caller, req: Request, env: Env) {
  requirePerm(caller, 'users.manage');
  const b = await readJson<{ fullName?: string; email?: string; phone?: string; password?: string; role?: string; mustChangePassword?: boolean }>(req);
  const fullName = String(b.fullName ?? '').trim().slice(0, 120);
  const email = String(b.email ?? '').trim().toLowerCase();
  const phone = normalizePhone(b.phone);
  const password = String(b.password ?? '');
  const role = String(b.role ?? 'member');
  if (!fullName) throw new HttpError(400, 'Name is required');
  if (!email && !phone) throw new HttpError(400, 'Enter an email or phone number');
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'Invalid email address');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const db = new Supa(env);
  if (email && (await db.rpc<boolean>('server_email_reserved', { p_email: email }))) throw new HttpError(409, 'This email is reserved for a seeded leader account', 'reserved');
  const [r] = await db.select<{ key: string; permissions: string[] }>('roles', `key=eq.${encodeURIComponent(role)}&select=key,permissions`);
  if (!r) throw new HttpError(400, 'Unknown role');
  if (!canManage(caller, r.key, r.permissions)) throw new HttpError(403, 'You cannot grant a role with permissions you do not hold');

  let created: { id: string };
  try {
    created = await db.createUser({
      email: email || `${phone}@${PHONE_DOMAIN}`,
      password,
      user_metadata: { full_name: fullName, phone },
      app_metadata: { must_change_password: b.mustChangePassword !== false },
    });
  } catch (e) {
    if ((e as Error).message.toLowerCase().includes('already')) throw new HttpError(409, 'An account already exists with these details', 'exists');
    throw e;
  }
  if (role !== 'member') {
    try {
      // As the caller, so the database guard re-checks the grant.
      await new Supa(env, caller.token).update('users', `id=eq.${created.id}`, { role });
    } catch (e) {
      await db.deleteUser(created.id).catch(() => {});
      throw e;
    }
  }
  await new Supa(env, caller.token).insert('audit_logs', { action: 'create', entity: 'users', entity_id: created.id, summary: `Created account for ${fullName} (${role})`, by_name: caller.name }, false).catch(() => {});
  return json({ ok: true, id: created.id });
}

async function loadTarget(env: Env, uid: string) {
  const [t] = await new Supa(env).select<{ id: string; role: string; full_name: string; roles: { permissions: string[] } | null; is_active: boolean }>(
    'users', `id=eq.${encodeURIComponent(uid)}&select=id,role,full_name,is_active,roles(permissions)`,
  );
  if (!t) throw new HttpError(404, 'User not found');
  return t;
}

async function lastSuperAdmin(env: Env, uid: string) {
  const sas = await new Supa(env).select<{ id: string }>('users', 'role=eq.super_admin&is_active=eq.true&select=id');
  return sas.length === 1 && sas[0].id === uid;
}

export function randomPassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function bootstrapSeeded(env: Env) {
  const db = new Supa(env);
  const seeds = await db.rpc<{ email: string; role: string }[]>('server_role_seeds');
  const out: { email: string; role: string; status: string; temporaryPassword?: string }[] = [];
  for (const s of seeds ?? []) {
    const existing = await db.select<{ id: string; role: string }>('users', `email=eq.${encodeURIComponent(s.email)}&select=id,role`);
    if (existing.length) {
      out.push({ email: s.email, role: existing[0].role, status: 'exists' });
      continue;
    }
    const temporaryPassword = randomPassword();
    await db.createUser({
      email: s.email,
      password: temporaryPassword,
      user_metadata: { full_name: s.role === 'super_admin' ? 'Christian Worship Centre' : s.role === 'developer' ? 'ProfJero (Developer)' : '' },
      app_metadata: { must_change_password: true },
    });
    out.push({ email: s.email, role: s.role, status: 'created', temporaryPassword });
  }
  return out;
}

/* ---------------- router ---------------- */

export async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  // Supabase routes /functions/v1/api/<path>; accept both forms.
  const path = url.pathname.replace(/^.*?\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/';
  const m = req.method;

  /* Public */
  if (path === '/' || path === '/v1/health') {
    const cfg = await serverConfig(env).catch(() => ({} as Record<string, string>));
    return json({ ok: true, name: 'CWC API', version: VERSION, sms: Boolean(env.PROFJERO_API_KEY || cfg.profjero_api_key), push: true, by: 'ProfJero' });
  }
  if (path === '/v1/push/public-key' && m === 'GET') {
    const v = await ensureVapid(env);
    return json({ publicKey: v.publicKey }, 200, { 'Cache-Control': 'public, max-age=3600' });
  }
  if (path === '/v1/sms/pricing' && m === 'GET') return relay(await pj(undefined, env.PROFJERO_BASE_URL, '/v1/pricing', { auth: false }));
  if (path === '/v1/auth/register' && m === 'POST') return register(req, env);

  /* Database → function (shared secret) */
  if (path === '/v1/push/dispatch' && m === 'POST') {
    await requireDispatchSecret(req, env);
    const { id, offset } = await readJson<{ id?: string; offset?: number }>(req);
    if (!id) throw new HttpError(400, 'id is required');
    let r = await dispatchNotification(env, id, Number(offset) || 0);
    const total = { ...r };
    // Continue in-process for a few pages; very large audiences chain another invocation.
    for (let i = 0; r.next !== null && i < 3; i++) {
      r = await dispatchNotification(env, id, r.next);
      total.sent += r.sent; total.failed += r.failed; total.removed += r.removed; total.total += r.total; total.next = r.next;
    }
    if (total.next !== null) {
      const cfg = await serverConfig(env);
      fetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cwc-secret': cfg.dispatch_secret }, body: JSON.stringify({ id, offset: total.next }) }).catch(() => {});
    }
    return json(total);
  }
  if (path === '/v1/jobs/daily' && m === 'POST') {
    await requireDispatchSecret(req, env);
    return json(await dailyJob(env));
  }
  if (path === '/v1/admin/bootstrap' && m === 'POST') {
    // Pre-creates accounts for seeded leader emails (super admin, developer) so nobody else can claim them.
    await requireDispatchSecret(req, env);
    return json({ accounts: await bootstrapSeeded(env) });
  }

  /* Signed-in */
  const caller = await authenticate(req, env);
  const cfg = await serverConfig(env);
  const smsKey = env.PROFJERO_API_KEY || cfg.profjero_api_key;

  if (path === '/v1/push/test' && m === 'POST') {
    const vapid = await ensureVapid(env);
    const subs = await new Supa(env).select<{ id: string; endpoint: string; p256dh: string; auth: string }>('push_subscriptions', `uid=eq.${caller.uid}&select=id,endpoint,p256dh,auth`);
    if (!subs.length) throw new HttpError(404, 'This account has no devices with notifications turned on yet.');
    const res = await Promise.all(subs.map((s) => sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, { title: 'Notifications are working 🎉', body: 'You will now hear from Christian Worship Centre.', url: '/notifications', tag: 'test' }, vapid)));
    return json({ devices: subs.length, delivered: res.filter((r) => r.status >= 200 && r.status < 300).length });
  }

  if (path === '/v1/me/account' && m === 'DELETE') {
    if (await lastSuperAdmin(env, caller.uid)) throw new HttpError(409, 'You are the only super admin. Make someone else super admin first.');
    await new Supa(env).deleteUser(caller.uid);
    return json({ ok: true });
  }

  if (path === '/v1/admin/users' && m === 'POST') return adminCreateUser(caller, req, env);

  const userMatch = path.match(/^\/v1\/admin\/users\/([0-9a-f-]{36})(\/password)?$/);
  if (userMatch) {
    requirePerm(caller, 'users.manage');
    const target = await loadTarget(env, userMatch[1]);
    if (!canManage(caller, target.role, target.roles?.permissions ?? [])) throw new HttpError(403, 'This account has permissions you do not hold');
    if (userMatch[2] && m === 'POST') {
      const { password } = await readJson<{ password?: string }>(req);
      if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
      await new Supa(env).updateUser(target.id, { password, app_metadata: { must_change_password: true } });
      await new Supa(env).update('users', `id=eq.${target.id}`, { must_change_password: true });
      await new Supa(env, caller.token).insert('audit_logs', { action: 'update', entity: 'users', entity_id: target.id, summary: `Reset password for ${target.full_name}`, by_name: caller.name }, false).catch(() => {});
      return json({ ok: true });
    }
    if (!userMatch[2] && m === 'DELETE') {
      if (target.id === caller.uid) throw new HttpError(400, 'You cannot delete your own account here');
      if (await lastSuperAdmin(env, target.id)) throw new HttpError(409, 'There must always be at least one super admin');
      await new Supa(env, caller.token).insert('audit_logs', { action: 'delete', entity: 'users', entity_id: target.id, summary: `Removed account ${target.full_name}`, by_name: caller.name }, false).catch(() => {});
      await new Supa(env).deleteUser(target.id);
      return json({ ok: true });
    }
  }

  /* Developer tools (on demand only) */
  if (path === '/v1/dev/diagnostics' && m === 'GET') {
    requirePerm(caller, 'system.monitor');
    const t0 = Date.now();
    await new Supa(env).select('settings', 'select=id&limit=1');
    const dbMs = Date.now() - t0;
    let sms: unknown = { configured: Boolean(smsKey) };
    if (smsKey) {
      const t1 = Date.now();
      const r = await pj(smsKey, env.PROFJERO_BASE_URL, '/v1/balance').catch((e) => e as Error);
      sms = r instanceof Response ? { configured: true, ok: r.ok, status: r.status, ms: Date.now() - t1, balance: r.ok ? await r.json().catch(() => null) : null } : { configured: true, ok: false, error: (r as Error).message };
    }
    const vapid = await ensureVapid(env).then(() => true).catch(() => false);
    return json({ version: VERSION, region: (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get('SB_REGION') ?? null, dbRoundTripMs: dbMs, vapid, sms, at: new Date().toISOString() });
  }
  if (path === '/v1/dev/run-job' && m === 'POST') {
    requirePerm(caller, 'system.monitor');
    const { job } = await readJson<{ job?: string }>(req);
    if (job !== 'daily') throw new HttpError(400, 'Unknown job');
    return json(await dailyJob(env, new Date(), { force: true }));
  }

  /* SMS */
  if (path.startsWith('/v1/sms/')) requirePerm(caller, 'messaging.sms');
  if (path === '/v1/sms/send' && m === 'POST') {
    const body = cleanSmsBody(await readJson(req), env.PROFJERO_SENDER_ID);
    const key = req.headers.get('idempotency-key') || `cwc-${crypto.randomUUID()}`;
    if (key.length < 8 || key.length > 120) throw new HttpError(400, 'Idempotency-Key must be 8–120 characters');
    return relay(await pj(smsKey, env.PROFJERO_BASE_URL, '/v1/sms/send', { method: 'POST', body, idempotencyKey: key }));
  }
  if (path === '/v1/sms/estimate' && m === 'POST') return relay(await pj(smsKey, env.PROFJERO_BASE_URL, '/v1/sms/estimate', { method: 'POST', body: cleanSmsBody(await readJson(req), undefined, true) }));
  const qs = (keys: string[]) => {
    const p = new URLSearchParams();
    keys.forEach((k) => url.searchParams.get(k) && p.set(k, url.searchParams.get(k)!));
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const P = (p: string, init?: Parameters<typeof pj>[3]) => pj(smsKey, env.PROFJERO_BASE_URL, p, init);
  if (path === '/v1/sms/balance' && m === 'GET') return relay(await P('/v1/balance'));
  if (path === '/v1/sms/wallet' && m === 'GET') return relay(await P('/v1/wallet'));
  if (path === '/v1/sms/transactions' && m === 'GET') return relay(await P(`/v1/wallet/transactions${qs(['limit', 'before'])}`), (b) => normalizeList(b, 'transactions'));
  if (path === '/v1/sms/sender-ids' && m === 'GET') return relay(await P('/v1/sender-ids'));
  if (path === '/v1/sms/batches' && m === 'GET') return relay(await P(`/v1/sms/batches${qs(['limit', 'before'])}`));
  if (path.startsWith('/v1/sms/batches/') && m === 'GET') return relay(await P(`/v1/sms/batches/${encodeURIComponent(path.split('/')[4])}`));
  if (path === '/v1/sms/campaigns' && m === 'GET') return relay(await P('/v1/campaigns'), (b) => normalizeList(b, 'campaigns'));
  if (/^\/v1\/sms\/campaigns\/[^/]+\/cancel$/.test(path) && m === 'POST') return relay(await P(`/v1/campaigns/${encodeURIComponent(path.split('/')[4])}/cancel`, { method: 'POST' }));
  if (path === '/v1/sms/payments' && m === 'GET') return relay(await P(`/v1/payments${qs(['limit'])}`), (b) => normalizeList(b, 'payments'));
  if (path.startsWith('/v1/sms/payments/') && m === 'GET') return relay(await P(`/v1/payments/${encodeURIComponent(path.split('/')[4])}`));
  if (path === '/v1/sms/payments' && m === 'POST') {
    const b = await readJson(req);
    const body: Record<string, unknown> = {};
    if (typeof b.packageId === 'string') body.packageId = b.packageId;
    else if (Number.isInteger(b.units) && (b.units as number) > 0) body.units = b.units;
    else throw new HttpError(400, 'Choose a package or a number of units');
    if (typeof b.email === 'string' && b.email.includes('@')) body.email = b.email;
    if (typeof b.callbackUrl === 'string' && b.callbackUrl.startsWith('https://')) body.callbackUrl = b.callbackUrl;
    if (b.method === 'mobile_money' || b.method === 'card') body.method = b.method;
    const key = req.headers.get('idempotency-key') || `topup-${crypto.randomUUID()}`;
    return relay(await P('/v1/payments', { method: 'POST', body, idempotencyKey: key }));
  }

  throw new HttpError(404, 'Not found');
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let res: Response;
  try {
    res = await route(req, env);
  } catch (e) {
    if (e instanceof HttpError) res = errorJson(e.status, e.code, e.message);
    else {
      console.error('[cwc-api]', e);
      res = errorJson(500, 'internal', 'Something went wrong. Please retry.');
    }
  }
  const headers = new Headers(res.headers);
  Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
  return new Response(res.body, { status: res.status, headers });
}
