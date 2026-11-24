import type { Env } from './env.ts';
import { Supa } from './supa.ts';
import { b64urlDecode, HttpError, utf8 } from './util.ts';

export interface Caller {
  uid: string;
  token: string;
  role: string;
  permissions: string[];
  name: string;
  isGuest: boolean;
}

let jwksCache: { url: string; keys: Record<string, CryptoKey>; expires: number } | null = null;

async function getKeys(env: Env): Promise<Record<string, CryptoKey>> {
  const url = `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  if (jwksCache && jwksCache.url === url && jwksCache.expires > Date.now()) return jwksCache.keys;
  const res = await fetch(url, { headers: { apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY } });
  if (!res.ok) throw new HttpError(503, 'Could not fetch token signing keys');
  const body = (await res.json()) as { keys: (JsonWebKey & { kid: string; alg?: string })[] };
  const keys: Record<string, CryptoKey> = {};
  for (const k of body.keys ?? []) {
    if (k.kty === 'EC' && k.crv === 'P-256') {
      keys[k.kid] = await crypto.subtle.importKey('jwk', { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } else if (k.kty === 'RSA') {
      keys[k.kid] = await crypto.subtle.importKey('jwk', { kty: k.kty, n: k.n, e: k.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    }
  }
  jwksCache = { url, keys, expires: Date.now() + 10 * 60_000 };
  return keys;
}

export function decodeJwt(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed token');
  const dec = new TextDecoder();
  try {
    const header = JSON.parse(dec.decode(b64urlDecode(parts[0]))) as { alg: string; kid?: string };
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as Record<string, unknown>;
    return { header, payload, signed: utf8(`${parts[0]}.${parts[1]}`), signature: b64urlDecode(parts[2]) };
  } catch {
    throw new HttpError(401, 'Malformed token');
  }
}

/** Verifies a Supabase access token (ES256/RS256 via JWKS; falls back to the Auth server for legacy HS256). */
export async function verifyAccessToken(token: string, env: Env, keysOverride?: Record<string, CryptoKey>): Promise<{ uid: string; claims: Record<string, unknown> }> {
  const { header, payload, signed, signature } = decodeJwt(token);
  const now = Math.floor(Date.now() / 1000);
  if (header.alg === 'ES256' || header.alg === 'RS256') {
    const keys = keysOverride ?? (await getKeys(env));
    const key = header.kid ? keys[header.kid] : undefined;
    if (!key) throw new HttpError(401, 'Unknown signing key');
    const algo = header.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
    const ok = await crypto.subtle.verify(algo, key, signature, signed);
    if (!ok) throw new HttpError(401, 'Invalid token signature');
  } else if (header.alg === 'HS256' && !keysOverride) {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  } else {
    throw new HttpError(401, 'Invalid token algorithm');
  }
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  if (payload.role !== 'authenticated') throw new HttpError(401, 'Sign in required');
  const iss = String(payload.iss ?? '');
  if (!iss.startsWith(env.SUPABASE_URL)) throw new HttpError(401, 'Token is for a different project');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new HttpError(401, 'Invalid token subject');
  return { uid: payload.sub, claims: payload };
}

export function bearer(req: Request) {
  const header = req.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/** Authenticates the request and loads the caller's role and permissions. */
export async function authenticate(req: Request, env: Env): Promise<Caller> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'Sign in required');
  const { uid } = await verifyAccessToken(token, env);
  const rows = await new Supa(env).select<{ id: string; full_name: string; role: string; is_active: boolean; is_guest: boolean; roles: { permissions: string[] } | null }>(
    'users',
    `id=eq.${encodeURIComponent(uid)}&select=id,full_name,role,is_active,is_guest,roles(permissions)`,
  );
  const p = rows[0];
  if (!p) throw new HttpError(403, 'No profile for this account');
  if (!p.is_active) throw new HttpError(403, 'Your account has been deactivated');
  return { uid, token, role: p.role, permissions: p.roles?.permissions ?? [], name: p.full_name, isGuest: p.is_guest };
}

export function requirePerm(caller: Caller, ...anyOf: string[]) {
  if (!anyOf.some((p) => caller.permissions.includes(p))) throw new HttpError(403, 'Your role does not allow this action');
}

/** Can `caller` manage the account `target` (same rules as the database guard)? */
export function canManage(caller: Caller, targetRole: string, targetPerms: string[]) {
  if (!caller.permissions.includes('users.manage')) return false;
  if (!targetPerms.every((p) => caller.permissions.includes(p))) return false;
  if (targetRole === 'super_admin' && caller.role !== 'super_admin') return false;
  return true;
}
