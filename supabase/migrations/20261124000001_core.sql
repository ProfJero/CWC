-- Christian Worship Centre — core schema (Supabase / Postgres 15+)
-- Crafted by ProfJero.
--
-- Conventions
--   * snake_case columns; the app converts to camelCase at the edge.
--   * every table in `public` has RLS enabled (see 20261124000002_rls.sql).
--   * privileged helpers live in the unexposed `private` schema.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

/* ------------------------------------------------------------------ */
/* Roles & permissions (data-driven: add roles without code changes)   */
/* ------------------------------------------------------------------ */

create table public.roles (
  key          text primary key check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  label        text not null check (char_length(label) between 1 and 60),
  description  text not null default '',
  tone         text not null default 'neutral',
  permissions  text[] not null default '{}',
  is_system    boolean not null default false,  -- built-in: cannot be deleted
  sort         int not null default 100,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger roles_updated before update on public.roles for each row execute function private.set_updated_at();

-- The permission catalog. Keep in sync with app/src/lib/permissions.ts.
create table private.permission_catalog (key text primary key);
insert into private.permission_catalog (key) values
  ('dashboard.view'), ('people.view'), ('people.manage'), ('people.delete'), ('groups.manage'),
  ('followups.manage'), ('attendance.manage'), ('giving.view'), ('giving.manage'), ('expenses.manage'),
  ('events.manage'), ('content.manage'), ('care.view'), ('care.manage'), ('care.confidential'),
  ('messaging.sms'), ('messaging.push'), ('reports.view'), ('users.manage'), ('roles.manage'),
  ('settings.manage'), ('audit.view'), ('system.monitor');

create or replace function private.validate_role()
returns trigger language plpgsql security definer set search_path = '' as $$
declare bad text;
begin
  select string_agg(p, ', ') into bad
  from unnest(new.permissions) p
  where p not in (select key from private.permission_catalog);
  if bad is not null then
    raise exception 'Unknown permission(s): %', bad using errcode = '22023';
  end if;
  new.permissions := array(select distinct unnest(new.permissions) order by 1);
  return new;
end $$;
create trigger roles_validate before insert or update on public.roles for each row execute function private.validate_role();

insert into public.roles (key, label, description, tone, permissions, is_system, sort) values
  ('super_admin', 'Super Admin', 'Full access, including roles, admins and settings', 'danger',
    array(select key from private.permission_catalog), true, 1),
  ('developer', 'Developer', 'Maintains the platform: monitoring, diagnostics and integrations', 'info',
    array(select key from private.permission_catalog), true, 2),
  ('admin', 'Administrator', 'Runs day-to-day church operations', 'brand',
    array(select key from private.permission_catalog where key not in ('roles.manage', 'system.monitor')), true, 3),
  ('pastor', 'Pastor', 'People, care, content and messaging', 'info',
    array['dashboard.view','people.view','people.manage','groups.manage','followups.manage','attendance.manage','giving.view',
          'events.manage','content.manage','care.view','care.manage','care.confidential','messaging.sms','messaging.push','reports.view'], true, 4),
  ('treasurer', 'Treasurer', 'Giving, pledges and expenses', 'success',
    array['dashboard.view','people.view','giving.view','giving.manage','expenses.manage','reports.view','messaging.sms'], true, 5),
  ('secretary', 'Secretary', 'People, attendance, events and messaging', 'warning',
    array['dashboard.view','people.view','people.manage','groups.manage','followups.manage','attendance.manage','events.manage',
          'content.manage','messaging.sms','messaging.push','reports.view'], true, 6),
  ('staff', 'Ministry Staff', 'Attendance and follow-ups', 'neutral',
    array['dashboard.view','people.view','attendance.manage','followups.manage'], true, 7),
  ('viewer', 'Viewer', 'Read-only dashboards and reports', 'neutral',
    array['dashboard.view','people.view','reports.view'], true, 8),
  ('member', 'Member', 'Member app only', 'neutral', '{}', true, 99);

-- Accounts that receive a role automatically once their email is confirmed.
create table private.role_seeds (
  email text primary key check (email = lower(email)),
  role  text not null references public.roles(key) on update cascade
);
insert into private.role_seeds (email, role) values
  ('christianworshipcentre.ch@gmail.com', 'super_admin'),
  ('profjero947@gmail.com', 'developer');

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

create table public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table public.groups (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 120),
  type         text not null default 'ministry',
  description  text,
  leader_ids   uuid[] not null default '{}',
  leader_names text[] not null default '{}',
  meeting_day  text,
  meeting_time text,
  location     text,
  color        text,
  member_count int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);

