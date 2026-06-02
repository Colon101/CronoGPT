# Deploy cronogpt on Vercel

This is the legacy serverless deployment path. The current hosted path is Render; see `docs/render-deploy.md`.

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
CRONOMETER_REQUIRE_FOOD_CONFIRMATION=false
CRONOMETER_NAVIGATION_TIMEOUT_MS=45000
CRONOMETER_LOGIN_BACKOFF_MS=900000
CRONOMETER_OPERATION_TIMEOUT_MS=55000
CRONOMETER_BROWSER_RETRY_COUNT=1
```

`REMOTE_CHROME_WS_ENDPOINT` is optional when serverless Chromium is enabled. Browserless or another remote Chrome CDP endpoint is still the better production choice because Vercel functions are ephemeral and time-limited. Add `CRONOMETER_STORAGE_STATE_BASE64` when Cronometer starts challenging fresh headless logins. `CRONOMETER_LOGIN_BACKOFF_MS` stops repeated login attempts during temporary rate limits.

Food logs write directly when `CRONOMETER_ENABLE_WRITES=true` unless the tool call sets `dryRun=true`. Set `CRONOMETER_REQUIRE_FOOD_CONFIRMATION=true` if you want every food log to require a second-step confirmation again. Dry-run write previews return without opening Cronometer, so validation calls do not burn browser login attempts.

Browser-backed tools are serialized within a warm serverless instance and retry transient Playwright/session failures once by default. They do not retry Cronometer login failures, CAPTCHA, or credential errors.

Other write tools require `CRONOMETER_ENABLE_WRITES=true` plus explicit confirmation. Leave `dryRun` unset for a real confirmed write, or set it to `false` if the client always sends the field:

```json
{ "confirmed": true }
```

## Durable Cronometer session

Vercel serverless instances are cold-started and should not be trusted to keep Cronometer login state forever. Prefer either a persistent remote browser endpoint or a generated Playwright storage state:

```bash
npm run storage:cronometer
vercel env add CRONOMETER_STORAGE_STATE_BASE64 production < .cronometer-storage-state.base64
vercel deploy --prod
```

The storage-state files are gitignored and should not be pasted into chat or committed. If Cronometer requires a browser verification step, rerun with `HEADLESS=false`.

Use `cronometer_runtime_status` to inspect whether production has durable storage configured, and `refresh_cronometer_session` to warm the current hosted instance before a long browser workflow.

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

When ChatGPT opens the cronogpt OAuth page, use `CRONOGPT_LINK_SECRET`; if it is not set, use `CRONOGPT_API_TOKEN`.

## Recipe workflow

1. Call `resolve_recipe_ingredients` with the recipe ingredient list.
2. Pick the best Cronometer match for each ingredient, preserving both `selectedName` and `selectedSource`.
3. Call `create_recipe` with the selected foods and `dryRun=true`.
4. Review the preview.
5. Call `create_recipe` again with `confirmed=true`; leave `dryRun` unset, or set `dryRun=false`.

`resolve_recipe_ingredients` is a bounded batch search. For large recipes, keep `limitPerIngredient` low, use `maxSeconds`, and retry with only skipped or unresolved ingredients if the first call stops early. `create_recipe` refuses ambiguous matches and returns candidates when an exact `selectedName`/`selectedSource` cannot be selected.

The hosted browser adapter opens the custom recipe editor, fills the recipe name/servings, opens `ADD INGREDIENTS`, searches each ingredient, and selects matches. Keep the first real runs in dry-run mode and review the visible result before enabling writes.
