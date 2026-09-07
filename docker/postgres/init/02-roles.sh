#!/bin/bash
set -euo pipefail

AUTH_PASS="${AUTHENTICATOR_PASSWORD:-changeme_authenticator}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$ BEGIN
    CREATE ROLE anon NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END \$\$;

  DO \$\$ BEGIN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${AUTH_PASS}';
  EXCEPTION WHEN duplicate_object THEN
    ALTER ROLE authenticator WITH PASSWORD '${AUTH_PASS}';
  END \$\$;

  GRANT anon TO authenticator;
  GRANT USAGE ON SCHEMA public TO anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;
  -- Deliberately NO 'ALTER DEFAULT PRIVILEGES ... TO anon' here. Default
  -- privileges apply to every table created LATER, so they quietly undid
  -- 10-rls-isolation.sql's 'REVOKE ALL ... FROM anon' for anything a later
  -- migration added (user_settings in 12- came back writable by the
  -- unauthenticated PostgREST role). The grants above cover the tables that
  -- exist during init; 10- revokes them once RLS is in place.
EOSQL
