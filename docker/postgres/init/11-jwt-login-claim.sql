-- Robust JWT login claim for PostgREST RLS (some versions expose claims differently)

CREATE OR REPLACE FUNCTION app_jwt_login() RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.login', true), ''),
    NULLIF(current_setting('request.jwt.claims', true)::json->>'login', '')
  );
$$;
