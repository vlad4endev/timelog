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
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon;
EOSQL
