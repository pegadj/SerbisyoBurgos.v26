do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'service_requests'
      and column_name = 'resident_user_id'
  ) then
    alter table public.service_requests
      alter column resident_user_id drop not null;
  end if;
end $$;
