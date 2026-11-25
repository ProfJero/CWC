/**
 * Security & functional tests for the database layer: RLS policies, guard triggers,
 * counters and RPCs — run against a real Postgres with the production migrations.
 *
 *   npm run db:test       (needs local Postgres; see supabase/tests/README.md)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
// @ts-expect-error — plain ESM helper
import { resetLocal } from './reset-local.mjs';

const cfg = { host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || 'postgres', database: process.env.PGDATABASE_TEST || 'cwc_test' };
let db: pg.Client;

type Who = { id: string } | null; // null = anonymous visitor

/** Runs SQL exactly as PostgREST would for this caller (role + JWT claims), inside a rolled-back transaction. */
async function as<T = Record<string, unknown>>(who: Who, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.query('begin');
  try {
    if (who) {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: who.id, role: 'authenticated' })]);
      await db.query('set local role authenticated');
    } else {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })]);
      await db.query('set local role anon');
    }
    const r = await db.query(sql, params);
    await db.query('commit');
    return r.rows as T[];
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}
const denied = (p: Promise<unknown>) => expect(p).rejects.toThrow();
const sys = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

async function makeUser(email: string, opts: { role?: string; name?: string; confirmed?: boolean; app?: object } = {}) {
  const [u] = await sys(
    `insert into auth.users (email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3, $4) returning id`,
    [email, opts.confirmed === false ? null : new Date(), { full_name: opts.name ?? email.split('@')[0] }, opts.app ?? {}],
  );
  if (opts.role) await sys(`update public.users set role = $1 where id = $2`, [opts.role, u.id]);
  return { id: u.id as string };
}
async function makeMember(name: string, uid?: string) {
  const [first, last] = name.split(' ');
  const [m] = await sys(`insert into public.members (first_name, last_name, full_name, phone, membership_status, uid) values ($1, $2, $3, '233240000000', 'member', $4) returning id`, [first, last ?? 'Test', name, uid ?? null]);
  if (uid) await sys(`update public.users set member_id = $1 where id = $2`, [m.id, uid]);
  return m.id as string;
}

let superAdmin: Who, developer: Who, admin: Who, pastor: Who, treasurer: Who, usher: Who, viewer: Who, member: Who, member2: Who, guest: Who;
let memberRec: string, member2Rec: string;

beforeAll(async () => {
  await resetLocal({ quiet: true });
  db = new pg.Client(cfg);
  await db.connect();
  superAdmin = await makeUser('christianworshipcentre.ch@gmail.com'); // seeded → super_admin
  developer = await makeUser('profjero947@gmail.com'); // seeded → developer
  admin = await makeUser('admin@cwc.test', { role: 'admin' });
  pastor = await makeUser('pastor@cwc.test', { role: 'pastor' });
  treasurer = await makeUser('treasurer@cwc.test', { role: 'treasurer' });
  usher = await makeUser('usher@cwc.test', { role: 'staff' });
  viewer = await makeUser('viewer@cwc.test', { role: 'viewer' });
  member = await makeUser('member@cwc.test', { name: 'Ama Mensah' });
  member2 = await makeUser('member2@cwc.test', { name: 'Kofi Boateng' });
  guest = await makeUser('233241112222@phone.cwc.app', { app: { is_guest: true } });
  memberRec = await makeMember('Ama Mensah', member!.id);
  member2Rec = await makeMember('Kofi Boateng', member2!.id);
});
afterAll(async () => db?.end());

