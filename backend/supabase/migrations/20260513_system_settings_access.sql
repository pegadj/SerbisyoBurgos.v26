-- Ensure PostgREST can read/write this row (upsert/update) when migrations run on Supabase.
-- Service role bypasses RLS, but RLS enabled with no policy still blocks the anon key if used server-side.
ALTER TABLE IF EXISTS public.system_settings DISABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.system_settings TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.system_settings TO service_role;
