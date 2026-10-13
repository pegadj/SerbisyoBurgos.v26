-- Resident appointment "purpose" options (purpose_code is stored in appointments.purpose).

create table if not exists public.appointment_purpose_catalog (
  id bigint generated always as identity primary key,
  purpose_code text not null,
  label text not null,
  sort_order int not null default 0,
  archived_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_appointment_purpose_catalog_archived
  on public.appointment_purpose_catalog (archived_at);

-- Only one *active* row per code (archived rows may keep the same code historically).
create unique index if not exists idx_appointment_purpose_code_active
  on public.appointment_purpose_catalog (purpose_code)
  where (archived_at is null);

alter table public.appointment_purpose_catalog disable row level security;

insert into public.appointment_purpose_catalog (purpose_code, label, sort_order)
select * from (values
  ('in-person', 'In-person Document Processing', 1),
  ('pickup', 'Document / ID Pickup', 2),
  ('consultation', 'Face-to-Face Consultation', 3)
) as v(purpose_code, label, sort_order)
where not exists (select 1 from public.appointment_purpose_catalog limit 1);
