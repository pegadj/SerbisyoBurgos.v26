-- True when the resident profile was created via public portal self-registration.
alter table public.profiles
  add column if not exists resident_self_registered boolean not null default false;

comment on column public.profiles.resident_self_registered is
  'Set true when account is created through /auth/resident/register; admin UI uses this instead of browser localStorage.';
