-- Public URL to the resident's profile photo (Supabase Storage object).
alter table public.profiles
  add column if not exists avatar_url text;

comment on column public.profiles.avatar_url is 'Optional profile image URL (e.g. Storage public URL); set by resident portal API.';

-- Bucket for resident profile images (server uploads with service role; public read).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resident-avatars',
  'resident-avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public read resident avatars" on storage.objects;
create policy "Public read resident avatars"
on storage.objects
for select
using (bucket_id = 'resident-avatars');
