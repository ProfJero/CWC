import type { Env } from './env.ts';
import { Supa, serverConfig, resetConfigCache } from './supa.ts';
import { sendWebPush, type PushSub } from './webpush.ts';
import { b64urlEncode, HttpError } from './util.ts';

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** Returns the VAPID key pair, generating and storing one on first use (no manual setup needed). */
export async function ensureVapid(env: Env): Promise<Vapid> {
  let cfg = await serverConfig(env);
  if (!cfg.vapid_public_key || !cfg.vapid_private_key) {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = b64urlEncode(new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer));
    const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
    const db = new Supa(env);
    // Store the private key first; if another isolate raced us, both calls return the winner's values.
    const priv = await db.rpc<string>('server_set_config', { p_key: 'vapid_private_key', p_value: jwk.d });
    if (priv === jwk.d) await db.rpc('server_set_config', { p_key: 'vapid_public_key', p_value: pub, p_overwrite: true });
    resetConfigCache();
    cfg = await serverConfig(env, true);
  }
  return { publicKey: cfg.vapid_public_key, privateKey: cfg.vapid_private_key, subject: env.VAPID_SUBJECT || 'mailto:christianworshipcentre.ch@gmail.com' };
}

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  url: string | null;
  image_url: string | null;
  kind: string;
  audience: 'all' | 'user' | 'perm';
  target_uid: string | null;
  target_perm: string | null;
  send_push: boolean;
}

interface SubRow {
  id: string;
  uid: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const PAGE = 250;

/** People who switched push off (globally or for this kind). */
async function optedOut(db: Supa, kind: string): Promise<Set<string>> {
  const rows = await db.select<{ id: string; notification_prefs: { push?: boolean; kinds?: Record<string, boolean> } }>(
    'users',
    `select=id,notification_prefs&or=(notification_prefs->>push.eq.false,notification_prefs->kinds->>${encodeURIComponent(kind)}.eq.false)`,
  );
  return new Set(rows.map((r) => r.id));
}

async function targetUids(db: Supa, n: NotificationRow): Promise<string[] | null> {
  if (n.audience === 'all') return null;
  if (n.audience === 'user') return n.target_uid ? [n.target_uid] : [];
  const roles = await db.select<{ key: string }>('roles', `select=key&permissions=cs.${encodeURIComponent(`{${n.target_perm}}`)}`);
  if (!roles.length) return [];
  const users = await db.select<{ id: string }>('users', `select=id&is_active=eq.true&role=in.(${roles.map((r) => encodeURIComponent(r.key)).join(',')})`);
  return users.map((u) => u.id);
}

export interface DispatchResult {
  sent: number;
  failed: number;
  removed: number;
  total: number;
  next: number | null;
}

/** Sends one page of web pushes for a notification. Large audiences continue with `offset`. */
export async function dispatchNotification(env: Env, id: string, offset = 0): Promise<DispatchResult> {
  const db = new Supa(env);
  const [n] = await db.select<NotificationRow>('notifications', `id=eq.${encodeURIComponent(id)}&select=*`);
  if (!n) throw new HttpError(404, 'Notification not found');
  if (!n.send_push) return { sent: 0, failed: 0, removed: 0, total: 0, next: null };
  const vapid = await ensureVapid(env);
  const uids = await targetUids(db, n);
  if (uids && uids.length === 0) return { sent: 0, failed: 0, removed: 0, total: 0, next: null };

  let q = `select=id,uid,endpoint,p256dh,auth&order=id&limit=${PAGE}&offset=${offset}`;
  if (uids) q += `&uid=in.(${uids.slice(0, 500).join(',')})`;
  const subs = await db.select<SubRow>('push_subscriptions', q);
  const skip = await optedOut(db, n.kind);
  const targets = subs.filter((s) => !(s.uid && skip.has(s.uid)));

  const payload = {
    title: n.title.slice(0, 120),
    body: n.body.slice(0, 300),
    url: n.url && n.url.startsWith('/') ? n.url : '/notifications',
    image: n.image_url ?? undefined,
    tag: n.kind,
    id: n.id,
  };
  const results: { id: string; status: number; gone: boolean }[] = [];
  for (let i = 0; i < targets.length; i += 25) {
    const batch = targets.slice(i, i + 25);
    results.push(
      ...(await Promise.all(
        batch.map((s) =>
          sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } } as PushSub, payload, { ...vapid, topic: n.kind, urgency: n.kind === 'care' ? 'high' : 'normal' }).then((r) => ({ id: s.id, ...r })),
        ),
      )),
    );
  }
  const ok = results.filter((r) => r.status >= 200 && r.status < 300);
  const gone = results.filter((r) => r.gone);
  if (gone.length) await db.delete('push_subscriptions', `id=in.(${gone.map((g) => g.id).join(',')})`);
  if (ok.length) await db.update('push_subscriptions', `id=in.(${ok.map((g) => g.id).join(',')})`, { last_success_at: new Date().toISOString() });

  const page = { sent: ok.length, failed: results.length - ok.length, removed: gone.length, total: results.length };
  const prev = ((await db.select<{ push: DispatchResult | null }>('notifications', `id=eq.${id}&select=push`))[0]?.push ?? null) as DispatchResult | null;
  const sum = offset > 0 && prev ? { sent: prev.sent + page.sent, failed: prev.failed + page.failed, removed: prev.removed + page.removed, total: prev.total + page.total } : page;
  await db.update('notifications', `id=eq.${id}`, { push: { ...sum, at: new Date().toISOString() } });
  return { ...page, next: subs.length === PAGE ? offset + PAGE : null };
}
