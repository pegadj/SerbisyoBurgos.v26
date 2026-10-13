-- Optional contact number for residents (and other roles); used by resident portal profile.
alter table public.profiles
  add column if not exists contact_number text;

comment on column public.profiles.contact_number is 'Resident/staff contact phone; editable by resident via portal API.';
