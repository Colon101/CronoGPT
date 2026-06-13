#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

$SUDO mkdir -p /opt/cronogpt/app /opt/cronogpt/config /opt/cronogpt/secrets /opt/cronogpt/state
$SUDO chmod 755 /opt/cronogpt /opt/cronogpt/app /opt/cronogpt/config /opt/cronogpt/state
$SUDO chmod 700 /opt/cronogpt/secrets

if ! command -v docker >/dev/null 2>&1; then
  $SUDO apt-get update
  $SUDO apt-get install -y ca-certificates curl gnupg lsb-release rsync
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

$SUDO systemctl enable --now docker

if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -qi active; then
  $SUDO ufw allow OpenSSH
  $SUDO ufw allow 80/tcp
  $SUDO ufw allow 443/tcp
fi

echo "Oracle host bootstrap complete. Deploy app files to /opt/cronogpt/app next."
