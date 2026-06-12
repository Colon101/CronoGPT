# Agent Map

This repo is extremely vibe coded. Treat it like a useful personal automation prototype with real health-account blast radius, not like a polished platform.

## What this is

- A TypeScript Apps SDK/MCP server for Cronometer.
- Runtime entrypoint: `src/server.ts`.
- MCP and OAuth plumbing: `src/mcp.ts` and `src/oauth.ts`.
- Cronometer providers: `src/providers/`.
- Browser automation provider: `src/providers/browser.ts`.
- ChatGPT widget: `public/cronometer-widget.html`.
- Production container: `Dockerfile`.

## Safety posture

- Never commit `.env`, Cronometer credentials, storage-state files, API tokens, SSH keys, or browser cookies.
- Prefer `dryRun=true` while changing write tools.
- Keep destructive account actions disabled or manual-only.
- Browser automation is inherently brittle. Check selectors, timeouts, and failure messages with care.
- Do not expose Cronometer email/password to ChatGPT, widget metadata, logs, `structuredContent`, or docs examples.

## Local checks

Run these before pushing:

```bash
npm ci
npm run build
```

For MCP inspection:

```bash
npm run dev
npm run inspect
```

For hosted verification, set `CRONOGPT_API_TOKEN` and run:

```bash
CRONOGPT_SMOKE_URL=https://your-domain.example/mcp npm run smoke:production
```

## Deployment map

- Render path: `render.yaml` and `docs/render-deploy.md`.
- OCI path: `.github/workflows/deploy-oci.yml`, `docker-compose.oci.yml`, `scripts/deploy-oci.sh`, and `docs/oci-deploy.md`.
- The OCI workflow deploys only after `npm run build` passes.
- The OCI VM should own production `.env` by default. Use `OCI_ENV_FILE_BASE64` only when you intentionally want GitHub Actions to replace the server env file.

## OCI secrets expected by GitHub Actions

Required:

```text
OCI_SSH_HOST
OCI_SSH_USER
OCI_SSH_PRIVATE_KEY
```

Optional:

```text
OCI_APP_DIR
OCI_ENV_FILE_BASE64
OCI_HEALTH_URL
OCI_REPO_URL
OCI_SSH_KNOWN_HOSTS
OCI_SSH_PORT
```

## Change style

- Keep changes boring and small.
- Do not refactor browser automation while also changing deploy plumbing.
- When adding a tool, document whether it reads, writes, needs confirmation, or can be dry-run.
- If the browser provider starts failing, first check login/session state, Cronometer UI drift, timeouts, and memory pressure in the container.
