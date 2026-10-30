#!/bin/sh
# Generates the local secrets of the demo in ./keys (gitignored):
#
#   keys/jwt-private.pem      signs the viewer JWTs (read by the app)
#   keys/jwt-public.pem       verifies them (given to Document Engine)
#   keys/document-engine.env  JWT_PUBLIC_KEY, API_AUTH_TOKEN, SECRET_KEY_BASE
#   keys/app.env              DE_API_TOKEN (same value as API_AUTH_TOKEN)
#
# Run it once before `docker compose up`. Pass --force to replace existing keys.
set -eu
cd "$(dirname "$0")/.."

if [ -f keys/jwt-private.pem ] && [ "${1:-}" != "--force" ]; then
  echo "keys/ already exists. Use --force to generate new keys."
  exit 0
fi

mkdir -p keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/jwt-private.pem 2>/dev/null
openssl pkey -in keys/jwt-private.pem -pubout -out keys/jwt-public.pem
chmod 600 keys/jwt-private.pem

api_token=$(openssl rand -hex 32)
secret_key_base=$(openssl rand -hex 64)
# The PEM goes on one line, with \n escapes inside double quotes, which
# Docker Compose expands when it reads the env file.
public_key=$(awk 'BEGIN { ORS = "" } { if (NR > 1) print "\\n"; print }' keys/jwt-public.pem)

cat > keys/document-engine.env <<ENV
JWT_PUBLIC_KEY="$public_key"
API_AUTH_TOKEN=$api_token
SECRET_KEY_BASE=$secret_key_base
ENV

cat > keys/app.env <<ENV
DE_API_TOKEN=$api_token
ENV

chmod 600 keys/document-engine.env keys/app.env
echo "Generated keys/jwt-private.pem, keys/jwt-public.pem, keys/document-engine.env and keys/app.env."
