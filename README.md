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
npm ci
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

## Oracle Always Free setup

The active hosted app is a single private Oracle Always Free A1 VM running Docker Compose plus Caddy. The current endpoint is:

```text
https://cronogpt.129-159-156-186.sslip.io/mcp
```

Oracle Cloud Infrastructure is the only supported hosted deployment target for this repository.

See `deploy/oracle/README.md`. The short path is:

```bash
# Run once on the Oracle Ubuntu VM.
bash scripts/oracle/bootstrap-host.sh

# Run from this repo.
export ORACLE_HOST=129.159.156.186
export ORACLE_DOMAIN=cronogpt.129-159-156-186.sslip.io
export ORACLE_USER=ubuntu
export ORACLE_SSH_KEY=/home/kfir/.ssh/cronogpt_oracle_ed25519
npm run oracle:deploy
```

The deploy script writes non-secret config to `/opt/cronogpt/config/oracle.env` and secrets to `/opt/cronogpt/secrets/cronogpt.env` with mode `0600`. It generates fresh `CRONOGPT_API_TOKEN` and `CRONOGPT_LINK_SECRET` when they are not exported locally.

Hosted browser config:

```text
APP_PUBLIC_ORIGIN=https://cronogpt.129-159-156-186.sslip.io
CRONOGPT_API_TOKEN=generate-a-long-random-token
CRONOGPT_LINK_SECRET=optional-separate-chatgpt-link-code
CRONOGPT_OAUTH_STATE_FILE=/opt/cronogpt/state/oauth-state.json
CRONOMETER_BACKEND=browser
CRONOMETER_EMAIL=...
CRONOMETER_PASSWORD=...
CRONOMETER_STORAGE_STATE_BASE64=optional-playwright-storage-state
CRONOMETER_LOCAL_CHROMIUM=true
CRONOMETER_REUSE_LOCAL_BROWSER=true
CRONOMETER_STRICT_ACCOUNT_VERIFICATION=true
CRONOMETER_BROWSER_PROFILE_DIR=/opt/cronogpt/state/chromium-profile
REMOTE_CHROME_WS_ENDPOINT=optional-remote-chrome-endpoint
CRONOMETER_ENABLE_WRITES=true
CRONOMETER_REQUIRE_FOOD_CONFIRMATION=false
CRONOMETER_NAVIGATION_TIMEOUT_MS=60000
CRONOMETER_LOGIN_BACKOFF_MS=900000
CRONOMETER_LOGIN_BACKOFF_FILE=/opt/cronogpt/state/cronometer-login-backoff.json
CRONOMETER_OPERATION_TIMEOUT_MS=180000
CRONOMETER_BROWSER_RETRY_COUNT=1
CRONOGPT_FULL_TOOL_SURFACE=false
```

The Oracle Docker image includes local Chromium through the Playwright base image. Keep `CRONOMETER_REUSE_LOCAL_BROWSER=true` and `CRONOMETER_BROWSER_PROFILE_DIR=/opt/cronogpt/state/chromium-profile` so the hosted process reuses one warm Chromium session and persists Cronometer cookies across deploys. `REMOTE_CHROME_WS_ENDPOINT` is optional if you want Browserless or another remote Chrome provider instead. `CRONOMETER_STORAGE_STATE_BASE64` seeds the hosted browser with a valid Cronometer session when the persistent profile is empty or stale. `CRONOMETER_STRICT_ACCOUNT_VERIFICATION=true` refuses browser work when the authenticated account cannot be verified as the configured email. `CRONOMETER_LOGIN_BACKOFF_MS` pauses new login attempts after a rate-limit, challenge, or ambiguous login-page failure, and `CRONOMETER_LOGIN_BACKOFF_FILE` persists that cooldown across server restarts. `CRONOGPT_OAUTH_STATE_FILE` persists consumed authorization-code digests so a code cannot be replayed after a restart.

