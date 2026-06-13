#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserCronometerProvider,
  __resetBrowserQueueForTests,
  __runBrowserQueueJobForTests,
  __setActiveBrowserJobForTests,
  releaseAndSnapshotBrowserQueue,
} from "../dist/providers/browser.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = mkdtempSync(join(tmpdir(), "cronogpt-runtime-safety-"));
const cooldownFile = join(tempDir, "cooldown.json");

try {
  let status = runCooldown(["status"]);
  assert.equal(status.active, false);
  assert.equal(status.filePath, cooldownFile);

  status = runCooldown(["set", "120", "Too", "Many", "Attempts"]);
  assert.equal(status.active, true);
  assert.equal(status.reason, "Too Many Attempts");
  assert.ok(status.secondsRemaining > 0 && status.secondsRemaining <= 120);
  assert.equal(statSync(cooldownFile).mode & 0o777, 0o600);

  status = runCooldown(["clear"]);
  assert.equal(status.active, false);
  assert.equal(status.cleared, true);
  assert.equal(existsSync(cooldownFile), false);

  status = runCooldown(["set"], { CRONOMETER_LOGIN_BACKOFF_MS: "900000" });
  assert.equal(status.active, true);
  assert.ok(status.secondsRemaining > 0 && status.secondsRemaining <= 900);

  const provider = new BrowserCronometerProvider({
    email: "test@example.com",
    password: "secret",
    storageState: undefined,
    localChromium: true,
    writeEnabled: true,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 1000,
    loginBackoffMs: 900000,
    loginBackoffFile: cooldownFile,
    operationTimeoutMs: 1000,
    browserRetryCount: 0,
    timeZone: "Asia/Jerusalem",
    reuseRemoteContext: false,
    reuseLocalBrowser: false,
  });
  const pausedWrite = await provider.logFood({ query: "banana", amount: 1, unit: "g" });
  assert.equal(pausedWrite.status, "not_written_login_paused");
  assert.equal(pausedWrite.data.browserOpened, false);
  assert.equal(pausedWrite.data.writeAttempted, false);
  assert.ok(pausedWrite.data.loginPauseSecondsRemaining > 0);

  const pausedRead = await provider.stabilityCheck({ includeFoodSearch: false });
  assert.equal(pausedRead.status, "needs_manual_step");
  assert.equal(pausedRead.data.browserOpened, false);
  assert.equal(pausedRead.data.writeAttempted, false);

  assert.equal(provider.featureQueueWaitTimeoutMs("log_food"), 10000);
  assert.equal(provider.featureQueueWaitTimeoutMs("search_foods"), 5000);
  const hostedProvider = new BrowserCronometerProvider({
    ...provider.config,
    operationTimeoutMs: 180000,
  });
  assert.equal(hostedProvider.featureQueueWaitTimeoutMs("log_food"), 180000);
  assert.equal(hostedProvider.featureQueueWaitTimeoutMs("create_and_log_custom_food"), 180000);
  assert.equal(hostedProvider.featureQueueWaitTimeoutMs("delete_diary_food_entry"), 180000);

  status = runCooldown(["clear"]);
  assert.equal(status.active, false);

  writeFileSync(cooldownFile, "{not-json", { mode: 0o600 });
  status = runCooldown(["status"]);
  assert.equal(status.active, false);
  assert.equal(status.malformed, true);
  assert.match(status.reason, /Unreadable cooldown file/);

  __resetBrowserQueueForTests();
  __setActiveBrowserJobForTests("log_food", Date.now() - 10_000);
  let queue = releaseAndSnapshotBrowserQueue(60_000);
  assert.equal(queue.activeBrowserJobs, 1);
  assert.equal(queue.activeBrowserJob.feature, "log_food");

  queue = releaseAndSnapshotBrowserQueue(1);
  assert.equal(queue.activeBrowserJobs, 0);
  assert.equal(queue.activeBrowserJob, undefined);
  assert.equal(queue.staleActiveJob.feature, "log_food");
  __resetBrowserQueueForTests();

  const starts = [];
  const first = __runBrowserQueueJobForTests("first", async () => {
    starts.push("first");
    await sleep(30);
    return "first";
  });
  await sleep(5);
  const second = __runBrowserQueueJobForTests("second", async () => {
    starts.push("second");
    return "second";
  });
  queue = releaseAndSnapshotBrowserQueue(1000);
  assert.equal(queue.activeBrowserJobs, 1);
  assert.equal(queue.queuedBrowserJobs, 1);
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(starts, ["first", "second"]);
  __resetBrowserQueueForTests();

  console.log("runtime safety checks passed");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCooldown(args, env = {}) {
  const result = spawnSync(process.execPath, ["scripts/cronometer-login-cooldown.mjs", ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      CRONOMETER_LOGIN_BACKOFF_FILE: cooldownFile,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
