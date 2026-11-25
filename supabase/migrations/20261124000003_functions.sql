-- Christian Worship Centre — RPCs, automatic notifications, push dispatch and on-demand monitoring.

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

create or replace function private.my_name()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(u.full_name, ''), 'Member') from public.users u where u.id = auth.uid()
$$;

create or replace function private.notify(
  p_title text, p_body text, p_url text, p_kind text, p_audience text,
  p_target_uid uuid default null, p_target_perm text default null, p_push boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare nid uuid;
begin
  insert into public.notifications (title, body, url, kind, audience, target_uid, target_perm, send_push, created_by)
  values (left(p_title, 140), left(coalesce(p_body, ''), 1000), p_url, p_kind, p_audience, p_target_uid, p_target_perm, p_push, auth.uid())
  returning id into nid;
  return nid;
end $$;

/* ------------------------------------------------------------------ */
/* Prayer wall (public, sanitised)                                     */
/* ------------------------------------------------------------------ */

create or replace function public.get_prayer_wall(p_key text default null, p_limit int default 60)
returns table (id uuid, subject text, details text, name text, anonymous boolean, prayed_count int,
               created_at timestamptz, latest_reply jsonb, prayed boolean, mine boolean)
language sql stable security definer set search_path = '' as $$
  select c.id, c.subject, c.details,
         case when c.anonymous then 'Someone in our church' else c.name end,
         c.anonymous, c.prayed_count, c.created_at,
         (select r from jsonb_array_elements(c.responses) r where coalesce((r ->> 'staff')::boolean, false) order by (r ->> 'at')::bigint desc limit 1),
         exists (select 1 from public.care_prayers p where p.care_request_id = c.id
                 and p.prayer_key in ('u:' || coalesce(auth.uid()::text, '-'), 'd:' || coalesce(left(p_key, 64), '-'))),
         c.uid is not distinct from auth.uid() and auth.uid() is not null
  from public.care_requests c
  where c.visibility = 'public' and c.type = 'prayer' and c.status not in ('closed', 'completed')
  order by c.created_at desc
  limit least(greatest(coalesce(p_limit, 60), 1), 200)
$$;

create or replace function public.pray_for(p_id uuid, p_key text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare k text; n int;
begin
  if auth.uid() is not null then k := 'u:' || auth.uid()::text;
  elsif p_key ~ '^[A-Za-z0-9-]{16,64}$' then k := 'd:' || p_key;
  else raise exception 'Missing device key' using errcode = '22023';
  end if;
  if not exists (select 1 from public.care_requests where id = p_id and visibility = 'public' and type = 'prayer') then
    raise exception 'Prayer request not found' using errcode = 'P0002';
  end if;
  insert into public.care_prayers (care_request_id, prayer_key) values (p_id, k) on conflict do nothing;
  if found then
    perform private.trust();
    update public.care_requests set prayed_count = prayed_count + 1 where id = p_id returning prayed_count into n;
    perform private.trust(false);
  else
    select prayed_count into n from public.care_requests where id = p_id;
  end if;
  return n;
end $$;

/* ------------------------------------------------------------------ */
/* Care conversations                                                  */
/* ------------------------------------------------------------------ */

create or replace function public.add_care_response(p_id uuid, p_text text, p_close boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.care_requests;
  staff boolean := private.has_perm('care.manage');
  entry jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if char_length(coalesce(trim(p_text), '')) = 0 or char_length(p_text) > 3000 then
    raise exception 'Write a message (up to 3000 characters)' using errcode = '22023';
  end if;
  select * into c from public.care_requests where id = p_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if not staff and c.uid is distinct from auth.uid() then raise exception 'Not your request' using errcode = '42501'; end if;
  if not staff and c.status in ('closed', 'completed') then raise exception 'This request is closed' using errcode = '42501'; end if;

  entry := jsonb_build_object('text', trim(p_text), 'by', private.my_name(), 'at', (extract(epoch from now()) * 1000)::bigint,
                              'uid', auth.uid(), 'staff', staff and c.uid is distinct from auth.uid());
  perform private.trust();
  update public.care_requests
     set responses = responses || entry,
         status = case when p_close and not staff then 'closed'
                       when staff and status = 'new' then 'in_progress' else status end
   where id = p_id;
  perform private.trust(false);

  if staff and c.uid is not null and c.uid <> auth.uid() then
    perform private.notify('A pastor replied to your ' || case c.type when 'prayer' then 'prayer request' when 'counselling' then 'counselling request' when 'visit' then 'visit request' else 'request' end,
      left(trim(p_text), 160), '/care/' || c.id, 'care', 'user', c.uid);
  end if;
  return entry;
end $$;

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

create or replace function public.self_check_in(p_service uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare s public.services; mid uuid := private.my_member_id(); mname text;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if mid is null then return 'unlinked'; end if;
  select * into s from public.services where id = p_service;
  if not found then return 'missing'; end if;
  if exists (select 1 from public.attendance where service_id = p_service and member_id = mid) then return 'done'; end if;
  if not s.is_open then return 'closed'; end if;
  select full_name into mname from public.members where id = mid;
  insert into public.attendance (service_id, service_type, date, member_id, member_name, method, by)
  values (p_service, s.type, s.date, mid, coalesce(mname, ''), 'self', auth.uid())
  on conflict (service_id, member_id) do nothing;
  return 'done';
end $$;

create or replace function public.bump_headcount(p_service uuid, p_key text, p_by int)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare h jsonb;
begin
  if p_key not in ('men', 'women', 'children', 'visitors') or abs(p_by) > 100 then
    raise exception 'Invalid headcount change' using errcode = '22023';
  end if;
  update public.services
     set headcount = jsonb_set(coalesce(headcount, '{}'), array[p_key], to_jsonb(greatest(0, coalesce((headcount ->> p_key)::int, 0) + p_by)))
   where id = p_service
   returning headcount into h;
  if h is null then raise exception 'Service not found or not allowed' using errcode = '42501'; end if;
  return h;
end $$;

/* ------------------------------------------------------------------ */
/* Profiles: "complete your profile" without a full sign-up            */
/* ------------------------------------------------------------------ */

create or replace function public.complete_profile(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  mid uuid;
  fname text := left(trim(coalesce(p ->> 'firstName', '')), 60);
  lname text := left(trim(coalesce(p ->> 'lastName', '')), 60);
  ph text := regexp_replace(coalesce(p ->> 'phone', ''), '\D', '', 'g');
  st text := coalesce(p ->> 'membershipStatus', 'visitor');
  v_dob date := nullif(p ->> 'dob', '')::date;
  full_n text;
begin
  if me is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if fname = '' or lname = '' then raise exception 'Please enter your first and last name' using errcode = '22023'; end if;
  if ph !~ '^\d{9,15}$' then raise exception 'Please enter a valid phone number' using errcode = '22023'; end if;
  if st not in ('visitor', 'first_timer', 'member', 'new_convert') then st := 'visitor'; end if;
  full_n := fname || ' ' || lname;

  update public.users set full_name = full_n, phone = ph where id = me;
  select member_id into mid from public.users where id = me;

  if mid is null then
    insert into public.members (first_name, last_name, full_name, phone, email, gender, dob, address, gps_address,
      occupation, how_heard, invited_by, membership_status, uid, self_registered, verified, join_date, keywords, created_by)
    values (fname, lname, full_n, ph, nullif(lower(trim(p ->> 'email')), ''),
      case when p ->> 'gender' in ('male', 'female') then p ->> 'gender' else '' end, v_dob,
      left(p ->> 'address', 200), left(p ->> 'gpsAddress', 20), left(p ->> 'occupation', 80),
      left(p ->> 'howHeard', 120), left(p ->> 'invitedBy', 120), st, me, true, false, (now() at time zone 'Africa/Accra')::date,
      array(select distinct w from unnest(string_to_array(lower(full_n || ' ' || ph), ' ')) w where w <> ''), me)
    returning id into mid;
    perform private.trust();
    update public.users set member_id = mid where id = me;
    perform private.trust(false);

    if st in ('visitor', 'first_timer', 'new_convert') then
      insert into public.followups (member_id, name, phone, kind, stage, notes, due_date)
      values (mid, full_n, ph, case when st = 'new_convert' then 'new_convert' else 'first_timer' end, 'new',
              jsonb_build_array(jsonb_build_object('text', 'Registered in the app', 'by', 'CWC app', 'at', (extract(epoch from now()) * 1000)::bigint)),
              (now() at time zone 'Africa/Accra')::date + 3);
    end if;
    perform private.notify('New person registered', full_n || ' completed their profile in the app.', '/admin/people/' || mid, 'people', 'perm', null, 'people.manage');
  else
    update public.members set
      first_name = fname, last_name = lname, full_name = full_n, phone = ph,
      email = coalesce(nullif(lower(trim(p ->> 'email')), ''), email),
      gender = case when p ->> 'gender' in ('male', 'female') then p ->> 'gender' else gender end,
      dob = coalesce(v_dob, dob),
      address = coalesce(nullif(p ->> 'address', ''), address),
      gps_address = coalesce(nullif(p ->> 'gpsAddress', ''), gps_address),
      occupation = coalesce(nullif(p ->> 'occupation', ''), occupation)
    where id = mid;
  end if;
  return mid;
end $$;

create or replace function public.link_user_member(p_user uuid, p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare old_member uuid;
begin
  if not (private.has_perm('users.manage') or private.has_perm('people.manage')) then
    raise exception 'Your role does not allow linking accounts' using errcode = '42501';
  end if;
  select member_id into old_member from public.users where id = p_user;
  if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
  if old_member is not null then update public.members set uid = null where id = old_member and uid = p_user; end if;
  if p_member is not null then
    update public.users set member_id = null where member_id = p_member and id <> p_user;
    update public.members set uid = null where uid = p_user and id <> p_member;
    update public.members set uid = p_user where id = p_member;
  end if;
  update public.users set member_id = p_member where id = p_user;
  insert into public.audit_logs (action, entity, entity_id, summary, by, by_name)
  values ('update', 'users', p_user::text, case when p_member is null then 'Unlinked member record' else 'Linked member record' end, auth.uid(), private.my_name());
end $$;

-- Merge a duplicate (e.g. a self-registered profile) into an existing record.
create or replace function public.merge_members(p_keep uuid, p_remove uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.members; k public.members;
begin
  if not (private.has_perm('people.manage') and private.has_perm('people.delete')) then
    raise exception 'Your role does not allow merging records' using errcode = '42501';
  end if;
  if p_keep = p_remove then raise exception 'Choose two different records' using errcode = '22023'; end if;
  select * into k from public.members where id = p_keep for update;
  select * into r from public.members where id = p_remove for update;
  if k.id is null or r.id is null then raise exception 'Record not found' using errcode = 'P0002'; end if;

  update public.attendance a set member_id = p_keep where member_id = p_remove
    and not exists (select 1 from public.attendance b where b.service_id = a.service_id and b.member_id = p_keep);
  delete from public.attendance where member_id = p_remove;
  update public.gifts set member_id = p_keep, member_name = k.full_name where member_id = p_remove;
  update public.pledges set member_id = p_keep, member_name = k.full_name where member_id = p_remove;
  update public.followups set member_id = p_keep where member_id = p_remove;
  update public.care_requests set member_id = p_keep where member_id = p_remove;
  update public.care_logs set member_id = p_keep where member_id = p_remove;

  update public.members set
    group_ids = array(select distinct unnest(k.group_ids || r.group_ids)),
    tags = array(select distinct unnest(k.tags || r.tags)),
    email = coalesce(nullif(k.email, ''), r.email),
    dob = coalesce(k.dob, r.dob),
    alt_phone = coalesce(nullif(k.alt_phone, ''), nullif(r.phone, k.phone)),
    photo_url = coalesce(nullif(k.photo_url, ''), r.photo_url),
    address = coalesce(nullif(k.address, ''), r.address),
    verified = true
  where id = p_keep;

  if r.uid is not null and k.uid is null then
    update public.members set uid = null where id = p_remove;
    update public.members set uid = r.uid where id = p_keep;
  end if;
  update public.users set member_id = p_keep where member_id = p_remove
    and not exists (select 1 from public.users where member_id = p_keep);
  delete from public.members where id = p_remove;
  insert into public.audit_logs (action, entity, entity_id, summary, by, by_name)
  values ('update', 'members', p_keep::text, 'Merged ' || r.full_name || ' into ' || k.full_name, auth.uid(), private.my_name());
end $$;

/* ------------------------------------------------------------------ */
/* Groups & follow-ups                                                 */
/* ------------------------------------------------------------------ */

create or replace function public.set_group_membership(p_members uuid[], p_group uuid, p_add boolean)
returns int language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  if p_add then
    update public.members set group_ids = array(select distinct unnest(group_ids || p_group))
     where id = any (p_members) and not (p_group = any (group_ids));
  else
    update public.members set group_ids = array_remove(group_ids, p_group) where id = any (p_members);
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.followup_add_note(p_id uuid, p_text text, p_stage text default null)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.followups
     set notes = notes || jsonb_build_object('text', left(p_text, 2000), 'by', private.my_name(), 'at', (extract(epoch from now()) * 1000)::bigint),
         stage = coalesce(p_stage, stage)
   where id = p_id;
  if not found then raise exception 'Follow-up not found or not allowed' using errcode = '42501'; end if;
end $$;

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns int language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  if auth.uid() is null then return 0; end if;
  insert into public.notification_reads (uid, notification_id)
  select auth.uid(), id from public.notifications
   where (p_ids is null or id = any (p_ids)) and created_at > now() - interval '120 days'
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.subscribe_push(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare host text := substring(p_endpoint from '^https://([^/:]+)'); sid text;
begin
  if host is null or not (
       host = 'fcm.googleapis.com' or host = 'android.googleapis.com' or host like '%.push.services.mozilla.com'
       or host = 'web.push.apple.com' or host like '%.push.apple.com' or host like '%.notify.windows.com') then
    raise exception 'Unsupported push service' using errcode = '22023';
  end if;
  if char_length(p_endpoint) > 1000 or coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{60,120}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,40}$' then
    raise exception 'Invalid push subscription' using errcode = '22023';
  end if;
  sid := encode(extensions.digest(p_endpoint, 'sha256'), 'hex');
  insert into public.push_subscriptions (id, uid, endpoint, p256dh, auth, user_agent)
  values (sid, auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 200))
  on conflict (id) do update set uid = coalesce(auth.uid(), public.push_subscriptions.uid), p256dh = excluded.p256dh,
    auth = excluded.auth, user_agent = excluded.user_agent;
  return sid;
end $$;

create or replace function public.unsubscribe_push(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint
$$;

-- Fan out push for a new notification through the Edge Function (pg_net). No-op until configured.
create or replace function private.dispatch_push()
returns trigger language plpgsql security definer set search_path = '' as $$
declare u text; s text;
begin
  if not new.send_push then return new; end if;
  select value into u from private.app_config where key = 'functions_url';
  select value into s from private.app_config where key = 'dispatch_secret';
  if u is null or s is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return new; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 15000)'
    using u || '/v1/push/dispatch', jsonb_build_object('id', new.id), jsonb_build_object('Content-Type', 'application/json', 'x-cwc-secret', s);
  return new;
end $$;
create trigger notifications_dispatch after insert on public.notifications for each row execute function private.dispatch_push();

/* Automatic notifications for staff and members */
create or replace function private.on_care_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.notify(
    case new.type when 'prayer' then 'New prayer request' when 'counselling' then 'New counselling request'
      when 'visit' then 'Visit requested' when 'urgent' then 'URGENT: pastoral need' else 'New care request' end,
    case when new.type = 'counselling' then new.name || ' asked to speak with a pastor.'
      else new.name || ': ' || left(coalesce(nullif(new.subject, ''), new.details), 120) end,
    '/admin/care?id=' || new.id, 'care', 'perm', null,
    case when new.type = 'counselling' then 'care.confidential' else 'care.view' end);
  return new;
end $$;
create trigger care_created_notify after insert on public.care_requests for each row execute function private.on_care_created();

create or replace function private.on_testimony_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'pending' then
    perform private.notify('Testimony awaiting review', new.name || ': ' || left(new.title, 100), '/admin/care?tab=testimonies', 'care', 'perm', null, 'content.manage', false);
  end if;
  return new;
end $$;
create trigger testimony_created_notify after insert on public.testimonies for each row execute function private.on_testimony_created();

create or replace function private.on_followup_assigned()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_to is not null and new.assigned_to is distinct from auth.uid()
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    perform private.notify('Follow-up assigned to you', new.name || coalesce(' · due ' || to_char(new.due_date, 'DD Mon'), ''), '/admin/follow-ups', 'followup', 'user', new.assigned_to);
  end if;
  return new;
end $$;
create trigger followup_assigned_notify after insert or update of assigned_to on public.followups for each row execute function private.on_followup_assigned();

/* ------------------------------------------------------------------ */
/* Monitoring (on demand only — nothing polls)                         */
/* ------------------------------------------------------------------ */

create or replace function public.log_client_error(p_message text, p_stack text default null, p_url text default null, p_release text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare fp text; today_rows int;
begin
  if coalesce(trim(p_message), '') = '' then return; end if;
  fp := encode(extensions.digest(left(p_message, 300) || '|' || coalesce(substring(p_stack from '^[^\n]*\n?[^\n]*'), ''), 'sha256'), 'hex');
  update public.app_errors set count = count + 1, last_at = now(), uid = coalesce(auth.uid(), uid)
   where day = current_date and fingerprint = fp;
  if found then return; end if;
  select count(*) into today_rows from public.app_errors where day = current_date;
  if today_rows >= 300 then return; end if;  -- hard cap: protects database size
  insert into public.app_errors (fingerprint, message, stack, url, user_agent, release, uid)
  values (fp, left(p_message, 500), left(p_stack, 4000), left(p_url, 300),
          left(nullif(current_setting('request.headers', true), '')::jsonb ->> 'user-agent', 300), left(p_release, 40), auth.uid())
  on conflict (day, fingerprint) do update set count = public.app_errors.count + 1, last_at = now();
end $$;

create or replace function private.cleanup()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a int; b int; c int; d int; e int;
begin
  delete from public.app_errors where day < current_date - 30; get diagnostics a = row_count;
  delete from public.notifications where created_at < now() - interval '180 days'; get diagnostics b = row_count;
  delete from public.job_runs where started_at < now() - interval '90 days'; get diagnostics c = row_count;
  delete from private.rate_limits where window_start < now() - interval '2 days'; get diagnostics d = row_count;
  delete from public.push_subscriptions where last_success_at < now() - interval '120 days'
     or (last_success_at is null and created_at < now() - interval '120 days'); get diagnostics e = row_count;
  return jsonb_build_object('errors', a, 'notifications', b, 'job_runs', c, 'rate_limits', d, 'stale_push', e);
end $$;

create or replace function public.dev_maintenance(p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int; res jsonb;
begin
  if not private.has_perm('system.monitor') then raise exception 'Developer access required' using errcode = '42501'; end if;
  case p_action
    when 'cleanup' then res := private.cleanup();
    when 'clear_errors' then delete from public.app_errors; get diagnostics n = row_count; res := jsonb_build_object('errors', n);
    when 'analyze' then analyze; res := jsonb_build_object('ok', true);
    else raise exception 'Unknown action' using errcode = '22023';
  end case;
  insert into public.audit_logs (action, entity, summary, by, by_name) values ('update', 'system', 'Maintenance: ' || p_action, auth.uid(), private.my_name());
  return res;
end $$;

create or replace function public.dev_system_health()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  out jsonb := '{}';
  t jsonb;
begin
  if not private.has_perm('system.monitor') then raise exception 'Developer access required' using errcode = '42501'; end if;

  out := out || jsonb_build_object('generatedAt', now(), 'db', jsonb_build_object(
    'sizeBytes', pg_database_size(current_database()),
    'limitBytes', 500 * 1024 * 1024,
    'connections', (select count(*) from pg_stat_activity where datname = current_database()),
    'maxConnections', current_setting('max_connections')::int,
    'cacheHitRatio', (select round(sum(heap_blks_hit)::numeric / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 4) from pg_statio_user_tables),
    'version', split_part(version(), ' ', 2),
    'uptimeSeconds', extract(epoch from now() - pg_postmaster_start_time())::bigint));

  select coalesce(jsonb_agg(jsonb_build_object('name', relname, 'rows', n_live_tup, 'dead', n_dead_tup,
           'sizeBytes', pg_total_relation_size(relid)) order by pg_total_relation_size(relid) desc), '[]')
    into t from pg_stat_user_tables where schemaname = 'public';
  out := out || jsonb_build_object('tables', t);

  out := out || jsonb_build_object('auth', jsonb_build_object(
    'users', (select count(*) from auth.users),
    'signups7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'active7d', (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'active30d', (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
    'mauLimit', 50000));

  out := out || jsonb_build_object('app', jsonb_build_object(
    'members', (select count(*) from public.members),
    'unverifiedMembers', (select count(*) from public.members where not verified),
    'guestAccounts', (select count(*) from public.users where is_guest),
    'staff', (select count(*) from public.users u join public.roles r on r.key = u.role where cardinality(r.permissions) > 0 and u.is_active),
    'inactiveAccounts', (select count(*) from public.users where not is_active),
    'pushSubscriptions', (select count(*) from public.push_subscriptions),
    'notifications7d', (select count(*) from public.notifications where created_at > now() - interval '7 days'),
    'openCare', (select count(*) from public.care_requests where status in ('new', 'in_progress'))));

  out := out || jsonb_build_object('roles', (select coalesce(jsonb_agg(jsonb_build_object('role', r.key, 'label', r.label, 'count',
      (select count(*) from public.users u where u.role = r.key)) order by r.sort), '[]') from public.roles r));

  out := out || jsonb_build_object('errors', jsonb_build_object(
    'today', (select coalesce(sum(count), 0) from public.app_errors where day = current_date),
    'last7d', (select coalesce(sum(count), 0) from public.app_errors where day > current_date - 7),
    'top', (select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('id', id, 'message', message, 'url', url, 'count', count, 'lastAt', last_at, 'release', release, 'stack', left(stack, 1200)) x
      from public.app_errors order by last_at desc limit 25) s)));

  out := out || jsonb_build_object('jobs', (select coalesce(jsonb_agg(x), '[]') from (
    select distinct on (job) jsonb_build_object('job', job, 'startedAt', started_at, 'finishedAt', finished_at, 'ok', ok, 'detail', detail) x
    from public.job_runs order by job, started_at desc) s));

  out := out || jsonb_build_object('integrations', jsonb_build_object(
    'pushDispatch', exists (select 1 from private.app_config where key = 'functions_url') and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null,
    'vapid', exists (select 1 from private.app_config where key = 'vapid_private_key'),
    'smsKey', exists (select 1 from private.app_config where key = 'profjero_api_key'),
    'cron', to_regclass('cron.job') is not null));

  if to_regclass('storage.objects') is not null then
    execute $q$ select jsonb_build_object('objects', count(*), 'bytes', coalesce(sum((metadata ->> 'size')::bigint), 0), 'limitBytes', 1073741824)
                from storage.objects $q$ into t;
    out := out || jsonb_build_object('storage', t);
  end if;

  if to_regclass('cron.job_run_details') is not null then
    execute $q$ select coalesce(jsonb_agg(x), '[]') from (
      select jsonb_build_object('job', j.jobname, 'schedule', j.schedule, 'lastStatus', d.status, 'lastRun', d.start_time, 'message', left(d.return_message, 200)) x
      from cron.job j left join lateral (select * from cron.job_run_details r where r.jobid = j.jobid order by r.start_time desc limit 1) d on true) s $q$ into t;
    out := out || jsonb_build_object('cron', t);
  end if;
  return out;
end $$;

-- Developers paste integration keys in the app; they can be replaced but never read back.
create or replace function public.set_integration_secret(p_key text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_perm('system.monitor') then raise exception 'Developer access required' using errcode = '42501'; end if;
  if p_key not in ('profjero_api_key') then raise exception 'Unknown integration key' using errcode = '22023'; end if;
  if coalesce(trim(p_value), '') = '' then
    delete from private.app_config where key = p_key;
  else
    insert into private.app_config (key, value) values (p_key, trim(p_value))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  insert into public.audit_logs (action, entity, summary, by, by_name) values ('update', 'system', 'Updated integration key ' || p_key, auth.uid(), private.my_name());
end $$;

/* ------------------------------------------------------------------ */
/* Server-only helpers (Edge Function, service role)                   */
/* ------------------------------------------------------------------ */

create or replace function public.hit_rate_limit(p_bucket text, p_max int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds); c int;
begin
  insert into private.rate_limits (bucket, window_start, count) values (left(p_bucket, 200), w, 1)
  on conflict (bucket, window_start) do update set count = private.rate_limits.count + 1
  returning count into c;
  return c <= p_max;
end $$;

create or replace function public.server_config(p_keys text[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}') from private.app_config where key = any (p_keys)
$$;

create or replace function public.server_set_config(p_key text, p_value text, p_overwrite boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  if p_overwrite then
    insert into private.app_config (key, value) values (p_key, p_value) on conflict (key) do update set value = excluded.value, updated_at = now();
  else
    insert into private.app_config (key, value) values (p_key, p_value) on conflict (key) do nothing;
  end if;
  select value into v from private.app_config where key = p_key;
  return v;
end $$;

create or replace function public.server_cleanup()
returns jsonb language sql security definer set search_path = '' as $$ select private.cleanup() $$;

insert into private.app_config (key, value) values ('dispatch_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

/* Function privileges: nothing is callable unless granted here */
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.get_prayer_wall(text, int), public.pray_for(uuid, text),
  public.subscribe_push(text, text, text, text), public.unsubscribe_push(text),
  public.log_client_error(text, text, text, text) to anon, authenticated;
grant execute on function public.add_care_response(uuid, text, boolean), public.self_check_in(uuid),
  public.bump_headcount(uuid, text, int), public.complete_profile(jsonb), public.link_user_member(uuid, uuid),
  public.merge_members(uuid, uuid), public.set_group_membership(uuid[], uuid, boolean),
  public.followup_add_note(uuid, text, text), public.mark_notifications_read(uuid[]),
  public.dev_system_health(), public.dev_maintenance(text), public.set_integration_secret(text, text) to authenticated;
grant execute on all functions in schema public to service_role;
grant execute on function private.notify(text, text, text, text, text, uuid, text, boolean) to service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Private helpers are only for policies and our own functions.
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.my_role(), private.my_permissions(), private.has_perm(text), private.is_staff(),
  private.my_member_id(), private.is_active_user(), private.role_permissions(text), private.is_system()
  to anon, authenticated, service_role;
alter default privileges in schema private revoke execute on functions from public;
