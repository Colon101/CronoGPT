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

Public URL:

```text
https://cronogpt.129-159-156-186.sslip.io/mcp
```

Current ChatGPT connector:

- App name: `cronogpt`
- App ID: `asdk_app_6a2811e26a8481918d4596e042f50718`
- Status checked in Chrome on 2026-06-09: connected with OAuth
- Old Render connector `https://cronogpt.onrender.com/mcp`: deleted from ChatGPT app settings

High-level flow:

1. Create the VM and reserved public IP in Oracle Cloud.
2. SSH to the VM and run `scripts/oracle/bootstrap-host.sh`.
3. From this repo, export `ORACLE_HOST`, `ORACLE_DOMAIN`, and optionally `ORACLE_USER`/`ORACLE_SSH_KEY`.
4. Run `npm run oracle:deploy`.
5. Run `npm run smoke:oracle`.
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