describe('accounts & role seeding', () => {
  it('assigns seeded roles only to confirmed emails', async () => {
    const [sa] = await sys(`select role from public.users where id = $1`, [superAdmin!.id]);
    const [dev] = await sys(`select role from public.users where id = $1`, [developer!.id]);
    expect(sa.role).toBe('super_admin');
    expect(dev.role).toBe('developer');
  });

  it('does not grant a seeded role to an unconfirmed sign-up, but does once confirmed', async () => {
    await sys(`insert into private.role_seeds values ('future.admin@cwc.test', 'admin')`);
    const u = await makeUser('future.admin@cwc.test', { confirmed: false });
    expect((await sys(`select role from public.users where id = $1`, [u.id]))[0].role).toBe('member');
    await sys(`update auth.users set email_confirmed_at = now() where id = $1`, [u.id]);
    expect((await sys(`select role from public.users where id = $1`, [u.id]))[0].role).toBe('admin');
  });

  it('marks device (guest) accounts and hides synthetic login emails', async () => {
    const [g] = await sys(`select email, is_guest from public.users where id = $1`, [guest!.id]);
    expect(g).toEqual({ email: '', is_guest: true });
  });

  it('picks up server flags that Supabase Auth writes after the insert', async () => {
    const u = await makeUser('233200000000@phone.cwc.app');
    await sys(`update auth.users set raw_app_meta_data = raw_app_meta_data || '{"is_guest": true}' where id = $1`, [u.id]);
    const s = await makeUser('newstaff@cwc.test');
    await sys(`update auth.users set raw_app_meta_data = raw_app_meta_data || '{"must_change_password": true}' where id = $1`, [s.id]);
    expect((await sys(`select is_guest from public.users where id = $1`, [u.id]))[0].is_guest).toBe(true);
    expect((await sys(`select must_change_password from public.users where id = $1`, [s.id]))[0].must_change_password).toBe(true);
  });

  it('blocks clients from creating or deleting account rows directly', async () => {
    await denied(as(member, `insert into public.users (id, role) values (gen_random_uuid(), 'super_admin')`));
    await denied(as(admin, `delete from public.users where id = '${member2!.id}'`));
  });
});

describe('privilege escalation', () => {
  it('a member cannot change their own role, activation or member link', async () => {
    await denied(as(member, `update public.users set role = 'admin' where id = $1`, [member!.id]));
    await denied(as(member, `update public.users set member_id = $2 where id = $1`, [member!.id, member2Rec]));
    await denied(as(member, `update public.users set is_guest = true where id = $1`, [member!.id]));
  });

  it('a member can update their own profile details', async () => {
    const r = await as(member, `update public.users set full_name = 'Ama K. Mensah' where id = $1 returning full_name`, [member!.id]);
    expect(r[0].full_name).toBe('Ama K. Mensah');
  });

  it('a member cannot touch someone else’s account', async () => {
    const r = await as(member, `update public.users set full_name = 'hacked' where id = $1 returning id`, [member2!.id]);
    expect(r).toHaveLength(0);
  });

  it('an admin can assign ordinary roles but not super admin or developer', async () => {
    const r = await as(admin, `update public.users set role = 'pastor' where id = $1 returning role`, [member2!.id]);
    expect(r[0].role).toBe('pastor');
    await sys(`update public.users set role = 'member' where id = $1`, [member2!.id]);
    await denied(as(admin, `update public.users set role = 'super_admin' where id = $1`, [member2!.id]));
    await denied(as(admin, `update public.users set role = 'developer' where id = $1`, [member2!.id]));
  });

  it('an admin cannot demote or deactivate the super admin or developer', async () => {
    await denied(as(admin, `update public.users set role = 'member' where id = $1`, [superAdmin!.id]));
    await denied(as(admin, `update public.users set is_active = false where id = $1`, [developer!.id]));
  });

  it('the developer cannot grant super admin; the super admin can', async () => {
    await denied(as(developer, `update public.users set role = 'super_admin' where id = $1`, [member2!.id]));
    const r = await as(superAdmin, `update public.users set role = 'super_admin' where id = $1 returning role`, [member2!.id]);
    expect(r[0].role).toBe('super_admin');
    await sys(`update public.users set role = 'member' where id = $1`, [member2!.id]);
  });

  it('nobody can change their own role', async () => {
    await denied(as(superAdmin, `update public.users set role = 'member' where id = $1`, [superAdmin!.id]));
  });

  it('never leaves the church without an active super admin', async () => {
    const other = await makeUser('second.sa@cwc.test', { role: 'super_admin' });
    // with two super admins, one may demote the other…
    await as(other, `update public.users set role = 'admin' where id = $1`, [superAdmin!.id]);
    await sys(`update public.users set role = 'super_admin' where id = $1`, [superAdmin!.id]);
    await sys(`update public.users set role = 'member' where id = $1`, [other.id]);
    // …but the last one can neither demote nor deactivate themselves
    await denied(as(superAdmin, `update public.users set is_active = false where id = $1`, [superAdmin!.id]));
    const n = (await sys(`select count(*)::int n from public.users where role = 'super_admin' and is_active`))[0].n;
    expect(n).toBe(1);
  });

  it('a staff member with a weaker role cannot manage accounts', async () => {
    await denied(as(pastor, `update public.users set role = 'admin' where id = $1`, [member2!.id]));
  });
});

