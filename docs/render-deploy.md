# Deploy cronogpt on Render

## What Render runs

`render.yaml` defines one public Docker web service named `cronogpt`. The Docker image uses the official Playwright Node image so the browser backend can launch Chromium locally on Render.

The service exposes:

```text
GET /
POST|GET|DELETE /mcp
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-authorization-server
GET /.well-known/openid-configuration
GET|POST /oauth/authorize
POST /oauth/register
POST /oauth/token
```

## Required Render secrets

Fill these in the Render Dashboard when creating the Blueprint:

```text
CRONOGPT_API_TOKEN
CRONOGPT_LINK_SECRET
CRONOMETER_EMAIL
CRONOMETER_PASSWORD
CRONOMETER_STORAGE_STATE_BASE64
TERRA_API_KEY
TERRA_DEV_ID
TERRA_USER_ID
```

Terra values are optional unless `CRONOMETER_BACKEND=terra`. For the browser backend, `CRONOMETER_STORAGE_STATE_BASE64` is strongly recommended so the hosted browser can reuse a logged-in Cronometer session.

## Deploy

```bash
npm run build
git add Dockerfile .dockerignore render.yaml docs/render-deploy.md
git commit -m "Move cronogpt deployment to Render"
git push origin main
```

Then create the Blueprint from:

```text
https://dashboard.render.com/blueprint/new?repo=https://github.com/Colon101/CronoGPT
```

After the deploy is live, set the ChatGPT app MCP URL to:

```text
https://cronogpt.onrender.com/mcp
```

When ChatGPT opens the cronogpt OAuth page, use `CRONOGPT_LINK_SECRET`; if it is not set, use `CRONOGPT_API_TOKEN`.

For custom recipes, run `resolve_recipe_ingredients` first and carry both the chosen `selectedName` and `selectedSource` into `create_recipe`. The browser writer refuses ambiguous matches and returns candidates rather than selecting the first search result.

## Verify

```bash
curl https://cronogpt.onrender.com/
CRONOGPT_SMOKE_URL=https://cronogpt.onrender.com/mcp npm run smoke:production
```
