-- Cloudinary is the media service. Developers store its keys in the app; like the SMS key they
-- can be replaced but never read back by any client.
create or replace function public.set_integration_secret(p_key text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_perm('system.monitor') then raise exception 'Developer access required' using errcode = '42501'; end if;
  if p_key not in ('profjero_api_key', 'cloudinary_cloud_name', 'cloudinary_api_key', 'cloudinary_api_secret') then
    raise exception 'Unknown integration key' using errcode = '22023';
  end if;
  if coalesce(trim(p_value), '') = '' then
    delete from private.app_config where key = p_key;
  else
    insert into private.app_config (key, value) values (p_key, trim(p_value))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  insert into public.audit_logs (action, entity, summary, by, by_name) values ('update', 'system', 'Updated integration key ' || p_key, auth.uid(), private.my_name());
end $$;

-- Public, non-secret media settings for the app (cloud name only).
create or replace function public.media_config()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'provider', case when exists (select 1 from private.app_config where key = 'cloudinary_api_secret')
                      and exists (select 1 from private.app_config where key = 'cloudinary_api_key')
                      and exists (select 1 from private.app_config where key = 'cloudinary_cloud_name') then 'cloudinary' else 'supabase' end,
    'cloudName', (select value from private.app_config where key = 'cloudinary_cloud_name'))
$$;

-- Surface Cloudinary status in the developer console.
create or replace function private.integration_flags()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cloudinary', (select count(*) = 3 from private.app_config where key in ('cloudinary_cloud_name', 'cloudinary_api_key', 'cloudinary_api_secret')),
    'cloudinaryCloudName', (select value from private.app_config where key = 'cloudinary_cloud_name'))
$$;

create or replace function public.dev_integrations()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_perm('system.monitor') then raise exception 'Developer access required' using errcode = '42501'; end if;
  return private.integration_flags();
end $$;

revoke execute on function public.media_config(), public.dev_integrations(), private.integration_flags() from public, anon, authenticated;
grant execute on function public.media_config() to anon, authenticated;
grant execute on function public.dev_integrations() to authenticated;
grant execute on function public.set_integration_secret(text, text) to authenticated;
