# cronogpt

cronogpt is a starter Apps SDK/MCP server for controlling or reading Cronometer from ChatGPT.

## API reality

As of the current public sources, Cronometer does not appear to offer a first-party public API for normal user accounts. The practical API-backed option is Terra, which advertises a Cronometer integration for synced nutrition, workout, and health-metric data. Cronometer itself officially supports web CSV export for diary data.

That means the architecture should be:

1. API-backed reads through Terra when available.
2. CSV import/export fallback for official Cronometer exports.
3. Browser automation only as a local fallback for actions that no supported API exposes, such as logging foods directly in Cronometer.

Do not deploy Cronometer email/password credentials to an unprotected server. This repo gates `/mcp` with OAuth for ChatGPT plus a private `CRONOGPT_API_TOKEN` fallback for direct MCP clients. For a multi-user app, replace the built-in single-user link-code flow with a real identity provider and per-user connection state.

## What ChatGPT needs

ChatGPT connects to an Apps SDK app by calling an HTTPS MCP endpoint, usually `/mcp`. This repo exposes:

- `GET /` health check
- `POST|GET|DELETE /mcp` MCP endpoint
- Apps SDK widget resource at `ui://widget/cronometer-dashboard.html`
- Tool framework for diary reads, logging actions, targets, reports, fasting, recipes, and capability discovery

## Local setup

```bash
npm install
npm run build
npm start
```

The local MCP endpoint is:

```text
http://localhost:8787/mcp
```

Use the inspector while developing:

```bash
npm run inspect
```

To connect from ChatGPT, expose the server over HTTPS with a tunnel, then create a connector in ChatGPT developer mode using:

```text
https://your-tunnel.example/mcp
```

## Render setup

This repo includes `render.yaml` and a Playwright-based `Dockerfile` so hosted browser automation can run as a normal long-lived web service instead of a short serverless function.

Set these Render environment variables. Values marked secret are declared with `sync: false` in `render.yaml` and are filled in the Render Dashboard:

```text
APP_PUBLIC_ORIGIN=https://cronogpt.onrender.com
CRONOGPT_API_TOKEN=generate-a-long-random-token
CRONOGPT_LINK_SECRET=optional-separate-chatgpt-link-code
CRONOMETER_BACKEND=browser
CRONOMETER_EMAIL=...
CRONOMETER_PASSWORD=...
CRONOMETER_STORAGE_STATE_BASE64=optional-playwright-storage-state
CRONOMETER_LOCAL_CHROMIUM=true
CRONOMETER_SERVERLESS_CHROMIUM=false
REMOTE_CHROME_WS_ENDPOINT=optional-remote-chrome-endpoint
CRONOMETER_ENABLE_WRITES=true
CRONOMETER_REQUIRE_FOOD_CONFIRMATION=false
CRONOMETER_NAVIGATION_TIMEOUT_MS=60000
CRONOMETER_LOGIN_BACKOFF_MS=900000
CRONOMETER_OPERATION_TIMEOUT_MS=600000
CRONOMETER_BROWSER_RETRY_COUNT=1
```

The Render Docker image includes local Chromium through the Playwright base image. `REMOTE_CHROME_WS_ENDPOINT` is optional if you want to use Browserless or another remote Chrome provider instead. `CRONOMETER_STORAGE_STATE_BASE64` lets the hosted browser reuse a valid Cronometer session instead of logging in from scratch on every tool call. `CRONOMETER_LOGIN_BACKOFF_MS` pauses new login attempts after a rate-limit or bot challenge.

Food logs write directly when `CRONOMETER_ENABLE_WRITES=true` unless the tool call sets `dryRun=true`. Set `CRONOMETER_REQUIRE_FOOD_CONFIRMATION=true` to restore the older second-step confirmation behavior. Other write tools require `confirmed=true` and will write as long as `dryRun` is not `true`. Dry-run write previews return without opening Cronometer, so recipe/custom-food validation does not burn browser login attempts. Set `CRONOMETER_ENABLE_WRITES=false` for read-only dry-run mode.

