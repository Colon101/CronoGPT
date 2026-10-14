import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserCronometerProvider, __resetBrowserQueueForTests } from "../dist/providers/browser.js";
import { createCronoServer } from "../dist/mcp.js";

const dir = mkdtempSync(join(tmpdir(), "cronogpt-food-plan-"));
const config = {
  localChromium: false, writeEnabled: true, requireFoodConfirmation: true,
  navigationTimeoutMs: 1000, loginBackoffMs: 1000, operationTimeoutMs: 10000,
  browserRetryCount: 0, timeZone: "Asia/Jerusalem", operationJournalFile: join(dir, "operations.json"),
};
let releaseFirst;
const firstMealGate = new Promise((resolve) => { releaseFirst = resolve; });
let firstMealStarted;
const firstMealStart = new Promise((resolve) => { firstMealStarted = resolve; });

// Exercise real operation admission, child jobs, polling, persistence and MCP
// transport while replacing only the external Cronometer transaction.
class DelayedMealProvider extends BrowserCronometerProvider {
  starts = [];
  async withPage(_feature, handler) { return handler({}); }
  async logFoodsOnPage(_page, input, normalizedItems) {
    this.starts.push(input.date);
    if (input.date === "2026-10-12") { firstMealStarted(); await firstMealGate; }
    const failed = input.date === "2026-10-16";
    return {
      provider: this.name, mode: this.mode, feature: "log_foods",
      status: failed ? "not_written_not_found" : "written",
      data: {
        count: input.items.length, attemptedCount: input.items.length, writeAttempted: !failed,
        items: normalizedItems.map(({ normalized }, index) => ({ index, status: failed ? "not_written_not_found" : "written", normalized: { date: normalized.date, meal: normalized.meal, query: normalized.query, amount: normalized.amount, unit: normalized.unit } })),
      },
    };
  }
}
const provider = new DelayedMealProvider(config);
const server = createCronoServer({ provider, grantedScopes: ["cronometer:read", "cronometer:write"] });
const client = new Client({ name: "food-plan-test", version: "1" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
await client.connect(ct);
const items = [
  { date: "2026-10-12", meal: "Breakfast", query: "Banana", amount: 100, unit: "g" },
  { date: "2026-10-13", meal: "Lunch", query: "Milk", amount: 200, unit: "g" },
];
try {
  const admitted = await client.callTool({ name: "log_food_plan", arguments: { items, confirmed: true, idempotencyKey: "whole-plan", waitForCompletionSeconds: 0 } });
  if (admitted.structuredContent.status !== "accepted") console.log(JSON.stringify(admitted.structuredContent, null, 2));
  assert.equal(admitted.structuredContent.status, "accepted");
  const parentId = admitted.structuredContent.operationId;
  await firstMealStart;
  assert.deepEqual(provider.starts, ["2026-10-12"], "later meals wait for the running meal");
  const running = await client.callTool({ name: "get_cronometer_operation", arguments: { operationId: parentId, waitForCompletionSeconds: 0 } });
  assert.equal(running.structuredContent.completed, false);
  assert.equal(running.structuredContent.data.progress.activeGroupIndex, 0);
  assert.equal(running.structuredContent.data.progress.completedGroupCount, 0);

  const duplicate = await provider.logFoodPlan({ items, confirmed: true, idempotencyKey: "whole-plan", waitForCompletionSeconds: 0 });
  assert.equal(duplicate.status, "accepted");
  assert.equal(duplicate.data.operationId, parentId);
  assert.deepEqual(provider.starts, ["2026-10-12"], "resubmission cannot schedule another running plan");
  releaseFirst();
  const finished = await client.callTool({ name: "get_cronometer_operation", arguments: { operationId: parentId } });
  assert.equal(finished.structuredContent.status, "written");
  assert.equal(finished.structuredContent.operationId, parentId);
  assert.equal(finished.structuredContent.data.completed, true);
  assert.equal(finished.structuredContent.data.attemptedGroupCount, 2);
  assert.deepEqual(finished.structuredContent.data.remainingItemIndices, []);
  assert.deepEqual(provider.starts, ["2026-10-12", "2026-10-13"], "one request completes all groups without client continuation");
  const replay = await provider.logFoodPlan({ items, confirmed: true, idempotencyKey: "whole-plan", waitForCompletionSeconds: 0 });
  assert.equal(replay.status, "written");
  assert.equal(provider.starts.length, 2, "a completed plan is not written twice");
  const changedKey = await provider.logFoodPlan({ items: [{ ...items[0], amount: 101 }], confirmed: true, idempotencyKey: "whole-plan", waitForCompletionSeconds: 0 });
  assert.equal(changedKey.status, "needs_manual_step");

  const failureItems = [15, 16, 17].map((day) => ({ date: `2026-10-${day}`, meal: "Dinner", query: "Banana", amount: 100, unit: "g" }));
  const partial = await provider.logFoodPlan({ items: failureItems, confirmed: true, idempotencyKey: "partial-plan", waitForCompletionSeconds: 10 });
  assert.equal(partial.status, "not_written_not_found");
  assert.equal(partial.data.completed, false);
  assert.deepEqual(partial.data.remainingItemIndices, [2]);
  assert.deepEqual(provider.starts.slice(-2), ["2026-10-15", "2026-10-16"]);
  assert.equal(provider.starts.includes("2026-10-17"), false, "a failed meal stops later meals");

  const beforeInvalid = provider.starts.length;
  const invalid = await provider.logFoodPlan({ items: [items[0], { ...items[1], date: "bad-date" }], confirmed: true });
  assert.equal(invalid.status, "needs_manual_step");
  assert.equal(invalid.data.writeAttempted, false);
  assert.equal(provider.starts.length, beforeInvalid, "an invalid later item is refused before the first meal");
  const duplicates = await provider.logFoodPlan({ items: [items[0], items[0]], confirmed: true });
  assert.equal(duplicates.status, "needs_manual_step");
  assert.equal(provider.starts.length, beforeInvalid);

  const repeatedKeys = await provider.logFoodPlan({ items: items.map((item) => ({ ...item, idempotencyKey: "one-key" })), confirmed: true });
  assert.equal(repeatedKeys.status, "needs_manual_step");
  assert.equal(provider.starts.length, beforeInvalid, "reused child keys are refused before any meal is started");
  const journal = JSON.parse(readFileSync(config.operationJournalFile, "utf8"));
  const parent = journal.operations.find((operation) => operation.id === parentId);
  assert.equal(parent.feature, "log_food_plan");
  assert.equal(parent.status, "completed");
  assert.equal(parent.result.data.groups.length, 2);
  const inspectRestored = (restoredConfig) => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { BrowserCronometerProvider } from './dist/providers/browser.js';
      const provider = new BrowserCronometerProvider(JSON.parse(process.argv[1]));
      console.log(JSON.stringify(await provider.getOperation(process.argv[2])));
    `, JSON.stringify(restoredConfig), parentId], { encoding: "utf8", cwd: new URL("../", import.meta.url) });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const persisted = inspectRestored(config);
  assert.equal(persisted.status, "written");
  assert.equal(persisted.data.returnedFromJournal, true);
  assert.equal(persisted.data.completed, true);
  const interruptedFile = join(dir, "interrupted.json");
  writeFileSync(interruptedFile, JSON.stringify({ ...journal, operations: journal.operations.map((operation) => operation.id === parentId ? { ...operation, status: "running", result: undefined } : operation) }));
  const interrupted = inspectRestored({ ...config, operationJournalFile: interruptedFile });
  assert.equal(interrupted.status, "possibly_written_verify_failed", "an interrupted parent is inspected rather than replayed after restart");
  assert.equal(interrupted.data.state, "indeterminate");
  assert.equal(interrupted.data.operation.progress.completedGroupCount, 2);
  console.log("Food plan tests passed: parent continuation, long polling, replay, failure stop, complete preflight and persisted receipts.");
} finally {
  releaseFirst();
  await client.close();
  await server.close();
  __resetBrowserQueueForTests();
  rmSync(dir, { recursive: true, force: true });
}
