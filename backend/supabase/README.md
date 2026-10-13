# Supabase folder guide

This folder stores your SQL schema and seed data for the backend.

## Files

- `migrations/20260421_initial_schema.sql` - base table and RLS policies.
- `seed.sql` - default sample records.
- `config.toml` - local Supabase CLI config (optional).

## How to use

If you use Supabase dashboard SQL editor:
1. Run `migrations/20260421_initial_schema.sql`.
2. Run `seed.sql`.

If you use Supabase CLI:
1. Install CLI: `npm i -g supabase`
2. From `backend`: `supabase link --project-ref <your-project-ref>`
3. Push migration: `supabase db push`