Browser-backed tools are serialized inside the hosted process to reduce Chromium contention. `CRONOMETER_OPERATION_TIMEOUT_MS` bounds individual browser attempts, and `CRONOMETER_BROWSER_RETRY_COUNT` retries transient automation failures without retrying login/CAPTCHA/credential failures.

Before a long ChatGPT workflow, call `cronometer_stability_check`. It verifies hosted login, Diary readability, and a small food search in one queued browser job without writing data.

Run the no-write production smoke test after deploys:

```bash
npm run smoke:production
```

To create a durable Cronometer session for Render, run this locally after confirming `.env` has the Cronometer credentials:

```bash
npm run storage:cronometer
```

The generator writes `.cronometer-storage-state.json` and `.cronometer-storage-state.base64` with mode `0600`; both are ignored by git. Add the base64 file contents to Render as `CRONOMETER_STORAGE_STATE_BASE64`. Set `HEADLESS=false` if Cronometer requires an interactive verification step. The MCP tool `refresh_cronometer_session` can warm and verify the hosted session without writing diary data.

For more reliable read data, add Terra:

```text
TERRA_API_KEY=...
TERRA_DEV_ID=...
TERRA_USER_ID=...
```

ChatGPT connector URL after deployment:

```text
https://cronogpt.onrender.com/mcp
```

The deployed `/mcp` endpoint supports ChatGPT OAuth discovery. In ChatGPT, create the app with authentication set to OAuth and use:

```text
https://cronogpt.onrender.com/mcp
```

When ChatGPT opens the cronogpt linking page, enter `CRONOGPT_LINK_SECRET`. If that env var is empty, enter `CRONOGPT_API_TOKEN`.

Direct MCP clients can still use:

```text
Authorization: Bearer your-cronogpt-api-token
```

## Backends

Set `CRONOMETER_BACKEND` in `.env`:

- `mock`: local dry-run data, safe default.
- `terra`: API-backed read framework using `TERRA_API_KEY`, `TERRA_DEV_ID`, and `TERRA_USER_ID`.
- `browser`: hosted browser automation through local Chromium, serverless Chromium, or `REMOTE_CHROME_WS_ENDPOINT`. This cannot reuse the Codex `@chrome` plugin from ChatGPT.

The existing lowercase `email` and `password` keys are supported only for local browser-framework detection. Prefer `CRONOMETER_EMAIL` and `CRONOMETER_PASSWORD`.

`resolve_recipe_ingredients` reuses a single Cronometer food-search dialog and stops before the hosted operation budget expires. If a large recipe returns skipped or unresolved ingredients, call it again with only those remaining ingredients.

## Current tool map

- `cronometer_capabilities`
- `cronometer_runtime_status`
- `refresh_cronometer_session`
- `cronometer_stability_check`
- `read_cronometer_page`
- `run_cronometer_ui_flow`
- `get_daily_summary`
- `list_food_entries`
- `list_biometrics`
- `list_exercises`
- `list_notes`
- `search_foods`
- `resolve_recipe_ingredients`
- `log_food`
- `log_exercise`
- `log_biometric`
- `log_note`
- `create_custom_food`
- `list_custom_foods`
- `create_custom_meal`
- `list_custom_meals`
- `list_custom_recipes`
- `create_recipe`
- `get_targets`
- `set_targets`
- `export_data`
- `get_charts`
- `get_nutrition_report`
- `get_print_report`
- `list_snapshots`
- `create_snapshot`
- `start_fast`
- `stop_fast`
- `get_profile`
- `set_profile`
- `get_macro_scheduler`
- `set_macro_scheduler`
- `get_display_settings`
- `set_display_settings`
- `list_devices`
- `connect_device`
- `get_sharing`
- `set_sharing`
- `get_account`
- `ask_oracle`
- `suggest_food`
- `list_repeat_items`
- `schedule_repeat_item`
- `bulk_delete_entries` (disabled framework stub)
- `delete_account` (disabled framework stub)

See `docs/cronometer-chatgpt-plan.md` for the feature matrix and shipping checklist.
