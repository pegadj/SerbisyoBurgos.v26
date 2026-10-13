-- Expose auth.audit_log_entries to the API service role: PostgREST does not reliably
-- query auth.* via supabase-js .schema("auth"), which causes "Unable to read audit tables".

create or replace function public.list_auth_audit_log_entries(p_limit integer default 150)
returns table (
  id uuid,
  instance_id uuid,
  payload jsonb,
  created_at timestamptz,
  ip_address text
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    e.id,
    e.instance_id,
    coalesce(e.payload::jsonb, '{}'::jsonb),
    e.created_at,
    coalesce(nullif(trim(e.ip_address::text), ''), '')
  from auth.audit_log_entries e
  order by e.created_at desc nulls last
  limit least(greatest(coalesce(p_limit, 150), 1), 500);
$$;

comment on function public.list_auth_audit_log_entries(integer) is
  'Returns recent auth.audit_log_entries for trusted backend (service_role).';

revoke all on function public.list_auth_audit_log_entries(integer) from public;
revoke all on function public.list_auth_audit_log_entries(integer) from anon;
revoke all on function public.list_auth_audit_log_entries(integer) from authenticated;
grant execute on function public.list_auth_audit_log_entries(integer) to service_role;