describe('custom roles', () => {
  it('the super admin can add a new role; admins cannot', async () => {
    const r = await as(superAdmin, `insert into public.roles (key, label, permissions) values ('usher_lead', 'Usher lead', array['dashboard.view','attendance.manage']) returning key, is_system`);
    expect(r[0]).toEqual({ key: 'usher_lead', is_system: false });
    await denied(as(admin, `insert into public.roles (key, label, permissions) values ('rogue', 'Rogue', array['users.manage'])`));
  });

  it('rejects unknown permissions and protects built-in roles', async () => {
    await denied(as(superAdmin, `insert into public.roles (key, label, permissions) values ('bad', 'Bad', array['launch.missiles'])`));
    await denied(as(superAdmin, `delete from public.roles where key = 'pastor'`));
    await denied(as(superAdmin, `update public.roles set permissions = '{}' where key = 'super_admin'`));
  });

  it('a custom role grants exactly its permissions', async () => {
    await as(superAdmin, `update public.users set role = 'usher_lead' where id = $1`, [member2!.id]);
    const svc = await as(member2, `insert into public.services (title, type, date) values ('Test', 'Sunday', current_date) returning id`);
    expect(svc).toHaveLength(1);
    expect(await as(member2, `select * from public.gifts`)).toHaveLength(0);
    await denied(as(member2, `insert into public.gifts (category, amount, date) values ('Tithe', 10, current_date)`));
    await denied(as(superAdmin, `delete from public.roles where key = 'usher_lead'`)); // still in use
    await sys(`update public.users set role = 'member' where id = $1`, [member2!.id]);
  });
});

describe('visitors without an account', () => {
  beforeAll(async () => {
    await sys(`insert into public.events (title, start_at, status) values ('Public event', '2030-01-01T10:00', 'published'), ('Draft event', '2030-01-01T10:00', 'draft')`);
    await sys(`insert into public.devotionals (title, date, status) values ('Today', current_date, 'published'), ('Future', current_date + 3, 'published'), ('Draft', current_date, 'draft')`);
  });

  it('can read published content and the church profile', async () => {
    expect((await as(null, `select title from public.events`)).map((r) => r.title)).toEqual(['Public event']);
    expect((await as(null, `select title from public.devotionals`)).map((r) => r.title)).toEqual(['Today']);
    expect(await as(null, `select id from public.settings`)).toHaveLength(1);
  });

  it('cannot read people, giving, care, accounts or audit data', async () => {
    for (const t of ['members', 'users', 'gifts', 'care_requests', 'audit_logs', 'followups', 'expenses', 'push_subscriptions']) {
      await denied(as(null, `select * from public.${t}`));
    }
  });

  it('cannot write anything', async () => {
    await denied(as(null, `insert into public.care_requests (type, details) values ('prayer', 'x')`));
    await denied(as(null, `update public.settings set data = '{}'`));
    await denied(as(null, `select public.complete_profile('{}'::jsonb)`));
  });
});

