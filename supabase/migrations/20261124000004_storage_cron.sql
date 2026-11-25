-- Christian Worship Centre — media storage and scheduled jobs.

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */
-- media:    public files (photos, event banners, sermon audio). Uploads are role-checked.
-- receipts: private expense receipts, served through short-lived signed URLs.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present — skipping buckets';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('media', 'media', true, 52428800, array['image/jpeg','image/png','image/webp','image/gif','audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/wav','audio/x-m4a'])
  on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('receipts', 'receipts', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf'])
  on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  -- media: avatars/<uid>/… is yours; every other folder needs a matching staff permission
  execute $p$
    create policy media_insert on storage.objects for insert to authenticated with check (
      bucket_id = 'media' and (
        ((storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = (select auth.uid())::text)
        or ((storage.foldername(name))[1] in ('events') and (select private.has_perm('events.manage')))
        or ((storage.foldername(name))[1] in ('devotionals', 'sermons', 'announcements') and (select private.has_perm('content.manage')))
        or ((storage.foldername(name))[1] = 'members' and (select private.has_perm('people.manage')))
        or ((storage.foldername(name))[1] = 'branding' and (select private.has_perm('settings.manage')))
      ))
  $p$;
  execute $p$
    create policy media_select on storage.objects for select to authenticated using (
      bucket_id = 'media' and (owner_id = (select auth.uid())::text or (select private.is_staff())))
  $p$;
  execute $p$
    create policy media_modify on storage.objects for update to authenticated using (
      bucket_id = 'media' and (owner_id = (select auth.uid())::text or (select private.has_perm('settings.manage'))))
  $p$;
  execute $p$
    create policy media_delete on storage.objects for delete to authenticated using (
      bucket_id = 'media' and (owner_id = (select auth.uid())::text or (select private.has_perm('settings.manage'))))
  $p$;

  execute $p$
    create policy receipts_insert on storage.objects for insert to authenticated with check (
      bucket_id = 'receipts' and (select private.has_perm('expenses.manage')))
  $p$;
  execute $p$
    create policy receipts_select on storage.objects for select to authenticated using (
      bucket_id = 'receipts' and ((select private.has_perm('expenses.manage')) or (select private.has_perm('giving.view'))))
  $p$;
  execute $p$
    create policy receipts_delete on storage.objects for delete to authenticated using (
      bucket_id = 'receipts' and (select private.has_perm('expenses.manage')))
  $p$;
end $$;

/* ------------------------------------------------------------------ */
/* Scheduled jobs (pg_cron + pg_net). Light: one call a day, one a week */
/* ------------------------------------------------------------------ */
do $$
begin
  begin
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_net/pg_cron unavailable — skipping schedules (%).', sqlerrm;
    return;
  end;

  -- Daily 07:00 Africa/Accra (= UTC): birthday SMS, event reminders, house-keeping report.
  perform cron.schedule('cwc-daily', '0 7 * * *', $job$
    select net.http_post(
      url := (select value from private.app_config where key = 'functions_url') || '/v1/jobs/daily',
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-cwc-secret', (select value from private.app_config where key = 'dispatch_secret')),
      timeout_milliseconds := 60000)
    where exists (select 1 from private.app_config where key = 'functions_url')
  $job$);

  -- Weekly clean-up keeps the database well inside free-tier limits.
  perform cron.schedule('cwc-weekly-cleanup', '17 3 * * 0', $job$ select private.cleanup() $job$);
end $$;
