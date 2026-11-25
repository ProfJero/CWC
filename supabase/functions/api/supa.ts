import type { Env } from './env.ts';
import { HttpError } from './util.ts';

/**
 * Minimal Supabase REST client (PostgREST + Auth admin). Runs either as the service role
 * (server-side jobs) or with the caller's own token so RLS applies.
 */
export class Supa {
  constructor(private env: Env, private token?: string) {}

  private headers(extra: Record<string, string> = {}) {
    const key = this.token ? this.env.SUPABASE_ANON_KEY || this.env.SUPABASE_SERVICE_ROLE_KEY : this.env.SUPABASE_SERVICE_ROLE_KEY;
    return {
      apikey: key,
      Authorization: `Bearer ${this.token ?? this.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private async send<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
    const res = await fetch(`${this.env.SUPABASE_URL}${path}`, {
      ...init,
      headers: this.headers(init.prefer ? { Prefer: init.prefer } : {}),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const b = body as { message?: string; msg?: string; error_description?: string; code?: string; error_code?: string } | null;
      const message = b?.message || b?.msg || b?.error_description || `Request failed (${res.status})`;
      const status = res.status === 401 || res.status === 403 ? 403 : res.status >= 500 ? 502 : res.status;
      throw new HttpError(status, message, b?.code || b?.error_code || `db_${res.status}`);
    }
    return body as T;
  }

  select<T = Record<string, unknown>>(table: string, query: string) {
    return this.send<T[]>(`/rest/v1/${table}?${query}`);
  }
  insert<T = Record<string, unknown>>(table: string, rows: unknown, returning = true) {
    return this.send<T[]>(`/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(rows), prefer: returning ? 'return=representation' : 'return=minimal' });
  }
  update<T = Record<string, unknown>>(table: string, query: string, patch: unknown) {
    return this.send<T[]>(`/rest/v1/${table}?${query}`, { method: 'PATCH', body: JSON.stringify(patch), prefer: 'return=representation' });
  }
  delete(table: string, query: string) {
    return this.send<null>(`/rest/v1/${table}?${query}`, { method: 'DELETE', prefer: 'return=minimal' });
  }
  rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}) {
    return this.send<T>(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  }

  /* Auth admin (service role only) */
  createUser(input: { email: string; password: string; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown> }) {
    return this.send<{ id: string; email: string }>(`/auth/v1/admin/users`, {
      method: 'POST',
      body: JSON.stringify({ ...input, email_confirm: true }),
    });
  }
  updateUser(id: string, patch: Record<string, unknown>) {
    return this.send<{ id: string }>(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });
  }
  deleteUser(id: string) {
    return this.send<unknown>(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

/* Server-side configuration stored in private.app_config (cached briefly per isolate). */
let configCache: { at: number; values: Record<string, string> } | null = null;
const CONFIG_KEYS = ['vapid_public_key', 'vapid_private_key', 'dispatch_secret', 'profjero_api_key'];

export async function serverConfig(env: Env, fresh = false): Promise<Record<string, string>> {
  if (!fresh && configCache && Date.now() - configCache.at < 60_000) return configCache.values;
  const values = await new Supa(env).rpc<Record<string, string>>('server_config', { p_keys: CONFIG_KEYS });
  configCache = { at: Date.now(), values: values ?? {} };
  return configCache.values;
}

export function resetConfigCache() {
  configCache = null;
}
