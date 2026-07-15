# Oracle Always Free Deployment

This deployment is for one private cronogpt connector on an Oracle `VM.Standard.A1.Flex` VM.

Target VM:

- Ubuntu ARM64
- 2 OCPU / 12 GB RAM
- 50 GB boot volume
- Reserved public IP: `129.159.156.186`
- Ingress: TCP 22, 80, 443 only

Files on the VM:

- App source: `/opt/cronogpt/app`
- Non-secret config: `/opt/cronogpt/config/oracle.env`
- Secrets: `/opt/cronogpt/secrets/cronogpt.env`
- Runtime state: `/opt/cronogpt/state`

The state directory is mode `0700` and stores the persistent Chromium profile, login cooldown, and OAuth authorization-code replay ledger. Production startup fails closed if HTTPS `APP_PUBLIC_ORIGIN`, strong separate API/link secrets, or `CRONOGPT_OAUTH_STATE_FILE` are missing.

Public URL:

```text
https://cronogpt.129-159-156-186.sslip.io/mcp
```

## Main Branch Deployment Contract

Production is deployed exclusively to Oracle Cloud Infrastructure by GitHub
Actions from `main`. Future agents should push changes to `main` to test the
production deployment path. The `OCI Production` workflow builds, runs tests,
deploys the exact pushed commit to the Oracle VM with
`npm run oracle:deploy`, then runs `npm run smoke:oracle` against the public
Oracle URL.

Required GitHub Actions secret:

- `ORACLE_SSH_PRIVATE_KEY`: private key for `ubuntu@129.159.156.186`.

Optional GitHub Actions secrets:

- `CRONOGPT_API_TOKEN`
- `CRONOGPT_LINK_SECRET`
- `CRONOMETER_EMAIL`
- `CRONOMETER_PASSWORD`
- `CRONOMETER_STORAGE_STATE_BASE64`

The deploy script preserves existing values from
`/opt/cronogpt/secrets/cronogpt.env` when these optional secrets are not
provided by GitHub Actions. This keeps routine deployments from requiring
Cronometer credentials in GitHub.

Current ChatGPT connector:

- App name: `cronogpt`
- App ID: `asdk_app_6a2811e26a8481918d4596e042f50718`
- Status checked in Chrome on 2026-06-09: connected with OAuth

High-level flow:

1. Create the VM and reserved public IP in Oracle Cloud.
2. SSH to the VM and run `scripts/oracle/bootstrap-host.sh`.
3. From this repo, export `ORACLE_HOST`, `ORACLE_DOMAIN`, and optionally `ORACLE_USER`/`ORACLE_SSH_KEY`.
4. Run `npm run oracle:deploy`; it waits for the app container to become healthy and runs the production smoke unless `ORACLE_SKIP_SMOKE=true` is explicitly set.
5. Optionally rerun `npm run smoke:oracle` for an independent read-only check.
6. Reconnect ChatGPT to the Oracle `/mcp` URL.
7. Only after smoke and one live canary pass, run `npm run oracle:wipe-local-env`.

Current deploy variables:

```bash
export ORACLE_HOST=129.159.156.186
export ORACLE_DOMAIN=cronogpt.129-159-156-186.sslip.io
export ORACLE_USER=ubuntu
export ORACLE_SSH_KEY=/home/kfir/.ssh/cronogpt_oracle_ed25519
```

Quick health check:

```bash
curl https://cronogpt.129-159-156-186.sslip.io/
```