Food logs write directly when `CRONOMETER_ENABLE_WRITES=true` unless the tool call sets `dryRun=true`. Set `CRONOMETER_REQUIRE_FOOD_CONFIRMATION=true` to restore the older second-step confirmation behavior. Other write tools require `confirmed=true` and will write as long as `dryRun` is not `true`. Dry-run write previews return without opening Cronometer, so recipe/custom-food validation does not burn browser login attempts. Set `CRONOMETER_ENABLE_WRITES=false` for read-only dry-run mode.

Browser-backed tools are serialized inside the hosted process to reduce Chromium contention. Confirmed `log_food` writes are accepted as background jobs and deduped by idempotency key, so slow Cronometer UI work can finish after the caller returns. `CRONOMETER_OPERATION_TIMEOUT_MS` bounds individual browser attempts, and `CRONOMETER_BROWSER_RETRY_COUNT` retries transient pre-write automation failures without retrying login/CAPTCHA/credential failures. Once a commit control has been reached, any browser exception becomes `possibly_written_verify_failed`; it is never retried automatically.

For multi-ingredient meals, use `log_foods` instead of several separate `log_food` calls. It accepts an `items` array, derives one batch idempotency key, logs the foods sequentially in one browser job, verifies each item, and returns a per-item status table. By default it waits briefly for the batch to finish; if Cronometer is slow, poll `cronometer_runtime_status` for the returned background job instead of submitting the same batch again.

If Cronometer returns `Too Many Attempts`, stop live browser checks and seed the shared cooldown before retrying later:

```bash
npm run cronometer:cooldown -- set 900 "Too Many Attempts"
npm run cronometer:cooldown -- status
```

If you omit the `set` duration, the script uses `CRONOMETER_LOGIN_BACKOFF_MS` as milliseconds.

Clear it only after the cooldown is really over:

```bash
npm run cronometer:cooldown -- clear
```

Before a long ChatGPT workflow, call `cronometer_stability_check`. It verifies hosted login, Diary readability, and a small food search in one queued browser job without writing data.

Run the no-write production smoke test after deploys:

```bash
npm test
npm run test:food-logic
npm run test:runtime-safety
npm run smoke:oracle
```

### Preferred barcode-linked custom-food workflow

For a packaged food that is missing from Cronometer, prefer `create_and_log_custom_food`. It opens Foods > Custom Foods, fills the detailed editor and Advanced Info barcode row, saves only after every requested field was filled, reads back the exact name, serving size, barcode, and nutrient values, and only then logs that exact private food. Use `create_custom_food` for the same verified workflow without the diary-log step. Both tools handle exact-name duplicates internally, so ChatGPT should not call `list_custom_foods` first.

Pass the package serving size, the UPC/EAN/GTIN printed below the barcode, and every nutrient present on the label. Call `custom_food_nutrient_schema` for the current accepted keys and units. Create tools require an explicit serving size and at least one recognized nutrient. Unknown nutrient names, conflicting aliases for the same Cronometer field, invalid barcode check digits, invalid serving syntax, non-finite/negative values, and missing OAuth write scope are rejected before Chromium opens. An invalid or incomplete form is reverted rather than partially saved. A `possibly_written_verify_failed` result is deliberately ambiguous: inspect the custom-food list before retrying to avoid a duplicate.

To prove the real custom-food write path, run the gated live smoke. It creates one uniquely named food with a generated valid barcode and detailed nutrients, logs exactly one serving to Lunch, verifies the exact structured Lunch row and barcode, deletes the diary row and custom food, and verifies both are gone:

```bash
CRONOMETER_ENABLE_WRITES=true CRONOGPT_LIVE_WRITE_CONFIRM=create-log-lunch-and-cleanup-custom-food npm run smoke:live-custom-food
```

To create a durable Cronometer session for Oracle, run this locally after confirming `.env` has the Cronometer credentials:

```bash
npm run storage:cronometer
```

The generator writes `.cronometer-storage-state.json` and `.cronometer-storage-state.base64` with mode `0600`; both are ignored by git. Add the base64 file contents to the Oracle secret file as `CRONOMETER_STORAGE_STATE_BASE64`, then redeploy. Set `HEADLESS=false` if Cronometer requires an interactive verification step. The MCP tool `refresh_cronometer_session` can warm and verify the hosted session without writing diary data.

