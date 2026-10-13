-- URL to resident-uploaded ID (Supabase Storage public object).
alter table public.profiles
  add column if not exists identity_verification_url text;

comment on column public.profiles.identity_verification_url is 'Public URL for identity verification document (JPEG, PNG, or PDF); set at self-registration.';

-- Bucket for resident ID documents (server uploads with service role; public read).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resident-identity-documents',
  'resident-identity-documents',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'application/pdf']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public read resident identity documents" on storage.objects;
create policy "Public read resident identity documents"
on storage.objects
for select
using (bucket_id = 'resident-identity-documents');