describe('people & self-registration', () => {
  it('a member sees only their own member record', async () => {
    const rows = await as(member, `select id from public.members`);
    expect(rows.map((r) => r.id)).toEqual([memberRec]);
  });

  it('a member may edit contact details but not church fields', async () => {
    await as(member, `update public.members set occupation = 'Nurse' where id = $1`, [memberRec]);
    await denied(as(member, `update public.members set membership_status = 'leader' where id = $1`, [memberRec]));
    await denied(as(member, `update public.members set verified = true, notes = 'x' where id = $1`, [memberRec]));
  });

  it('complete_profile creates a pending record, follow-up and staff notification', async () => {
    const [{ complete_profile: mid }] = await as(guest, `select public.complete_profile($1::jsonb)`, [
      { firstName: 'Yaw', lastName: 'Asante', phone: '0241112222', membershipStatus: 'first_timer', gender: 'male' },
    ]);
    const [m] = await sys(`select uid, verified, self_registered, membership_status from public.members where id = $1`, [mid]);
    expect(m).toMatchObject({ uid: guest!.id, verified: false, self_registered: true, membership_status: 'first_timer' });
    expect((await sys(`select member_id from public.users where id = $1`, [guest!.id]))[0].member_id).toBe(mid);
    expect(await sys(`select * from public.followups where member_id = $1`, [mid])).toHaveLength(1);
    const notes = await as(pastor, `select title from public.notifications where audience = 'perm' and target_perm = 'people.manage'`);
    expect(notes.length).toBeGreaterThan(0);
    expect(await as(member, `select title from public.notifications where target_perm = 'people.manage'`)).toHaveLength(0);
    // running it again updates instead of duplicating
    await as(guest, `select public.complete_profile($1::jsonb)`, [{ firstName: 'Yaw', lastName: 'Asante', phone: '0241112222' }]);
    expect(await sys(`select * from public.members where uid = $1`, [guest!.id])).toHaveLength(1);
  });

  it('validates profile input', async () => {
    await denied(as(member2, `select public.complete_profile('{"firstName":"A","lastName":"","phone":"024"}'::jsonb)`));
  });

  it('people managers can merge duplicates; secretaries without delete rights cannot', async () => {
    const dup = await makeMember('Ama Duplicate');
    await sys(`insert into public.gifts (category, amount, date, member_id) values ('Tithe', 50, current_date, $1)`, [dup]);
    const sec = await makeUser('secretary@cwc.test', { role: 'secretary' });
    await denied(as(sec, `select public.merge_members($1, $2)`, [memberRec, dup]));
    await as(admin, `select public.merge_members($1, $2)`, [memberRec, dup]);
    expect(await sys(`select * from public.members where id = $1`, [dup])).toHaveLength(0);
    expect((await sys(`select count(*)::int n from public.gifts where member_id = $1`, [memberRec]))[0].n).toBe(1);
  });

  it('keeps group member counts in step', async () => {
    const [g] = await as(pastor, `insert into public.groups (name) values ('Choir') returning id`);
    await as(pastor, `select public.set_group_membership($1, $2, true)`, [[memberRec, member2Rec], g.id]);
    expect((await sys(`select member_count from public.groups where id = $1`, [g.id]))[0].member_count).toBe(2);
    await as(pastor, `select public.set_group_membership($1, $2, false)`, [[member2Rec], g.id]);
    expect((await sys(`select member_count from public.groups where id = $1`, [g.id]))[0].member_count).toBe(1);
    expect(await as(member, `select public.set_group_membership($1, $2, true)`, [[member2Rec], g.id])).toEqual([{ set_group_membership: 0 }]);
  });
});

