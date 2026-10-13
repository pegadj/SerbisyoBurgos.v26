create table if not exists public.service_requests (
  id bigint generated always as identity primary key,
  reference_no text not null unique,
  title text not null,
  service_type text not null,
  preferred_date date not null,
  preferred_time_slot text not null,
  status text not null default 'Pending' check (status in ('Pending', 'Processing', 'In Progress', 'Approved', 'Ready for Pickup', 'Completed', 'Revision Requested', 'Rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists service_requests_set_updated_at on public.service_requests;
create trigger service_requests_set_updated_at
before update on public.service_requests
for each row
execute function public.set_updated_at();
