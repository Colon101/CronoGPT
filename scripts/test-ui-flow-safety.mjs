#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserCronometerProvider } from "../dist/providers/browser.js";

const tempDir = mkdtempSync(join(tmpdir(), "cronogpt-ui-flow-safety-"));

try {
  const provider = new BrowserCronometerProvider({
    localChromium: false,
    writeEnabled: true,
    requireFoodConfirmation: false,
    navigationTimeoutMs: 1000,
    loginBackoffMs: 1000,
    loginBackoffFile: join(tempDir, "login-backoff.json"),
    operationJournalFile: join(tempDir, "operation-journal.json"),
    operationTimeoutMs: 1000,
    browserRetryCount: 0,
    timeZone: "Asia/Jerusalem",
    reuseRemoteContext: false,
    reuseLocalBrowser: false,
  });

  const blocked = await provider.runUiFlow({
    section: "account",
    steps: [{ action: "clickText", text: "Delete Account" }],
    dryRun: false,
    confirmed: true,
  });

  assert.equal(blocked.status, "needs_manual_step");
  assert.equal(blocked.data?.blockedStep?.action, "clickText");
  assert.equal(blocked.data?.blockedStep?.text, "Delete Account");
  assert.match(blocked.warning ?? "", /refuses (?:dangerous|commit-like)/i);
  assert.equal(blocked.data?.browserOpened, undefined, "the guard must reject before browser access");

  console.log("UI flow safety checks passed");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}