create table public.members (
  id                 uuid primary key default gen_random_uuid(),
  first_name         text not null default '',
  last_name          text not null default '',
  other_names        text,
  full_name          text not null default '',
  title              text,
  gender             text not null default '' check (gender in ('', 'male', 'female')),
  dob                date,
  birth_month_day    text,
  phone              text not null default '',
  alt_phone          text,
  email              text,
  address            text,
  gps_address        text,
  hometown           text,
  region             text,
  occupation         text,
  marital_status     text default '',
  anniversary        date,
  membership_status  text not null default 'visitor' check (membership_status in
                       ('visitor','first_timer','new_convert','member','worker','leader','inactive','transferred','deceased')),
  join_date          date,
  baptism_date       date,
  salvation_date     date,
  group_ids          uuid[] not null default '{}',
  household_id       uuid references public.households(id) on delete set null,
  household_role     text default '',
  photo_url          text,
  emergency_name     text,
  emergency_phone    text,
  emergency_relation text,
  notes              text,
  tags               text[] not null default '{}',
  uid                uuid unique references auth.users(id) on delete set null,
  how_heard          text,
  invited_by         text,
  sms_opt_out        boolean not null default false,
  keywords           text[] not null default '{}',
  self_registered    boolean not null default false,  -- completed their own profile in the app
  verified           boolean not null default true,   -- staff have reviewed a self-registered profile
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid default auth.uid()
);
create index members_full_name_idx on public.members (full_name);
create index members_phone_idx on public.members (phone);
create index members_household_idx on public.members (household_id);
create index members_birth_idx on public.members (birth_month_day);
create index members_groups_idx on public.members using gin (group_ids);
create index members_unverified_idx on public.members (created_at desc) where not verified;

create or replace function private.members_derive()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.birth_month_day := case when new.dob is null then null else to_char(new.dob, 'MM-DD') end;
  if coalesce(new.full_name, '') = '' then
    new.full_name := trim(concat_ws(' ', nullif(new.first_name, ''), nullif(new.other_names, ''), nullif(new.last_name, '')));
  end if;
  new.group_ids := array(select distinct unnest(new.group_ids));
  return new;
end $$;
create trigger members_derive before insert or update on public.members for each row execute function private.members_derive();

