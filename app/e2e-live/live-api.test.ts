/**
 * Live functional & security checks against the real Supabase project, using dedicated
 * "E2E Test" accounts (created beforehand; remove them afterwards). Run with:
 *   LIVE_PASSWORD=... npx vitest run --root e2e-live
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = 'https://myektndhhvbkhvkyireg.supabase.co';
const KEY = 'sb_publishable_ckaho1bHtxr7MWkCmsLNOg_V-9QB47-';
const API = `${URL}/functions/v1/api`;
const PW = process.env.LIVE_PASSWORD ?? '';
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function signedIn(phone: string) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email: `${phone}@phone.cwc.app`, password: PW });
  if (error) throw error;
  return c;
}

let anon: SupabaseClient, u1: SupabaseClient, u2: SupabaseClient, pastor: SupabaseClient, treasurer: SupabaseClient;
let u1Id: string, u2Id: string;

beforeAll(async () => {
  anon = client();
  u1 = await signedIn('233209990011');
  u2 = await signedIn('233209990022');
  pastor = await signedIn('233209990033');
  treasurer = await signedIn('233209990044');
  u1Id = (await u1.auth.getUser()).data.user!.id;
  u2Id = (await u2.auth.getUser()).data.user!.id;
}, 30000);

describe('visitors (no account)', () => {
  it('can read the church profile and published content', async () => {
    expect((await anon.from('settings').select('id')).data).toHaveLength(1);
    expect((await anon.from('events').select('id')).error).toBeNull();
  });
  it('cannot read people, accounts, giving or care', async () => {
    for (const t of ['members', 'users', 'gifts', 'care_requests', 'audit_logs', 'roles']) {
      const { data, error } = await anon.from(t).select('*').limit(1);
      expect(error ?? (data ?? []).length === 0).toBeTruthy();
      expect(data ?? []).toHaveLength(0);
    }
  });
  it('cannot call privileged functions', async () => {
    expect((await anon.rpc('dev_system_health')).error).not.toBeNull();
    expect((await anon.rpc('server_config', { p_keys: ['dispatch_secret'] })).error).not.toBeNull();
    expect((await anon.rpc('complete_profile', { p: {} })).error).not.toBeNull();
  });
  it('can read the sanitised prayer wall', async () => {
    const { data, error } = await anon.rpc('get_prayer_wall', { p_key: 'e2e-device-key-123456', p_limit: 5 });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('complete-profile flow', () => {
  it('creates a pending member record linked to the account', async () => {
    const { data: mid, error } = await u1.rpc('complete_profile', { p: { firstName: 'E2E Test', lastName: 'User1', phone: '0209990011', membershipStatus: 'first_timer' } });
    expect(error).toBeNull();
    const { data: me } = await u1.from('members').select('id, verified, self_registered').eq('id', mid).single();
    expect(me).toMatchObject({ verified: false, self_registered: true });
    expect((await u1.from('members').select('id')).data).toHaveLength(1);
  });
  it('another member cannot see it', async () => {
    expect((await u2.from('members').select('id')).data).toHaveLength(0);
  });
  it('the member cannot promote themselves or verify their record', async () => {
    const r = await u1.from('users').update({ role: 'admin' }).eq('id', u1Id).select('role');
    expect(r.error).not.toBeNull();
    const mid = (await u1.from('users').select('member_id').eq('id', u1Id).single()).data!.member_id;
    expect((await u1.from('members').update({ verified: true }).eq('id', mid).select('id')).error).not.toBeNull();
  });
  it('pastors were notified about the new person', async () => {
    const { data } = await pastor.from('notifications').select('title').eq('target_perm', 'people.manage').ilike('body', '%E2E Test%');
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});

describe('care requests', () => {
  let reqId: string;
  it('a member sends a private request; only they and the pastor see it', async () => {
    const { error } = await u1.from('care_requests').insert({ type: 'counselling', name: 'E2E Test User1', details: 'E2E test — please ignore' });
    expect(error).toBeNull();
    const mine = await u1.from('care_requests').select('id, status').eq('uid', u1Id);
    reqId = mine.data![0].id;
    expect((await u2.from('care_requests').select('id').eq('id', reqId)).data).toHaveLength(0);
    expect((await treasurer.from('care_requests').select('id').eq('id', reqId)).data).toHaveLength(0);
    expect((await pastor.from('care_requests').select('id').eq('id', reqId)).data).toHaveLength(1);
  });
  it('the pastor replies and the member is notified', async () => {
    expect((await pastor.rpc('add_care_response', { p_id: reqId, p_text: 'E2E reply' })).error).toBeNull();
    const n = await u1.from('notifications').select('title, url').eq('target_uid', u1Id);
    expect(n.data!.some((x) => x.url === `/care/${reqId}`)).toBe(true);
    expect((await u2.from('notifications').select('id').eq('target_uid', u1Id)).data).toHaveLength(0);
  });
  it('the member cannot change the status directly', async () => {
    const r = await u1.from('care_requests').update({ status: 'completed' }).eq('id', reqId).select('id');
    expect(r.error !== null || (r.data ?? []).length === 0).toBe(true);
  });
});

describe('roles', () => {
  it('a pastor cannot view giving edits or manage accounts', async () => {
    const r = await pastor.from('users').update({ role: 'admin' }).eq('id', u2Id).select('id');
    expect(r.error !== null || (r.data ?? []).length === 0).toBe(true);
  });
  it('a treasurer cannot read care, a member cannot read gifts of others', async () => {
    expect((await treasurer.from('care_requests').select('id')).data).toHaveLength(0);
    expect((await u2.from('gifts').select('id')).data).toHaveLength(0);
  });
  it('the developer console is locked to developers', async () => {
    expect((await pastor.rpc('dev_system_health')).error).not.toBeNull();
  });
});

describe('API Edge Function', () => {
  it('rejects staff admin calls from non-admins', async () => {
    const t = (await pastor.auth.getSession()).data.session!.access_token;
    const r = await fetch(`${API}/v1/admin/users`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });
  it('rejects forged tokens', async () => {
    const r = await fetch(`${API}/v1/push/test`, { method: 'POST', headers: { Authorization: 'Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6IngifQ.eyJzdWIiOiJ4In0.AAAA' } });
    expect(r.status).toBe(401);
  });
  it('refuses reserved leader emails at registration', async () => {
    const r = await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Impostor', phone: '0209990099', email: 'christianworshipcentre.ch@gmail.com', password: 'longenough123' }) });
    expect(r.status).toBe(409);
  });
  it('SMS proxy needs messaging permission', async () => {
    const t = (await u2.auth.getSession()).data.session!.access_token;
    expect((await fetch(`${API}/v1/sms/balance`, { headers: { Authorization: `Bearer ${t}` } })).status).toBe(403);
  });
});