describe('giving privacy', () => {
  beforeAll(async () => {
    await sys(`insert into public.gifts (category, amount, date, member_id) values ('Offering', 20, current_date, $1), ('Offering', 30, current_date, $2)`, [memberRec, member2Rec]);
  });
  it('members see only their own gifts', async () => {
    const rows = await as(member2, `select amount from public.gifts`);
    expect(rows.map((r) => Number(r.amount))).toEqual([30]);
  });
  it('treasurer records gifts; pastors can view but not edit; ushers see nothing', async () => {
    await as(treasurer, `insert into public.gifts (category, amount, date) values ('Tithe', 100, current_date)`);
    expect((await as(pastor, `select * from public.gifts`)).length).toBeGreaterThan(2);
    expect(await as(pastor, `update public.gifts set amount = 1 returning id`)).toHaveLength(0);
    expect(await as(usher, `select * from public.gifts`)).toHaveLength(0);
  });
  it('pledge "paid" follows linked gifts', async () => {
    const [p] = await as(treasurer, `insert into public.pledges (member_name, amount) values ('Ama', 500) returning id`);
    const [g] = await as(treasurer, `insert into public.gifts (category, amount, date, pledge_id) values ('Pledge Redemption', 120, current_date, $1) returning id`, [p.id]);
    expect(Number((await sys(`select paid from public.pledges where id = $1`, [p.id]))[0].paid)).toBe(120);
    await as(treasurer, `delete from public.gifts where id = $1`, [g.id]);
    expect(Number((await sys(`select paid from public.pledges where id = $1`, [p.id]))[0].paid)).toBe(0);
  });
  it('expenses are hidden from viewers and read-only for pastors', async () => {
    await as(treasurer, `insert into public.expenses (category, amount, date) values ('Utilities', 80, current_date)`);
    expect(await as(viewer, `select * from public.expenses`)).toHaveLength(0);
    expect(await as(pastor, `select * from public.expenses`)).toHaveLength(1);
    expect(await as(pastor, `delete from public.expenses returning id`)).toHaveLength(0);
  });
});

