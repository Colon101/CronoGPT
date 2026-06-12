#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/cronogpt}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.oci.yml}"
ENV_FILE="${ENV_FILE:-.env}"
REPO_URL="${REPO_URL:-https://github.com/Colon101/CronoGPT.git}"

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command on OCI host: $1" >&2
    exit 1
  fi
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "Missing Docker Compose on OCI host." >&2
    exit 1
  fi
}

require_command base64
require_command curl
require_command docker
require_command git

mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [ ! -d .git ]; then
  if [ -n "$(find . -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "$APP_DIR is not empty and is not a git checkout." >&2
    exit 1
  fi
  git clone --branch "$BRANCH" "$REPO_URL" .
fi

git remote set-url origin "$REPO_URL"
git fetch --prune origin "$BRANCH"
git reset --hard "origin/$BRANCH"

if [ -n "${ENV_FILE_BASE64:-}" ]; then
  umask 077
  printf '%s' "$ENV_FILE_BASE64" | base64 --decode > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
elif [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $APP_DIR/$ENV_FILE from .env.example. Add production secrets before enabling real Cronometer writes." >&2
fi

compose -f "$COMPOSE_FILE" build
compose -f "$COMPOSE_FILE" up -d --remove-orphans
compose -f "$COMPOSE_FILE" ps

health_url="${HEALTH_URL:-http://127.0.0.1:${CRONOGPT_HOST_PORT:-8787}/}"
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error "$health_url" >/dev/null; then
    echo "cronogpt is healthy at $health_url"
    exit 0
  fi
  sleep 2
done

echo "cronogpt did not become healthy at $health_url" >&2
compose -f "$COMPOSE_FILE" logs --tail=120 cronogpt >&2
exit 1
