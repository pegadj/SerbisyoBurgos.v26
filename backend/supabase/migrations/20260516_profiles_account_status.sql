-- Resident (and catalog) portal access gate: enforced for residents at login/API.
alter table public.profiles
  add column if not exists account_status text not null default 'active';

alter table public.profiles drop constraint if exists profiles_account_status_check;
alter table public.profiles
  add constraint profiles_account_status_check
  check (account_status in ('active', 'suspended', 'deactivated'));

comment on column public.profiles.account_status is 'active | suspended | deactivated. Residents with non-active cannot use the resident portal (login + API).';
