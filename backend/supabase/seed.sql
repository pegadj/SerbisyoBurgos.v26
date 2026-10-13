insert into public.profiles (email, full_name, role)
values
  ('admin@serbisyoburgos.com', 'Barangay Admin', 'admin'),
  ('staff@serbisyoburgos.com', 'Barangay Staff', 'staff'),
  ('systemadmin@serbisyoburgos.com', 'System Administrator', 'system-admin')
on conflict (email) do update
set
  full_name = excluded.full_name,
  role = excluded.role;
