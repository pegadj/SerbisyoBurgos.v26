-- Staff module access flags (set when barangay admin creates staff via portal).
alter table public.profiles
  add column if not exists staff_permissions jsonb;

comment on column public.profiles.staff_permissions is
  'For role=staff: { dashboard, appointmentScheduling, requestProcessing, documentGenerator } booleans.';