For more reliable read data, add Terra:

```text
TERRA_API_KEY=...
TERRA_DEV_ID=...
TERRA_USER_ID=...
```

ChatGPT connector URL after deployment:

```text
https://cronogpt.129-159-156-186.sslip.io/mcp
```

The deployed `/mcp` endpoint supports ChatGPT OAuth discovery. In ChatGPT, create the app with authentication set to OAuth and use:

```text
https://cronogpt.129-159-156-186.sslip.io/mcp
```

When ChatGPT opens the cronogpt linking page, enter `CRONOGPT_LINK_SECRET`. Production requires a separate strong link secret, a strong API token, HTTPS `APP_PUBLIC_ORIGIN`, and a persistent OAuth state file. On 2026-06-09, Chrome verified this connector through ChatGPT's website with App ID `asdk_app_6a2811e26a8481918d4596e042f50718`.

Direct MCP clients can still use:

```text
Authorization: Bearer your-cronogpt-api-token
```

After Oracle passes smoke and one live canary, wipe local env clutter while preserving only Cronometer login:

```bash
npm run oracle:wipe-local-env
```

## Stable tool surface

By default, only these tools are model-visible:

- `log_food`
- `log_foods`
- `delete_diary_food_entry`
- `get_daily_summary`
- `list_food_entries`
- `list_biometrics`
- `list_exercises`
- `list_notes`
- `search_foods`
- `custom_food_nutrient_schema`
- `list_custom_foods`
- `find_duplicate_custom_foods`
- `create_custom_food`
- `create_and_log_custom_food`
- `update_custom_food`
- `delete_custom_food`
- `retire_custom_food`
- `list_private_recipe_names`
- `find_private_recipe`
- `resolve_recipe_ingredients`
- `ensure_private_recipe`
- `cronometer_runtime_status`
- `cronometer_stability_check`
- `refresh_cronometer_session`

The rest—including unstructured targets/profile readers—remain app-callable for rollback and direct testing. Set `CRONOGPT_FULL_TOOL_SURFACE=true` only when deliberately exposing the legacy broad surface.

`log_food` is transactional and requires an explicit `Breakfast`, `Lunch`, `Dinner`, `Snacks`, or `Supplements` destination. There is no silent Breakfast/Snacks fallback. `dryRun=true` does not open Chromium and returns `ok=false`, `completed=false`, and `intentSatisfied=false`. Confirmed real writes run in the browser queue, verify date/meal/time/amount/unit before Save, write once, and read back the structured target diary row. Single-food writes wait briefly for verified completion by default; confirmed custom-food writes and deletes wait up to the hosted operation window. If the result is still `accepted`, poll `cronometer_runtime_status` for the final background result before retrying. Final states include `written`, `already_exists`, `busy`, `not_written_login_paused`, `not_written_ambiguous`, `not_written_not_found`, and `possibly_written_verify_failed`. For a whole meal, prefer `log_foods`; it reduces ChatGPT/tool-call drift by keeping all ingredients in one server-side transaction and returns exact per-item results.

## Backends

Set `CRONOMETER_BACKEND` in `.env`:

- `mock`: local dry-run data, safe default.
- `terra`: API-backed read framework using `TERRA_API_KEY`, `TERRA_DEV_ID`, and `TERRA_USER_ID`.
- `browser`: hosted browser automation through Oracle-local Chromium or `REMOTE_CHROME_WS_ENDPOINT`. This cannot reuse the Codex `@chrome` plugin from ChatGPT.

The existing lowercase `email` and `password` keys are supported only for local browser-framework detection. Prefer `CRONOMETER_EMAIL` and `CRONOMETER_PASSWORD`.

`resolve_recipe_ingredients` reuses a single Cronometer food-search dialog and stops before the hosted operation budget expires. If a large recipe returns skipped or unresolved ingredients, call it again with only those remaining ingredients. For recipe writes, pass the chosen `selectedName` and `selectedSource` from `resolve_recipe_ingredients` into each `create_recipe` ingredient. Ambiguous matches return candidates instead of writing the wrong food.

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
- `log_foods`
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
