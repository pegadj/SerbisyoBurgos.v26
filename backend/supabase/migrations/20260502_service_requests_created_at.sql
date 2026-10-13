-- Older deployments may lack created_at on service_requests; API month filters use preferred_date, but the column should exist for consistency.
alter table public.service_requests
  add column if not exists created_at timestamptz not null default now();
