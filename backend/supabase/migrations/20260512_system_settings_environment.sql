-- Single-row app settings (portal environment: production vs maintenance).
CREATE TABLE IF NOT EXISTS public.system_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  environment text NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production', 'maintenance')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.system_settings (id, environment)
VALUES (1, 'production')
ON CONFLICT (id) DO NOTHING;