describe('pastoral care', () => {
  let privateReq: string, wallReq: string, anonReq: string;
  beforeAll(async () => {
    [{ id: privateReq }] = await as(member, `insert into public.care_requests (type, name, phone, details) values ('counselling', 'Ama', '0240000000', 'Confidential matter') returning id`);
    [{ id: wallReq }] = await as(member, `insert into public.care_requests (type, name, details, visibility) values ('prayer', 'Ama', 'Pray for my exams', 'public') returning id`);
    [{ id: anonReq }] = await as(member2, `insert into public.care_requests (type, name, phone, details, visibility, anonymous) values ('prayer', 'Kofi Boateng', '0241231231', 'Healing', 'public', true) returning id`);
  });

  it('requests are visible only to the requester and the care team', async () => {
    expect(await as(member2, `select * from public.care_requests where id = $1`, [privateReq])).toHaveLength(0);
    expect(await as(treasurer, `select * from public.care_requests`)).toHaveLength(0);
    expect(await as(pastor, `select * from public.care_requests where id = $1`, [privateReq])).toHaveLength(1);
  });

  it('the requester cannot set pastoral fields when creating', async () => {
    const [r] = await as(member, `insert into public.care_requests (type, name, details, status, assigned_to, prayed_count, uid) values ('prayer', 'Ama', 'x', 'closed', $1, 999, $1) returning status, assigned_to, prayed_count, uid`, [pastor!.id]);
    expect(r).toMatchObject({ status: 'new', assigned_to: null, prayed_count: 0, uid: member!.id });
  });

  it('the prayer wall hides names of anonymous posts and never exposes phones', async () => {
    const wall = await as(null, `select * from public.get_prayer_wall('device-key-1234567890')`);
    const ids = wall.map((w) => w.id);
    expect(ids).toContain(wallReq);
    expect(ids).not.toContain(privateReq);
    const a = wall.find((w) => w.id === anonReq)!;
    expect(a.name).toBe('Someone in our church');
    expect(JSON.stringify(wall)).not.toContain('0241231231');
    expect(JSON.stringify(wall)).not.toContain('Kofi');
  });

  it('“I prayed” counts once per person or device', async () => {
    await as(member2, `select public.pray_for($1)`, [wallReq]);
    await as(member2, `select public.pray_for($1)`, [wallReq]);
    await as(null, `select public.pray_for($1, 'device-key-1234567890')`, [wallReq]);
    await as(null, `select public.pray_for($1, 'device-key-1234567890')`, [wallReq]);
    expect((await sys(`select prayed_count from public.care_requests where id = $1`, [wallReq]))[0].prayed_count).toBe(2);
    await denied(as(null, `select public.pray_for($1, 'x')`, [wallReq]));
    await denied(as(member, `select public.pray_for($1)`, [privateReq]));
  });

  it('members cannot edit requests directly but can reply and close via RPC', async () => {
    await denied(as(member, `update public.care_requests set status = 'completed' where id = $1`, [privateReq]).then((r) => { if (!(r as unknown[]).length) throw new Error('no rows'); }));
    await as(member, `select public.add_care_response($1, 'Any update?')`, [privateReq]);
    await denied(as(member2, `select public.add_care_response($1, 'snooping')`, [privateReq]));
  });

  it('a pastor’s reply notifies only the requester', async () => {
    await as(pastor, `select public.add_care_response($1, 'We are praying with you')`, [privateReq]);
    const [r] = await sys(`select status, jsonb_array_length(responses) n from public.care_requests where id = $1`, [privateReq]);
    expect(r).toEqual({ status: 'in_progress', n: 2 });
    expect((await as(member, `select title from public.notifications where audience = 'user'`)).length).toBeGreaterThan(0);
    expect(await as(member2, `select title from public.notifications where audience = 'user' and target_uid = $1`, [member!.id])).toHaveLength(0);
  });

  it('counselling alerts go to confidential-care holders only', async () => {
    const rows = await as(pastor, `select title, target_perm from public.notifications where title = 'New counselling request'`);
    expect(rows[0].target_perm).toBe('care.confidential');
    expect(await as(usher, `select * from public.notifications where title = 'New counselling request'`)).toHaveLength(0);
  });

  it('care logs marked confidential need the confidential permission', async () => {
    await sys(`insert into public.roles (key, label, permissions) values ('care_team', 'Care team', array['care.view','care.manage'])`);
    const ct = await makeUser('careteam@cwc.test', { role: 'care_team' });
    await as(pastor, `insert into public.care_logs (member_name, date, summary, confidential) values ('Ama', current_date, 'secret', true), ('Ama', current_date, 'open', false)`);
    expect((await as(ct, `select summary from public.care_logs`)).map((r) => r.summary)).toEqual(['open']);
    expect(await as(pastor, `select summary from public.care_logs`)).toHaveLength(2);
  });

  it('testimonies from members always start pending', async () => {
    const [t] = await as(member, `insert into public.testimonies (name, title, body, status) values ('Ama', 'Healed', 'Praise God', 'published') returning status`);
    expect(t.status).toBe('pending');
    expect(await as(null, `select * from public.testimonies where title = 'Healed'`)).toHaveLength(0);
  });
});