-- App accounts. One row per auth user, created by trigger.
create table public.users (
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 text not null default '',
  full_name             text not null default '',
  phone                 text not null default '',
  role                  text not null default 'member' references public.roles(key) on update cascade,
  is_active             boolean not null default true,
  member_id             uuid unique references public.members(id) on delete set null,
  photo_url             text,
  notification_prefs    jsonb not null default '{}',
  is_guest              boolean not null default false, -- device account: no password chosen yet
  must_change_password  boolean not null default false,
  last_login            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index users_role_idx on public.users (role);

create table public.followups (
  id            uuid primary key default gen_random_uuid(),
  member_id     uuid references public.members(id) on delete cascade,
  name          text not null default '',
  phone         text,
  kind          text not null default 'general',
  stage         text not null default 'new' check (stage in ('new','contacted','visited','integrated','closed')),
  assigned_to   uuid references public.users(id) on delete set null,
  assigned_name text default '',
  due_date      date,
  notes         jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
create index followups_created_idx on public.followups (created_at desc);
create index followups_member_idx on public.followups (member_id);
create index followups_assigned_idx on public.followups (assigned_to);

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

create table public.services (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  type         text not null default '',
  date         date not null,
  start_time   text,
  is_open      boolean not null default true,
  headcount    jsonb not null default '{"men":0,"women":0,"children":0,"visitors":0}',
  checkins     int not null default 0,
  first_timers int not null default 0,
  notes        text,
  preacher     text,
  theme        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);
create index services_date_idx on public.services (date desc);
create index services_open_idx on public.services (is_open) where is_open;

create table public.attendance (
  id            uuid primary key default gen_random_uuid(),
  service_id    uuid not null references public.services(id) on delete cascade,
  service_type  text not null default '',
  date          date not null,
  member_id     uuid not null references public.members(id) on delete cascade,
  member_name   text not null default '',
  method        text not null default 'manual' check (method in ('manual','qr','self')),
  checked_in_at timestamptz not null default now(),
  by            uuid default auth.uid(),
  unique (service_id, member_id)
);
create index attendance_member_idx on public.attendance (member_id, date desc);
create index attendance_date_idx on public.attendance (date);

/* ------------------------------------------------------------------ */
/* Giving & finance                                                    */
/* ------------------------------------------------------------------ */

create table public.campaigns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  goal        numeric(14,2) not null default 0,
  start_date  date,
  end_date    date,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

create table public.pledges (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid references public.campaigns(id) on delete cascade,
  campaign_name text not null default '',
  member_id     uuid references public.members(id) on delete set null,
  member_name   text not null default '',
  phone         text,
  amount        numeric(14,2) not null default 0 check (amount >= 0),
  paid          numeric(14,2) not null default 0,
  due_date      date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
create index pledges_member_idx on public.pledges (member_id);

create table public.gifts (
  id               uuid primary key default gen_random_uuid(),
  category         text not null,
  amount           numeric(14,2) not null check (amount > 0),
  method           text not null default 'cash',
  reference        text,
  member_id        uuid references public.members(id) on delete set null,
  member_name      text default '',
  service_id       uuid references public.services(id) on delete set null,
  pledge_id        uuid references public.pledges(id) on delete set null,
  campaign_id      uuid references public.campaigns(id) on delete set null,
  date             date not null,
  notes            text,
  receipt_no       text not null default '',
  recorded_by      uuid default auth.uid(),
  recorded_by_name text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default auth.uid()
);
create index gifts_date_idx on public.gifts (date desc);
create index gifts_member_idx on public.gifts (member_id, date desc);
create index gifts_pledge_idx on public.gifts (pledge_id);

create table public.expenses (
  id               uuid primary key default gen_random_uuid(),
  category         text not null,
  amount           numeric(14,2) not null check (amount > 0),
  payee            text,
  method           text not null default 'cash',
  date             date not null,
  description      text,
  reference        text,
  receipt_url      text,
  approved_by      text,
  recorded_by      uuid default auth.uid(),
  recorded_by_name text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default auth.uid()
);
create index expenses_date_idx on public.expenses (date desc);

/* ------------------------------------------------------------------ */
/* Events & content                                                    */
/* ------------------------------------------------------------------ */

create table public.events (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  category     text not null default 'Other',
  start_at     text not null,  -- local "YYYY-MM-DDTHH:mm" (Africa/Accra)
  end_at       text,
  location     text,
  map_url      text,
  image_url    text,
  status       text not null default 'draft' check (status in ('draft','published')),
  rsvp_enabled boolean not null default false,
  capacity     int check (capacity is null or capacity >= 0),
  rsvp_count   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);
create index events_status_start_idx on public.events (status, start_at desc);

create table public.rsvps (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  uid        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null default '',
  phone      text,
  guests     int not null default 0 check (guests between 0 and 10),
  created_at timestamptz not null default now(),
  unique (event_id, uid)
);
create index rsvps_uid_idx on public.rsvps (uid);

create table public.devotionals (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  date           date not null,
  scripture      text not null default '',
  scripture_text text,
  body           text not null default '',
  prayer         text,
  confession     text,
  author         text,
  image_url      text,
  status         text not null default 'draft' check (status in ('draft','published')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default auth.uid()
);
create index devotionals_status_date_idx on public.devotionals (status, date desc);

create table public.sermons (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  preacher      text not null default '',
  date          date not null,
  series        text,
  scripture     text,
  summary       text,
  video_url     text,
  audio_url     text,
  thumbnail_url text,
  status        text not null default 'draft' check (status in ('draft','published')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
create index sermons_status_date_idx on public.sermons (status, date desc);

create table public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null default '',
  pinned     boolean not null default false,
  status     text not null default 'draft' check (status in ('draft','published')),
  expires_on date,
  image_url  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index announcements_status_idx on public.announcements (status, created_at desc);

/* ------------------------------------------------------------------ */
/* Pastoral care                                                       */
/* ------------------------------------------------------------------ */

create table public.care_requests (
  id             uuid primary key default gen_random_uuid(),
  type           text not null check (type in ('prayer','counselling','visit','urgent','thanksgiving')),
  uid            uuid default auth.uid() references auth.users(id) on delete set null,
  member_id      uuid references public.members(id) on delete set null,
  name           text not null default '',
  phone          text,
  subject        text,
  details        text not null check (char_length(details) between 1 and 5000),
  visibility     text not null default 'private' check (visibility in ('private','public')),
  anonymous      boolean not null default false,
  preferred_date date,
  location       text,
  status         text not null default 'new' check (status in ('new','in_progress','scheduled','completed','closed')),
  assigned_to    uuid references public.users(id) on delete set null,
  assigned_name  text default '',
  scheduled_for  text,
  responses      jsonb not null default '[]',
  prayed_count   int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index care_created_idx on public.care_requests (created_at desc);
create index care_uid_idx on public.care_requests (uid, created_at desc);
create index care_wall_idx on public.care_requests (created_at desc) where visibility = 'public' and type = 'prayer';

create table public.care_notes (
  id              uuid primary key default gen_random_uuid(),
  care_request_id uuid not null references public.care_requests(id) on delete cascade,
  text            text not null check (char_length(text) between 1 and 5000),
  by              uuid default auth.uid(),
  by_name         text not null default '',
  at              timestamptz not null default now()
);
create index care_notes_req_idx on public.care_notes (care_request_id, at desc);

-- One "I prayed" per person/device per request.
create table public.care_prayers (
  care_request_id uuid not null references public.care_requests(id) on delete cascade,
  prayer_key      text not null,
  at              timestamptz not null default now(),
  primary key (care_request_id, prayer_key)
);

create table public.care_logs (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid references public.members(id) on delete set null,
  member_name  text not null default '',
  type         text not null default 'other',
  date         date not null,
  summary      text not null default '',
  next_step    text,
  confidential boolean not null default false,
  by           uuid default auth.uid(),
  by_name      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index care_logs_member_idx on public.care_logs (member_id, date desc);

create table public.testimonies (
  id         uuid primary key default gen_random_uuid(),
  uid        uuid default auth.uid() references auth.users(id) on delete set null,
  name       text not null default '',
  title      text not null default 'My testimony',
  body       text not null check (char_length(body) between 1 and 5000),
  status     text not null default 'pending' check (status in ('pending','published','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index testimonies_status_idx on public.testimonies (status, created_at desc);

/* ------------------------------------------------------------------ */
/* Messaging & notifications                                           */
/* ------------------------------------------------------------------ */

create table public.sms_messages (
  id              text primary key check (char_length(id) between 8 and 120), -- = idempotency key
  sender_id       text not null default '',
  message         text not null default '',
  audience        text not null default '',
  recipients      int not null default 0,
  personalized    boolean not null default false,
  status          text not null default 'sending',
  units_reserved  int,
  units_charged   int,
  delivered       int,
  failed          int,
  scheduled_at    text,
  campaign_id     text,
  error           text,
  created_by      uuid default auth.uid(),
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index sms_created_idx on public.sms_messages (created_at desc);

create table public.sms_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  body       text not null,
  category   text not null default 'General',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

-- audience: 'all' (everyone, including visitors), 'user' (target_uid) or 'perm' (staff holding target_perm)
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 140),
  body        text not null default '' check (char_length(body) <= 1000),
  url         text check (url is null or url ~ '^/'),
  image_url   text,
  kind        text not null default 'general' check (kind in ('announcement','devotional','event','care','sermon','general','followup','people','system','giving')),
  audience    text not null default 'all' check (audience in ('all','user','perm')),
  target_uid  uuid references auth.users(id) on delete cascade,
  target_perm text references private.permission_catalog(key),
  send_push   boolean not null default true,
  push        jsonb,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  check ((audience = 'user') = (target_uid is not null)),
  check ((audience = 'perm') = (target_perm is not null))
);
create index notifications_created_idx on public.notifications (created_at desc);
create index notifications_target_idx on public.notifications (target_uid, created_at desc) where audience = 'user';

create table public.notification_reads (
  uid             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (uid, notification_id)
);
create index notification_reads_notif_idx on public.notification_reads (notification_id);

create table public.push_subscriptions (
  id              text primary key,  -- sha256(endpoint)
  uid             uuid references auth.users(id) on delete cascade, -- null for visitors without an account
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_success_at timestamptz
);
create index push_uid_idx on public.push_subscriptions (uid);

/* ------------------------------------------------------------------ */
/* Settings, audit, monitoring                                         */
/* ------------------------------------------------------------------ */

create table public.settings (
  id         text primary key check (id in ('church')),
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
insert into public.settings (id, data) values ('church', '{}');

create table public.audit_logs (
  id        uuid primary key default gen_random_uuid(),
  action    text not null,
  entity    text not null,
  entity_id text,
  summary   text not null default '',
  by        uuid not null default auth.uid(),
  by_name   text not null default '',
  at        timestamptz not null default now()
);
create index audit_at_idx on public.audit_logs (at desc);

-- Client-side errors, de-duplicated per fingerprint per day (keeps the table tiny).
create table public.app_errors (
  id          bigint generated always as identity primary key,
  day         date not null default current_date,
  fingerprint text not null,
  message     text not null,
  stack       text,
  url         text,
  user_agent  text,
  release     text,
  uid         uuid,
  count       int not null default 1,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  unique (day, fingerprint)
);

create table public.job_runs (
  id          bigint generated always as identity primary key,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  detail      jsonb
);
create index job_runs_started_idx on public.job_runs (job, started_at desc);

-- Server-only configuration (VAPID keys, dispatch secret, SMS key). Never exposed to clients.
create table private.app_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

create table private.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (bucket, window_start)
);

/* updated_at triggers */
do $$
declare t text;
begin
  foreach t in array array['households','groups','members','users','followups','services','campaigns','pledges','gifts',
    'expenses','events','devotionals','sermons','announcements','care_requests','care_logs','testimonies','sms_messages',
    'sms_templates','push_subscriptions','settings']
  loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_updated', t);
  end loop;
end $$;
