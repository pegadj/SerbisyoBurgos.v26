-- Application-level audit trail (resident requests, etc.) for system-admin audit UI.
-- Auth audit_log_entries only covers login/signup/etc., not business actions.

create table if not exists public.portal_audit_events (
  id bigint generated always as identity primary key,
  action text not null,
  description text not null,
  performed_by_email text,
  performed_by_name text,
  performed_by_role text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_portal_audit_events_created_at
  on public.portal_audit_events (created_at desc);

alter table public.portal_audit_events enable row level security;
