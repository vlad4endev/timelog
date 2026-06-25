-- Fix RLS empty results: PostgREST often exposes JWT only via request.jwt.claims (JSON).
-- Safe to re-apply after migrate-rls.sh (10-rls-isolation.sql).

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

-- Optional: diagnose JWT context via GET /rest/v1/rpc/debug_jwt_context (with user JWT)
CREATE OR REPLACE FUNCTION public.debug_jwt_context()
RETURNS json
  LANGUAGE sql STABLE
AS $$
  SELECT json_build_object(
    'db_role', current_user,
    'claim_login', current_setting('request.jwt.claim.login', true),
    'claim_sub', current_setting('request.jwt.claim.sub', true),
    'claims_raw', current_setting('request.jwt.claims', true),
    'app_jwt_login', app_jwt_login()
  );
$$;

GRANT EXECUTE ON FUNCTION public.debug_jwt_context() TO timelog_user;
