-- Persist staff status timeline for request processing UI; expand appointment statuses for processing workflow.

alter table public.service_requests
  add column if not exists status_timeline jsonb not null default '[]'::jsonb;

alter table public.appointments
  add column if not exists status_timeline jsonb not null default '[]'::jsonb;

-- Replace appointment status CHECK to allow Processing / Ready for Pickup (keep legacy values).
do $$
declare
  r record;
begin
  for r in (
    select c.conname
    from pg_constraint c
    join pg_class t on c.conrelid = t.oid
    join pg_namespace n on n.oid = t.relnamespace
    where t.relname = 'appointments'
      and n.nspname = 'public'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%status%'
  ) loop
    execute format('alter table public.appointments drop constraint if exists %I', r.conname);
  end loop;
end $$;

alter table public.appointments
  add constraint appointments_status_check
  check (
    status in (
      'Pending Review',
      'Processing',
      'Ready for Pickup',
      'Confirmed',
      'Completed',
      'Cancelled',
      'Rejected'
    )
  );
