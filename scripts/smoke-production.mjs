#!/usr/bin/env node
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverUrl = process.env.CRONOGPT_SMOKE_URL ?? "https://cronogpt.vercel.app/mcp";
const token = process.env.CRONOGPT_API_TOKEN;

if (!token) {
  throw new Error("Missing CRONOGPT_API_TOKEN.");
}

const checks = [];

await withClient(async (client) => {
  const tools = await client.listTools();
  checks.push({
    name: "tools",
    ok: tools.tools.length >= 50 &&
      tools.tools.some((tool) => tool.name === "cronometer_stability_check") &&
      tools.tools.some((tool) => tool.name === "run_cronometer_ui_flow"),
    data: {
      count: tools.tools.length,
      hasStabilityCheck: tools.tools.some((tool) => tool.name === "cronometer_stability_check"),
      hasUiFlow: tools.tools.some((tool) => tool.name === "run_cronometer_ui_flow"),
    },
  });

  const runtime = await client.callTool({ name: "cronometer_runtime_status", arguments: {} });
  checks.push({
    name: "runtime",
    ok: runtime.structuredContent?.status === "ok" &&
      runtime.structuredContent?.data?.storageStateConfigured === true &&
      runtime.structuredContent?.data?.storageStateUsable !== false &&
      runtime.structuredContent?.data?.loginPaused === false,
    data: runtime.structuredContent?.data,
  });

  const stability = await client.callTool({
    name: "cronometer_stability_check",
    arguments: { foodQuery: "Banana cream", includeFoodSearch: true },
  });
  checks.push({
    name: "stability",
    ok: stability.structuredContent?.status === "ok" && stability.structuredContent?.data?.ready === true,
    data: stability.structuredContent?.data,
  });

  const dryRun = await client.callTool({
    name: "create_custom_food",
    arguments: {
      name: "CronoGPT smoke test dry run",
      servingSize: "1 serving",
      nutrients: { calories: 1 },
      dryRun: true,
      confirmed: false,
    },
  });
  checks.push({
    name: "custom_food_dry_run",
    ok: dryRun.structuredContent?.status === "dry_run",
    data: {
      status: dryRun.structuredContent?.status,
      feature: dryRun.structuredContent?.feature,
    },
  });

  const dangerous = await client.callTool({
    name: "run_cronometer_ui_flow",
    arguments: {
      section: "account",
      steps: [{ action: "clickText", text: "Delete Account" }],
      dryRun: false,
      confirmed: true,
    },
  });
  checks.push({
    name: "dangerous_ui_block",
    ok: dangerous.structuredContent?.status === "needs_manual_step" &&
      /refuses dangerous/i.test(dangerous.structuredContent?.warning ?? ""),
    data: {
      status: dangerous.structuredContent?.status,
      warning: dangerous.structuredContent?.warning,
    },
  });
});

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({ ok, serverUrl, checks }, null, 2));
if (!ok) {
  process.exitCode = 1;
}

async function withClient(fn) {
  const client = new Client({ name: "cronogpt-production-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
