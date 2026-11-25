-- Resident survey pop-ups: the secretary creates a survey and turns it on/off; residents answer it once.
-- (Also applied automatically at server start, see server.js.)
CREATE TABLE IF NOT EXISTS surveys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL DEFAULT 'custom' CHECK (kind IN ('pets','custom')),
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  questions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active        boolean NOT NULL DEFAULT false,
  created_by_email text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS survey_responses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id        uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  resident_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (survey_id, resident_user_id)
);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses (survey_id);
