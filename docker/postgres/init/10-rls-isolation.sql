-- Server-enforced per-user data isolation (Row Level Security)

-- Role used by authenticated API requests (JWT claim: role = timelog_user)
DO $$ BEGIN
  CREATE ROLE timelog_user NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT timelog_user TO authenticator;
GRANT USAGE ON SCHEMA public TO timelog_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO timelog_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO timelog_user;

-- Current user login from PostgREST JWT (login + sub claims; claims JSON fallback)
CREATE OR REPLACE FUNCTION app_jwt_login() RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.login', true), ''),
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(
      CASE
        WHEN COALESCE(current_setting('request.jwt.claims', true), '') = '' THEN NULL
        ELSE current_setting('request.jwt.claims', true)::json->>'login'
      END,
      ''
    ),
    NULLIF(
      CASE
        WHEN COALESCE(current_setting('request.jwt.claims', true), '') = '' THEN NULL
        ELSE current_setting('request.jwt.claims', true)::json->>'sub'
      END,
      ''
    )
  );
$$;

-- ─── RLS: tables with user_login column ─────────────────────────────────

ALTER TABLE projects         ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_tasks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_blocks  ENABLE ROW LEVEL SECURITY;

ALTER TABLE projects         FORCE ROW LEVEL SECURITY;
ALTER TABLE board_tasks      FORCE ROW LEVEL SECURITY;
ALTER TABLE time_entries     FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_reports  FORCE ROW LEVEL SECURITY;
ALTER TABLE payments         FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_blocks  FORCE ROW LEVEL SECURITY;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'board_tasks', 'time_entries', 'billing_reports',
    'payments', 'schedule_overrides', 'schedule_blocks'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_user_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO timelog_user
         USING (user_login = app_jwt_login())
         WITH CHECK (user_login = app_jwt_login())',
      t || '_user_isolation', t
    );
  END LOOP;
END $$;

-- ─── RLS: per-user id tables (id = login) ───────────────────────────────

ALTER TABLE active_timer     ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_timer     FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS active_timer_user_isolation ON active_timer;
CREATE POLICY active_timer_user_isolation ON active_timer
  FOR ALL TO timelog_user
  USING (id = app_jwt_login())
  WITH CHECK (id = app_jwt_login());

DROP POLICY IF EXISTS schedule_settings_user_isolation ON schedule_settings;
CREATE POLICY schedule_settings_user_isolation ON schedule_settings
  FOR ALL TO timelog_user
  USING (id = app_jwt_login())
  WITH CHECK (id = app_jwt_login());

-- ─── app_users: only via auth service (direct DB), not PostgREST anon ───

-- ENABLE with no policy is already "no rows for anyone but the owner", which
-- is exactly what we want: PostgREST (anon / timelog_user) sees nothing, the
-- auth service connects as the owner over DATABASE_URL and reads normally.
-- NOT forced on purpose — FORCE subjects the owner to RLS too, so the auth
-- service could only ever read this table by virtue of POSTGRES_USER being a
-- superuser in the postgres image. Point DATABASE_URL at a non-superuser
-- owner and every login silently became "invalid credentials".
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_users NO FORCE ROW LEVEL SECURITY;

-- Legacy single-user table — block API access
DO $$ BEGIN
  ALTER TABLE app_auth ENABLE ROW LEVEL SECURITY;
  ALTER TABLE app_auth NO FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Revoke direct anon access to all data (auth service uses DB owner connection)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
-- ...and make sure nothing re-grants it to tables added by later migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
