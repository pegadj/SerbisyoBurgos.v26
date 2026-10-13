-- Community announcements (admin-posted; shown on resident bulletin)
create table if not exists public.community_announcements (
  id bigint generated always as identity primary key,
  category text not null,
  title text not null,
  body text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_community_announcements_created_at
  on public.community_announcements (created_at desc);

-- Admin-managed service catalog (replaces static rows in admin UI)
create table if not exists public.service_catalog (
  id bigint generated always as identity primary key,
  service_name text not null,
  required_documents text not null default '',
  processing_time text not null default '1-2 Days',
  status text not null default 'Active'
    check (status in ('Active', 'Under Review', 'Inactive')),
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_service_catalog_archived
  on public.service_catalog (archived_at);

drop trigger if exists service_catalog_set_updated_at on public.service_catalog;
create trigger service_catalog_set_updated_at
before update on public.service_catalog
for each row
execute function public.set_updated_at();

-- Seed default services when table is empty (idempotent)
insert into public.service_catalog (service_name, required_documents, processing_time, status)
select * from (values
  ('Barangay Clearance', 'Valid ID, Cedula', '1-2 Days', 'Active'),
  ('Certificate of Indigency', 'Voter''s ID or Brgy. ID', 'Same Day', 'Active')
) as v(service_name, required_documents, processing_time, status)
where not exists (select 1 from public.service_catalog limit 1);

-- API uses anon client for these tables; keep access consistent with other public API tables.
alter table public.community_announcements disable row level security;
alter table public.service_catalog disable row level security;
