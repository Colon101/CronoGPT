# Deploy CronoGPT on Vercel

## Required environment

```text
APP_PUBLIC_ORIGIN=https://your-project.vercel.app
CRONOGPT_API_TOKEN=long-random-private-token
CRONOGPT_LINK_SECRET=optional-separate-chatgpt-link-code
CRONOMETER_BACKEND=browser
CRONOMETER_EMAIL=your-cronometer-email
CRONOMETER_PASSWORD=your-cronometer-password
CRONOMETER_STORAGE_STATE_BASE64=optional-playwright-storage-state
CRONOMETER_SERVERLESS_CHROMIUM=true
REMOTE_CHROME_WS_ENDPOINT=wss://your-browserless-or-compatible-endpoint
CRONOMETER_ENABLE_WRITES=true
CRONOMETER_NAVIGATION_TIMEOUT_MS=45000
CRONOMETER_LOGIN_BACKOFF_MS=900000
```

`REMOTE_CHROME_WS_ENDPOINT` is optional when serverless Chromium is enabled. Browserless or another remote Chrome CDP endpoint is still the better production choice because Vercel functions are ephemeral and time-limited. Add `CRONOMETER_STORAGE_STATE_BASE64` when Cronometer starts challenging fresh headless logins. `CRONOMETER_LOGIN_BACKOFF_MS` stops repeated login attempts during temporary rate limits.

Write tools require `CRONOMETER_ENABLE_WRITES=true` plus both call arguments:

```json
{ "dryRun": false, "confirmed": true }
```

## Optional read API

If you add Terra, read tools can use a supported API path instead of scraping the web UI:

```text
TERRA_API_KEY=...
TERRA_DEV_ID=...
TERRA_USER_ID=...
```

## Vercel commands

```bash
npm install
npm run build
vercel
```

After deploy, connect ChatGPT to:

```text
https://your-project.vercel.app/mcp
```

The endpoint rejects unauthenticated MCP traffic. ChatGPT should use OAuth. Direct MCP clients must send:

```text
Authorization: Bearer <CRONOGPT_API_TOKEN>
```

When ChatGPT opens the CronoGPT OAuth page, use `CRONOGPT_LINK_SECRET`; if it is not set, use `CRONOGPT_API_TOKEN`.

## Recipe workflow

1. Call `resolve_recipe_ingredients` with the recipe ingredient list.
2. Pick the best Cronometer match for each ingredient.
3. Call `create_recipe` with the selected foods and `dryRun=true`.
4. Review the preview.
5. Call `create_recipe` again with `dryRun=false` and `confirmed=true`.

The hosted browser adapter opens the custom recipe editor, fills the recipe name/servings, opens `ADD INGREDIENTS`, searches each ingredient, and selects matches. Keep the first real runs in dry-run mode and review the visible result before enabling writes.
