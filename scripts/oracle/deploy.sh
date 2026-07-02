#!/usr/bin/env bash
set -euo pipefail

ORACLE_USER="${ORACLE_USER:-ubuntu}"
: "${ORACLE_HOST:?Set ORACLE_HOST to the Oracle VM public IP or hostname.}"
: "${ORACLE_DOMAIN:?Set ORACLE_DOMAIN, for example cronogpt.203-0-113-10.sslip.io.}"

SSH_TARGET="${ORACLE_USER}@${ORACLE_HOST}"
SSH_ARGS=()
RSYNC_SSH="ssh"
if [[ -n "${ORACLE_SSH_KEY:-}" ]]; then
  SSH_ARGS=(-i "$ORACLE_SSH_KEY")
  RSYNC_SSH="ssh -i $ORACLE_SSH_KEY"
fi

sync_app_source() {
  if command -v rsync >/dev/null 2>&1; then
    rsync -az --delete \
      --exclude-from=.dockerignore \
      -e "$RSYNC_SSH" \
      ./ "$SSH_TARGET:/opt/cronogpt/app/"
    return
  fi

  echo "Local rsync is unavailable; falling back to git-file tar sync." >&2
  ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "find /opt/cronogpt/app -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
  git ls-files --cached --others --exclude-standard -z \
    | while IFS= read -r -d '' path; do
        [[ -e "$path" ]] && printf '%s\0' "$path"
      done \
    | tar --null --files-from=- -czf - \
    | ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "tar -xzf - -C /opt/cronogpt/app"
}

secret_or_remote_required() {
  local key="$1"
  local value="${!key:-}"
  if [[ -z "$value" ]]; then
    value="$(awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' .env 2>/dev/null || true)"
  fi
  if [[ -z "$value" ]]; then
    value="$(remote_secret "$key")"
  fi
  if [[ -z "$value" ]]; then
    echo "Missing $key. Export it, keep it in local .env, or ensure it already exists on the Oracle secret file." >&2
    exit 1
  fi
  printf '%s' "$value"
}

remote_secret() {
  local key="$1"
  ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "awk -F= -v k='$key' '\$1 == k { sub(/^[^=]*=/, \"\"); print; exit }' /opt/cronogpt/secrets/cronogpt.env 2>/dev/null || true"
}

secret_or_remote_or_generate() {
  local key="$1"
  local value="${!key:-}"
  if [[ -z "$value" ]]; then
    value="$(awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' .env 2>/dev/null || true)"
  fi
  if [[ -z "$value" ]]; then
    value="$(remote_secret "$key")"
  fi
  if [[ -z "$value" ]]; then
    value="$(openssl rand -hex 32)"
  fi
  printf '%s' "$value"
}

secret_or_remote_optional() {
  local key="$1"
  local value="${!key:-}"
  if [[ -z "$value" ]]; then
    value="$(awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' .env 2>/dev/null || true)"
  fi
  if [[ -z "$value" ]]; then
    value="$(remote_secret "$key")"
  fi
  printf '%s' "$value"
}

API_TOKEN="$(secret_or_remote_or_generate CRONOGPT_API_TOKEN)"
LINK_SECRET="$(secret_or_remote_or_generate CRONOGPT_LINK_SECRET)"
CRONOMETER_EMAIL_VALUE="$(secret_or_remote_required CRONOMETER_EMAIL)"
CRONOMETER_PASSWORD_VALUE="$(secret_or_remote_required CRONOMETER_PASSWORD)"
CRONOMETER_STORAGE_STATE_VALUE="$(secret_or_remote_optional CRONOMETER_STORAGE_STATE_BASE64)"

ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "bash -s" < scripts/oracle/bootstrap-host.sh
ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "sudo chown -R $ORACLE_USER:$ORACLE_USER /opt/cronogpt/app /opt/cronogpt/config /opt/cronogpt/secrets /opt/cronogpt/state && chmod 700 /opt/cronogpt/secrets"

sync_app_source

ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "cat > /opt/cronogpt/config/oracle.env" <<EOF_REMOTE_CONFIG
CRONOGPT_DOMAIN=${ORACLE_DOMAIN}
APP_PUBLIC_ORIGIN=https://${ORACLE_DOMAIN}
CRONOMETER_BACKEND=browser
CRONOMETER_ENABLE_WRITES=true
CRONOMETER_REQUIRE_FOOD_CONFIRMATION=false
CRONOMETER_LOCAL_CHROMIUM=true
CRONOMETER_REUSE_REMOTE_CONTEXT=false
CRONOMETER_REUSE_LOCAL_BROWSER=true
CRONOMETER_BROWSER_PROFILE_DIR=/opt/cronogpt/state/chromium-profile
CRONOMETER_NAVIGATION_TIMEOUT_MS=60000
CRONOMETER_OPERATION_TIMEOUT_MS=180000
CRONOMETER_BROWSER_RETRY_COUNT=1
CRONOMETER_LOGIN_BACKOFF_MS=900000
CRONOMETER_LOGIN_BACKOFF_FILE=/opt/cronogpt/state/cronometer-login-backoff.json
CRONOMETER_TIME_ZONE=Asia/Jerusalem
CRONOGPT_FULL_TOOL_SURFACE=false
CRONOGPT_GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
CRONOGPT_BUILD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF_REMOTE_CONFIG

ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "cat > /opt/cronogpt/secrets/cronogpt.env && chmod 600 /opt/cronogpt/secrets/cronogpt.env" <<EOF_REMOTE_SECRETS
CRONOGPT_API_TOKEN=${API_TOKEN}
CRONOGPT_LINK_SECRET=${LINK_SECRET}
CRONOMETER_EMAIL=${CRONOMETER_EMAIL_VALUE}
CRONOMETER_PASSWORD=${CRONOMETER_PASSWORD_VALUE}
CRONOMETER_STORAGE_STATE_BASE64=${CRONOMETER_STORAGE_STATE_VALUE}
EOF_REMOTE_SECRETS

ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "cd /opt/cronogpt/app && sudo docker compose -f deploy/oracle/docker-compose.yml --env-file /opt/cronogpt/config/oracle.env up -d --build"

echo "Deployed cronogpt to https://${ORACLE_DOMAIN}/mcp"
echo "Use the CRONOGPT_API_TOKEN and CRONOGPT_LINK_SECRET values from the remote secret file; they were not printed."
