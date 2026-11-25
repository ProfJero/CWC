-- Christian Worship Centre — identity helpers, guard triggers and row level security.
-- The UI only hides what a role cannot do; this file is what enforces it.

/* ------------------------------------------------------------------ */
/* Identity helpers (SECURITY DEFINER, unexposed schema)               */
/* ------------------------------------------------------------------ */

create or replace function private.my_role()
returns text language sql stable security definer set search_path = '' as $$
  select u.role from public.users u where u.id = auth.uid() and u.is_active
$$;

create or replace function private.my_permissions()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(r.permissions, '{}')
  from public.users u join public.roles r on r.key = u.role
  where u.id = auth.uid() and u.is_active
$$;

create or replace function private.has_perm(p text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.users u join public.roles r on r.key = u.role
    where u.id = auth.uid() and u.is_active and p = any (r.permissions)
  )
$$;

-- Staff = any role that has at least one permission.
create or replace function private.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.users u join public.roles r on r.key = u.role
    where u.id = auth.uid() and u.is_active and cardinality(r.permissions) > 0
  )
$$;

create or replace function private.my_member_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select u.member_id from public.users u where u.id = auth.uid() and u.is_active
$$;

create or replace function private.is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.is_active)
$$;

create or replace function private.role_permissions(r text)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce((select permissions from public.roles where key = r), '{}')
$$;

