-- Reserved (seeded) leader emails cannot be self-registered: only pre-created accounts get those roles.
create or replace function public.server_email_reserved(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.role_seeds where email = lower(trim(p_email)))
$$;
revoke execute on function public.server_email_reserved(text) from public, anon, authenticated;
grant execute on function public.server_email_reserved(text) to service_role;

create or replace function public.server_role_seeds()
returns table (email text, role text) language sql stable security definer set search_path = '' as $$
  select email, role from private.role_seeds order by email
$$;
revoke execute on function public.server_role_seeds() from public, anon, authenticated;
grant execute on function public.server_role_seeds() to service_role;