describe('events & RSVP', () => {
  let ev: string;
  beforeAll(async () => {
    [{ id: ev }] = await sys(`insert into public.events (title, start_at, status, rsvp_enabled, capacity) values ('Retreat', '2030-02-01T09:00', 'published', true, 2) returning id`);
  });
  it('keeps rsvp_count in the database and enforces capacity', async () => {
    await as(member, `insert into public.rsvps (event_id, name) values ($1, 'Ama')`, [ev]);
    await as(member2, `insert into public.rsvps (event_id, name) values ($1, 'Kofi')`, [ev]);
    await denied(as(guest, `insert into public.rsvps (event_id, name) values ($1, 'Yaw')`, [ev]));
    expect((await sys(`select rsvp_count from public.events where id = $1`, [ev]))[0].rsvp_count).toBe(2);
    await as(member2, `delete from public.rsvps where event_id = $1 and uid = $2`, [ev, member2!.id]);
    expect((await sys(`select rsvp_count from public.events where id = $1`, [ev]))[0].rsvp_count).toBe(1);
  });
  it('cannot RSVP for someone else or for unpublished events', async () => {
    await denied(as(member2, `insert into public.rsvps (event_id, uid, name) values ($1, $2, 'x')`, [ev, member!.id]));
    const [d] = await sys(`insert into public.events (title, start_at, rsvp_enabled) values ('Draft', '2030-01-01T10:00', true) returning id`);
    await denied(as(member, `insert into public.rsvps (event_id, name) values ($1, 'Ama')`, [d.id]));
  });
  it('members cannot see other people’s RSVPs or edit events', async () => {
    expect(await as(member2, `select * from public.rsvps`)).toHaveLength(0);
    expect(await as(member, `update public.events set rsvp_count = 99 returning id`)).toHaveLength(0);
  });
});

describe('attendance', () => {
  let svc: string;
  beforeAll(async () => {
    [{ id: svc }] = await as(usher, `insert into public.services (title, type, date) values ('Sunday', 'Sunday First Service', current_date) returning id`);
  });
  it('self check-in works only while open, once, and only when linked', async () => {
    expect((await as(member, `select public.self_check_in($1) s`, [svc]))[0].s).toBe('done');
    expect((await as(member, `select public.self_check_in($1) s`, [svc]))[0].s).toBe('done');
    const unlinked = await makeUser('unlinked@cwc.test');
    expect((await as(unlinked, `select public.self_check_in($1) s`, [svc]))[0].s).toBe('unlinked');
    await as(usher, `update public.services set is_open = false where id = $1`, [svc]);
    expect((await as(member2, `select public.self_check_in($1) s`, [svc]))[0].s).toBe('closed');
    expect((await sys(`select checkins from public.services where id = $1`, [svc]))[0].checkins).toBe(1);
  });
  it('members cannot write attendance rows directly', async () => {
    await denied(as(member2, `insert into public.attendance (service_id, date, member_id) values ($1, current_date, $2)`, [svc, member2Rec]));
  });
  it('ushers adjust headcounts atomically; members cannot', async () => {
    await as(usher, `select public.bump_headcount($1, 'men', 3)`, [svc]);
    await as(usher, `select public.bump_headcount($1, 'men', -5)`, [svc]);
    expect((await sys(`select headcount->>'men' m from public.services where id = $1`, [svc]))[0].m).toBe('0');
    await denied(as(member, `select public.bump_headcount($1, 'men', 1)`, [svc]));
    await denied(as(usher, `select public.bump_headcount($1, 'admins', 1)`, [svc]));
  });
});