-- Requests made with the service role (Edge Functions, cron) or directly by postgres carry no user.
-- Our own SECURITY DEFINER RPCs mark their transaction as trusted (private.trust()) after doing their own checks.
create or replace function private.is_system()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('cwc.trusted', true), ''), 'off') = 'on'
      or (auth.uid() is null
          and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', session_user::text) not in ('anon', 'authenticated'))
$$;

create or replace function private.trust(on_ boolean default true)
returns void language sql volatile set search_path = '' as $$
  select set_config('cwc.trusted', case when on_ then 'on' else 'off' end, true)
$$;

revoke all on all functions in schema private from public;
grant execute on function private.my_role(), private.my_permissions(), private.has_perm(text), private.is_staff(),
  private.my_member_id(), private.is_active_user(), private.role_permissions(text), private.is_system()
  to anon, authenticated, service_role;

/* ------------------------------------------------------------------ */
/* New auth users → public.users                                       */
/* ------------------------------------------------------------------ */

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  synthetic boolean := new.email like '%@phone.cwc.app' or new.email like '%@guest.cwc.app';
  seeded text;
begin
  if new.email_confirmed_at is not null and not synthetic then
    select role into seeded from private.role_seeds where email = lower(new.email);
  end if;
  insert into public.users (id, email, full_name, phone, role, is_guest, must_change_password)
  values (
    new.id,
    case when synthetic then '' else lower(coalesce(new.email, '')) end,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    left(coalesce(new.raw_user_meta_data ->> 'phone', ''), 20),
    coalesce(seeded, 'member'),
    coalesce((new.raw_app_meta_data ->> 'is_guest')::boolean, false),
    coalesce((new.raw_app_meta_data ->> 'must_change_password')::boolean, false)
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- A seeded email that is confirmed later (e.g. via the confirmation link) receives its role then.
create or replace function private.handle_user_confirmed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare seeded text;
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    select role into seeded from private.role_seeds where email = lower(new.email);
    if seeded is not null then
      update public.users set role = seeded where id = new.id and role = 'member';
    end if;
  end if;
  return new;
end $$;

create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row execute function private.handle_user_confirmed();

/* ------------------------------------------------------------------ */
/* Guard: users (roles, activation, linking)                           */
/* ------------------------------------------------------------------ */

create or replace function private.guard_users()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  my_perms text[];
  my_role text;
  manager boolean;
begin
  if private.is_system() then return new; end if;
  if me is null then raise exception 'Not signed in' using errcode = '42501'; end if;

  if tg_op = 'INSERT' then
    raise exception 'Accounts are created by the server' using errcode = '42501';
  end if;

  my_perms := private.my_permissions();
  my_role := private.my_role();
  manager := 'users.manage' = any (coalesce(my_perms, '{}'));

  -- Fields a person may always change on their own row
  if new.id = me and not manager then
    if new.role is distinct from old.role or new.is_active is distinct from old.is_active
       or new.member_id is distinct from old.member_id or new.email is distinct from old.email
       or (new.is_guest and not old.is_guest) or (new.must_change_password and not old.must_change_password) then
      raise exception 'You can only update your own profile details' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.id <> me and not manager then
    -- People managers may link/unlink a member record, nothing else.
    if 'people.manage' = any (coalesce(my_perms, '{}'))
       and new.member_id is distinct from old.member_id
       and (to_jsonb(new) - 'member_id' - 'updated_at') = (to_jsonb(old) - 'member_id' - 'updated_at') then
      return new;
    end if;
    raise exception 'Your role does not allow managing accounts' using errcode = '42501';
  end if;

  -- From here: a user manager.
  if new.id = me and (new.role is distinct from old.role or new.is_active is distinct from old.is_active) then
    raise exception 'You cannot change your own role or deactivate yourself' using errcode = '42501';
  end if;

  if new.role is distinct from old.role or new.is_active is distinct from old.is_active then
    -- You can only manage someone whose powers you already hold, and only grant powers you hold.
    if not (private.role_permissions(old.role) <@ my_perms) then
      raise exception 'This account has permissions you do not hold' using errcode = '42501';
    end if;
    if not (private.role_permissions(new.role) <@ my_perms) then
      raise exception 'You cannot grant a role with permissions you do not hold' using errcode = '42501';
    end if;
    -- Super admin is the top of the tree: only a super admin grants or removes it.
    if (old.role = 'super_admin' or new.role = 'super_admin') and my_role <> 'super_admin' then
      raise exception 'Only a super admin can grant or remove super admin' using errcode = '42501';
    end if;
    -- Never leave the church without an active super admin.
    if old.role = 'super_admin' and old.is_active and (new.role <> 'super_admin' or not new.is_active)
       and (select count(*) from public.users where role = 'super_admin' and is_active and id <> old.id) = 0 then
      raise exception 'There must always be at least one active super admin' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger users_guard before insert or update on public.users for each row execute function private.guard_users();

create or replace function private.guard_users_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.is_system() then return old; end if;
  raise exception 'Accounts are removed by the server' using errcode = '42501';
end $$;
create trigger users_guard_delete before delete on public.users for each row execute function private.guard_users_delete();

/* Roles: system roles cannot be renamed/deleted, super admin role cannot be weakened */
create or replace function private.guard_roles()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.is_system() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if old.is_system then raise exception 'Built-in roles cannot be deleted' using errcode = '42501'; end if;
    if exists (select 1 from public.users where role = old.key) then
      raise exception 'Move the people in this role to another role first' using errcode = '23503';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.key <> old.key then raise exception 'A role key cannot be changed' using errcode = '42501'; end if;
    if old.key in ('super_admin', 'developer', 'member') and new.permissions is distinct from old.permissions then
      raise exception 'The permissions of this built-in role are fixed' using errcode = '42501';
    end if;
    new.is_system := old.is_system;
  else
    new.is_system := false;
  end if;
  -- A role cannot be given powers the editor does not hold.
  if not (new.permissions <@ private.my_permissions()) then
    raise exception 'You cannot create a role with permissions you do not hold' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger roles_guard before insert or update or delete on public.roles for each row execute function private.guard_roles();

/* ------------------------------------------------------------------ */
/* Guard: members (self-service edits are limited)                     */
/* ------------------------------------------------------------------ */

create or replace function private.guard_members()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  allowed text[] := array['phone','alt_phone','email','address','gps_address','occupation','photo_url','dob','birth_month_day',
    'marital_status','anniversary','emergency_name','emergency_phone','emergency_relation','keywords','sms_opt_out',
    'first_name','last_name','other_names','full_name','gender','hometown','region','title','updated_at'];
  k text;
begin
  if private.is_system() or private.has_perm('people.manage') then return new; end if;
  for k in select jsonb_object_keys(to_jsonb(new)) loop
    if not (k = any (allowed)) and (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'You cannot change "%" on your record', k using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;
create trigger members_guard before update on public.members for each row execute function private.guard_members();

/* Care requests: requesters can't edit pastoral fields directly (they use RPCs) */
create or replace function private.guard_care()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.is_system() or private.has_perm('care.manage') then return new; end if;
  if tg_op = 'INSERT' then
    new.uid := auth.uid();
    new.status := 'new';
    new.responses := '[]';
    new.assigned_to := null;
    new.assigned_name := '';
    new.prayed_count := 0;
    new.scheduled_for := null;
    if new.type <> 'prayer' then new.visibility := 'private'; new.anonymous := false; end if;
    return new;
  end if;
  raise exception 'Use the app to reply to or close your request' using errcode = '42501';
end $$;
create trigger care_guard before insert or update on public.care_requests for each row execute function private.guard_care();

/* Testimonies submitted by members always start as pending */
create or replace function private.guard_testimony()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.is_system() or private.has_perm('content.manage') or private.has_perm('care.manage') then return new; end if;
  new.uid := auth.uid();
  new.status := 'pending';
  return new;
end $$;
create trigger testimonies_guard before insert on public.testimonies for each row execute function private.guard_testimony();

/* Audit rows are written as yourself and never edited */
create or replace function private.guard_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not private.is_system() then new.by := auth.uid(); new.at := now(); end if;
    return new;
  end if;
  raise exception 'The activity log is append-only' using errcode = '42501';
end $$;
create trigger audit_guard before insert or update or delete on public.audit_logs for each row execute function private.guard_audit();

/* ------------------------------------------------------------------ */
/* Counters kept by the database (no client-side increments)           */
/* ------------------------------------------------------------------ */

create or replace function private.rsvp_counter()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ev public.events;
begin
  if tg_op = 'INSERT' then
    select * into ev from public.events where id = new.event_id for update;
    if not private.is_system() and not private.has_perm('events.manage') then
      if ev.status <> 'published' or not ev.rsvp_enabled then
        raise exception 'RSVP is not open for this event' using errcode = '42501';
      end if;
      if ev.capacity is not null and ev.capacity > 0 and ev.rsvp_count >= ev.capacity then
        raise exception 'This event is fully booked' using errcode = 'P0001';
      end if;
    end if;
    update public.events set rsvp_count = rsvp_count + 1 where id = new.event_id;
    return new;
  else
    update public.events set rsvp_count = greatest(0, rsvp_count - 1) where id = old.event_id;
    return old;
  end if;
end $$;
create trigger rsvps_count_ins before insert on public.rsvps for each row execute function private.rsvp_counter();
create trigger rsvps_count_del after delete on public.rsvps for each row execute function private.rsvp_counter();

create or replace function private.attendance_counter()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ft boolean;
begin
  if tg_op = 'INSERT' then
    select membership_status = 'first_timer' into ft from public.members where id = new.member_id;
    update public.services set checkins = checkins + 1, first_timers = first_timers + case when ft then 1 else 0 end where id = new.service_id;
    return new;
  else
    select membership_status = 'first_timer' into ft from public.members where id = old.member_id;
    update public.services set checkins = greatest(0, checkins - 1), first_timers = greatest(0, first_timers - case when ft then 1 else 0 end) where id = old.service_id;
    return old;
  end if;
end $$;
create trigger attendance_count_ins after insert on public.attendance for each row execute function private.attendance_counter();
create trigger attendance_count_del after delete on public.attendance for each row execute function private.attendance_counter();

create or replace function private.pledge_paid()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.pledge_id is not null then
    update public.pledges set paid = greatest(0, paid - old.amount) where id = old.pledge_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.pledge_id is not null then
    update public.pledges set paid = paid + new.amount where id = new.pledge_id;
  end if;
  return coalesce(new, old);
end $$;
create trigger gifts_pledge after insert or update of amount, pledge_id or delete on public.gifts for each row execute function private.pledge_paid();

create or replace function private.group_counts()
returns trigger language plpgsql security definer set search_path = '' as $$
declare affected uuid[];
begin
  affected := array(select distinct x from unnest(coalesce(case when tg_op <> 'INSERT' then old.group_ids end, '{}') || coalesce(case when tg_op <> 'DELETE' then new.group_ids end, '{}')) x);
  if cardinality(affected) > 0 then
    update public.groups g set member_count = (select count(*) from public.members m where g.id = any (m.group_ids)) where g.id = any (affected);
  end if;
  return coalesce(new, old);
end $$;
create trigger members_group_counts after insert or update of group_ids or delete on public.members for each row execute function private.group_counts();

/* ------------------------------------------------------------------ */
/* Row level security                                                  */
/* ------------------------------------------------------------------ */

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- roles: readable by signed-in users (labels), managed by roles.manage
create policy roles_read on public.roles for select to authenticated using (true);
create policy roles_write on public.roles for all to authenticated
  using ((select private.has_perm('roles.manage'))) with check ((select private.has_perm('roles.manage')));

-- users
create policy users_read on public.users for select to authenticated
  using (id = (select auth.uid()) or (select private.is_staff()));
create policy users_update on public.users for update to authenticated
  using (id = (select auth.uid()) or (select private.has_perm('users.manage')) or (select private.has_perm('people.manage')))
  with check (id = (select auth.uid()) or (select private.has_perm('users.manage')) or (select private.has_perm('people.manage')));

-- members
create policy members_read on public.members for select to authenticated
  using ((select private.is_staff()) or uid = (select auth.uid()) or id = (select private.my_member_id()));
create policy members_insert on public.members for insert to authenticated
  with check ((select private.has_perm('people.manage')));
create policy members_update on public.members for update to authenticated
  using ((select private.has_perm('people.manage')) or id = (select private.my_member_id()))
  with check ((select private.has_perm('people.manage')) or id = (select private.my_member_id()));
create policy members_delete on public.members for delete to authenticated
  using ((select private.has_perm('people.delete')));

create policy households_read on public.households for select to authenticated using ((select private.is_staff()));
create policy households_write on public.households for all to authenticated
  using ((select private.has_perm('people.manage'))) with check ((select private.has_perm('people.manage')));

create policy groups_read on public.groups for select to authenticated using ((select private.is_active_user()));
create policy groups_write on public.groups for all to authenticated
  using ((select private.has_perm('groups.manage'))) with check ((select private.has_perm('groups.manage')));

create policy followups_all on public.followups for all to authenticated
  using ((select private.has_perm('followups.manage'))) with check ((select private.has_perm('followups.manage')));

-- services: open services are visible to everyone (live check-in banner)
create policy services_read on public.services for select to anon, authenticated
  using (is_open or (select private.is_staff()));
create policy services_write on public.services for insert to authenticated with check ((select private.has_perm('attendance.manage')));
create policy services_update on public.services for update to authenticated
  using ((select private.has_perm('attendance.manage'))) with check ((select private.has_perm('attendance.manage')));
create policy services_delete on public.services for delete to authenticated
  using ((select private.has_perm('attendance.manage')) and (select private.has_perm('people.manage')));

create policy attendance_read on public.attendance for select to authenticated
  using ((select private.is_staff()) or member_id = (select private.my_member_id()));
create policy attendance_write on public.attendance for all to authenticated
  using ((select private.has_perm('attendance.manage'))) with check ((select private.has_perm('attendance.manage')));

-- giving (members see only their own)
create policy gifts_read on public.gifts for select to authenticated
  using ((select private.has_perm('giving.view')) or (member_id is not null and member_id = (select private.my_member_id())));
create policy gifts_write on public.gifts for all to authenticated
  using ((select private.has_perm('giving.manage'))) with check ((select private.has_perm('giving.manage')));
create policy pledges_read on public.pledges for select to authenticated
  using ((select private.has_perm('giving.view')) or (member_id is not null and member_id = (select private.my_member_id())));
create policy pledges_write on public.pledges for all to authenticated
  using ((select private.has_perm('giving.manage'))) with check ((select private.has_perm('giving.manage')));
create policy campaigns_read on public.campaigns for select to authenticated using (true);
create policy campaigns_write on public.campaigns for all to authenticated
  using ((select private.has_perm('giving.manage'))) with check ((select private.has_perm('giving.manage')));
create policy expenses_read on public.expenses for select to authenticated
  using ((select private.has_perm('expenses.manage')) or (select private.has_perm('giving.view')));
create policy expenses_write on public.expenses for all to authenticated
  using ((select private.has_perm('expenses.manage'))) with check ((select private.has_perm('expenses.manage')));

-- events & content: published items are public (no account needed)
create policy events_read on public.events for select to anon, authenticated
  using (status = 'published' or (select private.has_perm('events.manage')));
create policy events_write on public.events for all to authenticated
  using ((select private.has_perm('events.manage'))) with check ((select private.has_perm('events.manage')));

create policy rsvps_read on public.rsvps for select to authenticated
  using (uid = (select auth.uid()) or (select private.has_perm('events.manage')));
create policy rsvps_insert on public.rsvps for insert to authenticated
  with check (uid = (select auth.uid()) and (select private.is_active_user()));
create policy rsvps_update on public.rsvps for update to authenticated
  using (uid = (select auth.uid())) with check (uid = (select auth.uid()));
create policy rsvps_delete on public.rsvps for delete to authenticated
  using (uid = (select auth.uid()) or (select private.has_perm('events.manage')));

create policy devotionals_read on public.devotionals for select to anon, authenticated
  using ((status = 'published' and date <= (now() at time zone 'Africa/Accra')::date) or (select private.has_perm('content.manage')));
create policy devotionals_write on public.devotionals for all to authenticated
  using ((select private.has_perm('content.manage'))) with check ((select private.has_perm('content.manage')));
create policy sermons_read on public.sermons for select to anon, authenticated
  using (status = 'published' or (select private.has_perm('content.manage')));
create policy sermons_write on public.sermons for all to authenticated
  using ((select private.has_perm('content.manage'))) with check ((select private.has_perm('content.manage')));
create policy announcements_read on public.announcements for select to anon, authenticated
  using (status = 'published' or (select private.has_perm('content.manage')));
create policy announcements_write on public.announcements for all to authenticated
  using ((select private.has_perm('content.manage'))) with check ((select private.has_perm('content.manage')));

-- care: requester + pastoral team only. The public prayer wall is served by get_prayer_wall(),
-- which hides names of anonymous posts and never exposes phone numbers.
create policy care_read on public.care_requests for select to authenticated
  using (uid = (select auth.uid()) or (select private.has_perm('care.view')));
create policy care_insert on public.care_requests for insert to authenticated
  with check ((select private.is_active_user()));
create policy care_update on public.care_requests for update to authenticated
  using ((select private.has_perm('care.manage'))) with check ((select private.has_perm('care.manage')));
create policy care_delete on public.care_requests for delete to authenticated
  using (uid = (select auth.uid()) or (select private.has_perm('care.manage')));

create policy care_notes_all on public.care_notes for all to authenticated
  using ((select private.has_perm('care.manage'))) with check ((select private.has_perm('care.manage')));
-- care_prayers: written only through pray_for(); no direct access
create policy care_logs_all on public.care_logs for all to authenticated
  using ((select private.has_perm('care.manage')) and (not confidential or (select private.has_perm('care.confidential'))))
  with check ((select private.has_perm('care.manage')));

create policy testimonies_read on public.testimonies for select to anon, authenticated
  using (status = 'published' or uid = (select auth.uid()) or (select private.has_perm('content.manage')) or (select private.has_perm('care.manage')));
create policy testimonies_insert on public.testimonies for insert to authenticated
  with check ((select private.is_active_user()));
create policy testimonies_manage on public.testimonies for update to authenticated
  using ((select private.has_perm('content.manage')) or (select private.has_perm('care.manage')))
  with check ((select private.has_perm('content.manage')) or (select private.has_perm('care.manage')));
create policy testimonies_delete on public.testimonies for delete to authenticated
  using ((select private.has_perm('content.manage')) or (select private.has_perm('care.manage')));

-- messaging
create policy sms_all on public.sms_messages for all to authenticated
  using ((select private.has_perm('messaging.sms'))) with check ((select private.has_perm('messaging.sms')));
create policy sms_templates_all on public.sms_templates for all to authenticated
  using ((select private.has_perm('messaging.sms'))) with check ((select private.has_perm('messaging.sms')));

create policy notifications_read on public.notifications for select to anon, authenticated
  using (
    audience = 'all'
    or (audience = 'user' and target_uid = (select auth.uid()))
    or (audience = 'perm' and (select private.has_perm(target_perm)))
    or (select private.has_perm('messaging.push'))
  );
create policy notifications_insert on public.notifications for insert to authenticated
  with check ((select private.has_perm('messaging.push')) or ((select private.has_perm('care.manage')) and audience = 'user'));
create policy notifications_delete on public.notifications for delete to authenticated
  using ((select private.has_perm('messaging.push')));

create policy notification_reads_own on public.notification_reads for all to authenticated
  using (uid = (select auth.uid())) with check (uid = (select auth.uid()));

-- push subscriptions are written via subscribe_push(); people manage their own
create policy push_read on public.push_subscriptions for select to authenticated
  using (uid = (select auth.uid()) or (select private.has_perm('system.monitor')));
create policy push_delete on public.push_subscriptions for delete to authenticated
  using (uid = (select auth.uid()));

-- settings: the church profile is public; only settings managers edit it
create policy settings_read on public.settings for select to anon, authenticated using (true);
create policy settings_write on public.settings for update to authenticated
  using ((select private.has_perm('settings.manage'))) with check ((select private.has_perm('settings.manage')));

create policy audit_read on public.audit_logs for select to authenticated using ((select private.has_perm('audit.view')));
create policy audit_insert on public.audit_logs for insert to authenticated with check ((select private.is_staff()));

create policy app_errors_read on public.app_errors for select to authenticated using ((select private.has_perm('system.monitor')));
create policy app_errors_delete on public.app_errors for delete to authenticated using ((select private.has_perm('system.monitor')));
create policy job_runs_read on public.job_runs for select to authenticated using ((select private.has_perm('system.monitor')));

/* Table privileges: explicit, least privilege */
revoke all on all tables in schema public from anon, authenticated;
grant select on public.settings, public.events, public.devotionals, public.sermons, public.announcements,
  public.testimonies, public.notifications, public.services to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete on public.app_errors, public.job_runs, public.care_prayers, public.push_subscriptions from authenticated;
grant delete on public.app_errors, public.push_subscriptions to authenticated;
revoke insert, delete on public.settings from authenticated;
revoke update, delete on public.audit_logs from authenticated;
revoke insert, delete on public.users from authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant select, insert, update, delete on all tables in schema private to service_role;
