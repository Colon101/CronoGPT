#!/usr/bin/env node
import assert from "node:assert/strict";
import { stableJson } from "../dist/determinism.js";
import { createProviderFromEnv } from "../dist/providers/index.js";
import { MockCronometerProvider } from "../dist/providers/mock.js";
import { TerraCronometerProvider } from "../dist/providers/terra.js";
import { customFoodNutrientEntries, rankFoodResults, retiredItemName } from "../dist/providers/browser.js";
import { normalizeDateRange } from "../dist/date-range.js";
import { validateRuntimeConfiguration } from "../dist/runtime-config.js";

const fixedInstant = new Date("2026-01-01T22:30:00.000Z");
const clock = () => new Date(fixedInstant);

assert.equal(
  stableJson({ zebra: 1, alpha: { y: 2, x: 1 }, omitted: undefined }),
  stableJson({ alpha: { x: 1, y: 2 }, zebra: 1 }),
);

const mock = new MockCronometerProvider({ clock, timeZone: "Asia/Jerusalem" });
assert.equal((await mock.getDailySummary({})).data.date, "2026-01-02");
assert.equal((await mock.getDailySummary({ date: "2024-03-04" })).data.date, "2024-03-04");
assert.equal((await mock.createAndLogCustomFood({ name: "Mock food", meal: "Lunch" })).feature, "create_and_log_custom_food");
assert.equal(retiredItemName("Protein Cookie", "42", "Asia/Jerusalem", fixedInstant), "Retired - Protein Cookie #42 - 2026-01-02");
assert.deepEqual(normalizeDateRange(
  { startDate: "yesterday", endDate: "today" },
  "Asia/Jerusalem",
  fixedInstant,
).dates, ["2026-01-01", "2026-01-02"]);
assert.match(normalizeDateRange(
  { startDate: "yesterday" },
  "Asia/Jerusalem",
  fixedInstant,
).issues.join(" "), /both startDate and endDate/);
assert.match(normalizeDateRange(
  { date: "today", startDate: "2026-01-01" },
  "Asia/Jerusalem",
  fixedInstant,
).issues.join(" "), /either date or startDate/);
assert.match(normalizeDateRange(
  { startDate: "2026-01-03", endDate: "2026-01-01" },
  "Asia/Jerusalem",
  fixedInstant,
).issues.join(" "), /on or before/);

let requestedUrl;
let requestHadAbortSignal = false;
const terra = new TerraCronometerProvider({
  apiBaseUrl: "https://terra.example/v2",
  apiKey: "key",
  devId: "dev",
  userId: "user",
  timeZone: "Asia/Jerusalem",
  clock,
  fetchImpl: async (url, init) => {
    requestedUrl = String(url);
    requestHadAbortSignal = init?.signal instanceof AbortSignal;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
assert.equal((await terra.getDailySummary({})).status, "ok");
assert.equal(requestHadAbortSignal, true);
assert.equal(
  requestedUrl,
  "https://terra.example/v2/nutrition?end_date=2026-01-02&start_date=2026-01-02&to_webhook=false&user_id=user",
);
assert.equal((await terra.getDailySummary({ startDate: "2026-02-03", endDate: "2026-02-01" })).status, "needs_manual_step");

const nutrientsA = customFoodNutrientEntries({ protein_g: 7, net_carbs: 99, calories: 10, total_carbs: 4 });
const nutrientsB = customFoodNutrientEntries({ total_carbs: 4, calories: 10, net_carbs: 99, protein_g: 7 });
assert.deepEqual(nutrientsA, nutrientsB);
assert.deepEqual(nutrientsA, [
  { label: "Energy", value: 10, sourceKey: "calories" },
  { label: "Total Carbs", value: 4, sourceKey: "total_carbs" },
  { label: "Protein", value: 7, sourceKey: "protein_g" },
]);

const tiedResults = [
  { name: "same", source: "unknown-b", raw: "second" },
  { name: "same", source: "unknown-a", raw: "first" },
];
const rankedForward = rankFoodResults("unrelated", tiedResults);
const rankedReverse = rankFoodResults("unrelated", [...tiedResults].reverse());
assert.deepEqual(rankedForward, rankedReverse);
assert.equal(rankedForward[0].source, "unknown-a");

assert.throws(
  () => createProviderFromEnv({ CRONOMETER_BACKEND: "sometimes" }),
  /CRONOMETER_BACKEND must be one of/,
);

assert.throws(
  () => validateRuntimeConfiguration({
    NODE_ENV: "production",
    CRONOGPT_API_TOKEN: "short",
    CRONOGPT_LINK_SECRET: "short",
  }),
  /APP_PUBLIC_ORIGIN is required.*API_TOKEN must contain at least 32.*LINK_SECRET must contain at least 24/,
);
assert.doesNotThrow(() => validateRuntimeConfiguration({
  NODE_ENV: "production",
  APP_PUBLIC_ORIGIN: "https://cronogpt.example.com",
  CRONOGPT_API_TOKEN: "a".repeat(64),
  CRONOGPT_LINK_SECRET: "b".repeat(64),
  CRONOGPT_OAUTH_STATE_FILE: "/var/lib/cronogpt/oauth-state.json",
}));
assert.throws(() => validateRuntimeConfiguration({
  NODE_ENV: "production",
  APP_PUBLIC_ORIGIN: "https://cronogpt.example.com/path",
  CRONOGPT_API_TOKEN: "a".repeat(64),
  CRONOGPT_LINK_SECRET: "b".repeat(64),
  CRONOGPT_OAUTH_STATE_FILE: "/var/lib/cronogpt/oauth-state.json",
}), /bare HTTP\(S\) origin/);
assert.throws(
  () => createProviderFromEnv({ CRONOMETER_BACKEND: "terra" }),
  /requires TERRA_API_KEY/,
);
assert.throws(
  () => createProviderFromEnv({ CRONOMETER_BACKEND: "browser", CRONOMETER_ENABLE_WRITES: "yes" }),
  /must be either "true" or "false"/,
);
assert.throws(
  () => createProviderFromEnv({ CRONOMETER_BACKEND: "browser", CRONOMETER_BROWSER_RETRY_COUNT: "1.5" }),
  /must be a safe integer/,
);
const whitespacePasswordProvider = createProviderFromEnv({
  CRONOMETER_BACKEND: "browser",
  CRONOMETER_EMAIL: "owner@example.com",
  CRONOMETER_PASSWORD: " leading-and-trailing ",
});
assert.equal(whitespacePasswordProvider.config.password, " leading-and-trailing ");
assert.equal(whitespacePasswordProvider.config.strictAccountVerification, true);
assert.throws(
  () => createProviderFromEnv({ CRONOMETER_TIME_ZONE: "Mars/Olympus_Mons" }),
  /not a valid IANA time zone/,
);

console.log("determinism checks passed");
