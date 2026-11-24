-- Supabase Auth sets app_metadata after the initial insert, so mirror server-set flags on update too.
-- app_metadata can only be written by the server (service role), never by users.
create or replace function private.handle_user_app_meta()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.raw_app_meta_data is distinct from old.raw_app_meta_data then
    update public.users set
      is_guest = case when (new.raw_app_meta_data ->> 'is_guest')::boolean is true and (old.raw_app_meta_data ->> 'is_guest') is null then true else is_guest end,
      must_change_password = case when (new.raw_app_meta_data ->> 'must_change_password')::boolean is true
                                   and (old.raw_app_meta_data ->> 'must_change_password') is distinct from 'true' then true else must_change_password end
    where id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_app_meta on auth.users;
create trigger on_auth_user_app_meta after update of raw_app_meta_data on auth.users
  for each row execute function private.handle_user_app_meta();
revoke execute on function private.handle_user_app_meta() from public, anon, authenticated;

-- Realtime only for the screens that are live: notification feed, service check-in, care thread.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications, public.attendance, public.services, public.care_requests;
  end if;
end $$;