describe('notifications & push', () => {
  it('visitors see church-wide notifications only', async () => {
    await as(pastor, `insert into public.notifications (title, audience) values ('Service moved to 9am', 'all')`);
    const rows = await as(null, `select title, audience from public.notifications`);
    expect(rows.every((r) => r.audience === 'all')).toBe(true);
    expect(rows.map((r) => r.title)).toContain('Service moved to 9am');
  });
  it('members cannot broadcast', async () => {
    await denied(as(member, `insert into public.notifications (title, audience) values ('spam', 'all')`));
  });
  it('read receipts are personal', async () => {
    await as(member, `select public.mark_notifications_read(null)`);
    expect((await as(member, `select count(*)::int n from public.notification_reads`))[0].n).toBeGreaterThan(0);
    expect((await as(member2, `select count(*)::int n from public.notification_reads`))[0].n).toBe(0);
  });
  it('accepts only real push services and is idempotent', async () => {
    const key = 'B' + 'a'.repeat(86);
    await as(null, `select public.subscribe_push('https://fcm.googleapis.com/fcm/send/abc', $1, 'aaaaaaaaaaaaaaaaaaaaaa')`, [key]);
    await as(member, `select public.subscribe_push('https://fcm.googleapis.com/fcm/send/abc', $1, 'aaaaaaaaaaaaaaaaaaaaaa')`, [key]);
    const rows = await sys(`select uid from public.push_subscriptions`);
    expect(rows).toEqual([{ uid: member!.id }]);
    await denied(as(member, `select public.subscribe_push('https://evil.example.com/x', $1, 'aaaaaaaaaaaaaaaaaaaaaa')`, [key]));
    await denied(as(member, `insert into public.push_subscriptions (id, endpoint, p256dh, auth) values ('x','https://fcm.googleapis.com/y','a','b')`));
  });
});

describe('audit & monitoring', () => {
  it('audit entries are attributed to the caller and immutable', async () => {
    await as(pastor, `insert into public.audit_logs (action, entity, summary, by) values ('update', 'x', 'attribution-test', $1)`, [admin!.id]);
    const [a] = await sys(`select by from public.audit_logs where summary = 'attribution-test'`);
    expect(a.by).toBe(pastor!.id);
    await denied(as(admin, `update public.audit_logs set summary = 'edited'`));
    await denied(as(admin, `delete from public.audit_logs`));
    await denied(as(member, `insert into public.audit_logs (action, entity) values ('x', 'y')`));
  });
  it('client errors are de-duplicated and readable only by the developer team', async () => {
    for (let i = 0; i < 3; i++) await as(null, `select public.log_client_error('TypeError: boom', 'at x', '/events', '2.0.0')`);
    const [e] = await as(developer, `select count from public.app_errors where message = 'TypeError: boom'`);
    expect(e.count).toBe(3);
    expect(await as(admin, `select * from public.app_errors`)).toHaveLength(0);
  });
  it('system health is on-demand and developer/super-admin only', async () => {
    const [h] = await as(developer, `select public.dev_system_health() h`);
    expect((h.h as { db: { sizeBytes: number } }).db.sizeBytes).toBeGreaterThan(0);
    expect(await as(superAdmin, `select public.dev_system_health() is not null ok`)).toEqual([{ ok: true }]);
    await denied(as(admin, `select public.dev_system_health()`));
    await denied(as(member, `select public.dev_maintenance('cleanup')`));
    const [m] = await as(developer, `select public.dev_maintenance('cleanup') r`);
    expect(m.r).toHaveProperty('errors');
  });
  it('integration keys can be set by the developer but never read back', async () => {
    await as(developer, `select public.set_integration_secret('profjero_api_key', 'pk_live_secret')`);
    await denied(as(developer, `select * from private.app_config`));
    await denied(as(developer, `select public.server_config(array['profjero_api_key'])`));
    await denied(as(admin, `select public.set_integration_secret('profjero_api_key', 'x')`));
    const [h] = await as(developer, `select public.dev_system_health() h`);
    expect((h.h as { integrations: { smsKey: boolean } }).integrations.smsKey).toBe(true);
  });
  it('server-only helpers are not callable by clients', async () => {
    await denied(as(null, `select public.hit_rate_limit('x', 1, 60)`));
    await denied(as(member, `select public.server_set_config('dispatch_secret', 'x', true)`));
  });
});

describe('settings', () => {
  it('only settings managers edit the church profile', async () => {
    expect(await as(pastor, `update public.settings set data = '{"name":"x"}' returning id`)).toHaveLength(0);
    expect(await as(admin, `update public.settings set data = '{"name":"CWC"}' returning id`)).toHaveLength(1);
  });
});
