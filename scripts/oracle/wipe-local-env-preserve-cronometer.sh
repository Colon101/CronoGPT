#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  echo ".env not found; nothing to wipe."
  exit 0
fi

email="$(awk -F= '$1 == "CRONOMETER_EMAIL" { sub(/^[^=]*=/, ""); print; exit }' .env)"
password="$(awk -F= '$1 == "CRONOMETER_PASSWORD" { sub(/^[^=]*=/, ""); print; exit }' .env)"

if [[ -z "$email" || -z "$password" ]]; then
  echo "Refusing to wipe .env because CRONOMETER_EMAIL or CRONOMETER_PASSWORD is missing." >&2
  exit 1
fi

umask 077
cat > .env <<EOF_ENV
CRONOMETER_EMAIL=${email}
CRONOMETER_PASSWORD=${password}
EOF_ENV

rm -f .env.production.local
echo "Local .env now contains only CRONOMETER_EMAIL and CRONOMETER_PASSWORD."
