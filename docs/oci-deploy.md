# Deploy cronogpt on an OCI VM

This repo can deploy to a long-lived Oracle Cloud Infrastructure VM through GitHub Actions. The action SSHes into the VM, updates the checkout to `origin/main`, rebuilds the Docker image, restarts Compose, and checks `GET /`.

## VM setup

Create or reuse an OCI VM that can run Docker. The examples below assume an Ubuntu-like host and a deploy user named `ubuntu`.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
sudo mkdir -p /opt/cronogpt
sudo chown ubuntu:ubuntu /opt/cronogpt
```

Log out and back in after adding the user to the `docker` group.

Open the VM firewall and OCI ingress rules for whatever public port or reverse proxy you use. The Compose file defaults to `8787:8787`. ChatGPT app connections need HTTPS, so put Caddy, Nginx, Cloudflare Tunnel, or another TLS layer in front of the service before using it as a real connector.

## App environment

Keep production app secrets on the server unless you intentionally want GitHub Actions to manage them. On the VM:

```bash
cd /opt/cronogpt
git clone https://github.com/Colon101/CronoGPT.git .
cp .env.example .env
chmod 600 .env
```

Edit `/opt/cronogpt/.env` for OCI. The important production values are usually:

```text
APP_PUBLIC_ORIGIN=https://your-domain.example
CRONOGPT_API_TOKEN=generate-a-long-random-token
CRONOGPT_LINK_SECRET=optional-separate-link-code
CRONOMETER_BACKEND=browser
CRONOMETER_EMAIL=...
CRONOMETER_PASSWORD=...
CRONOMETER_STORAGE_STATE_BASE64=...
CRONOMETER_ENABLE_WRITES=true
CRONOMETER_LOCAL_CHROMIUM=true
CRONOMETER_REUSE_LOCAL_BROWSER=false
CRONOMETER_TIME_ZONE=Asia/Jerusalem
```

If you prefer GitHub to replace the server `.env` on each deploy, base64-encode the whole env file and store it as `OCI_ENV_FILE_BASE64`:

```bash
base64 < .env | tr -d '\n'
```

## GitHub secrets

Add these repository secrets under Settings -> Secrets and variables -> Actions:

```text
OCI_SSH_HOST          VM public IP or DNS name
OCI_SSH_USER          SSH user, for example ubuntu
OCI_SSH_PRIVATE_KEY   Private key allowed to SSH into the VM
```

Optional secrets:

```text
OCI_APP_DIR           Defaults to /opt/cronogpt
OCI_ENV_FILE_BASE64   Replaces /opt/cronogpt/.env on deploy
OCI_HEALTH_URL        Defaults to http://127.0.0.1:8787/
OCI_REPO_URL          Defaults to https://github.com/Colon101/CronoGPT.git
OCI_SSH_KNOWN_HOSTS   Pinned known_hosts entry; otherwise the workflow uses ssh-keyscan
OCI_SSH_PORT          Defaults to 22
```

One simple deploy-key path:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/cronogpt_oci_deploy -C "github-actions-cronogpt-oci"
ssh-copy-id -i ~/.ssh/cronogpt_oci_deploy.pub ubuntu@YOUR_OCI_HOST
```

Paste the private key file contents into `OCI_SSH_PRIVATE_KEY`.

## Deploy flow

Every push to `main` runs `.github/workflows/deploy-oci.yml`:

1. Install dependencies with `npm ci`.
2. Typecheck/build with `npm run build`.
3. SSH to the OCI VM.
4. Run `scripts/deploy-oci.sh` remotely.
5. Rebuild and restart `docker-compose.oci.yml`.
6. Fail the workflow if the local health check does not pass.

You can also run the workflow manually from the GitHub Actions tab.

## Manual server commands

Useful when checking the VM directly:

```bash
cd /opt/cronogpt
docker compose -f docker-compose.oci.yml ps
docker compose -f docker-compose.oci.yml logs -f cronogpt
curl http://127.0.0.1:8787/
```

Run the production smoke test from a trusted machine that has `CRONOGPT_API_TOKEN`:

```bash
CRONOGPT_SMOKE_URL=https://your-domain.example/mcp npm run smoke:production
```
