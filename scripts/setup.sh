#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "${1:-16}"
  else
    node -e "console.log(require('crypto').randomBytes(${1:-16}).toString('hex'))"
  fi
}

if [[ ! -f .env ]]; then
  echo "→ Creating .env from .env.example"
  cp .env.example .env
  POSTGRES_PASSWORD="$(random_hex 16)"
  AUTHENTICATOR_PASSWORD="$(random_hex 16)"
  JWT_SECRET="$(random_hex 32)"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/change_me_postgres_password/${POSTGRES_PASSWORD}/" .env
    sed -i '' "s/change_me_authenticator_password/${AUTHENTICATOR_PASSWORD}/" .env
    sed -i '' "s/change_me_jwt_secret_min_32_characters_long/${JWT_SECRET}/" .env
  else
    sed -i "s/change_me_postgres_password/${POSTGRES_PASSWORD}/" .env
    sed -i "s/change_me_authenticator_password/${AUTHENTICATOR_PASSWORD}/" .env
    sed -i "s/change_me_jwt_secret_min_32_characters_long/${JWT_SECRET}/" .env
  fi
  echo "✓ Generated random secrets in .env"
else
  echo "→ Using existing .env"
  # shellcheck disable=SC1091
  set -a && source .env && set +a
fi

# shellcheck disable=SC1091
set -a && source .env && set +a

if [[ -z "${JWT_SECRET:-}" || ${#JWT_SECRET} -lt 32 ]]; then
  echo "✕ JWT_SECRET must be at least 32 characters in .env"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "→ Installing Node dependencies (jose, pngjs)..."
  npm install --no-fund --no-audit
fi

echo "→ Generating anon JWT..."
ANON_KEY="$(JWT_SECRET="$JWT_SECRET" node scripts/generate-jwt.mjs)"

if grep -q '^ANON_KEY=.' .env 2>/dev/null; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|^ANON_KEY=.*|ANON_KEY=${ANON_KEY}|" .env
  else
    sed -i "s|^ANON_KEY=.*|ANON_KEY=${ANON_KEY}|" .env
  fi
else
  echo "ANON_KEY=${ANON_KEY}" >> .env
fi

if [[ ! -f icon-192.png ]]; then
  echo "→ Generating PWA icons..."
  npm run icons
fi

chmod +x docker/postgres/init/02-roles.sh docker/docker-entrypoint.sh 2>/dev/null || true

echo ""
echo "✓ Setup complete"
echo "  Dev:    docker compose up -d --build"
echo "  Prod:   ./scripts/deploy.sh prod"
echo "  TLS:    ./scripts/deploy.sh tls   (needs PUBLIC_HOST in .env)"
echo "  Open:   http://localhost:${HTTP_PORT:-8080}"
echo "  Logs:   docker compose logs -f"
echo "  Stop:   docker compose down"
