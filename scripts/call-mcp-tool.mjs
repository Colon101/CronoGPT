#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [toolName, rawArguments] = process.argv.slice(2);
if (!toolName) {
  throw new Error("Usage: call-mcp-tool.mjs <tool-name|--list> [JSON arguments or @path]");
}

const serverUrl = process.env.CRONOGPT_MCP_URL ?? "http://127.0.0.1:8787/mcp";
const token = process.env.CRONOGPT_API_TOKEN;
if (!token) throw new Error("Missing CRONOGPT_API_TOKEN.");

const client = new Client({ name: "cronogpt-local-tool-caller", version: "0.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

await client.connect(transport);
try {
  if (toolName === "--list") {
    const result = await client.listTools();
    console.log(JSON.stringify(result.tools, null, 2));
  } else {
    const args = await parseArguments(rawArguments);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: Number(process.env.CRONOGPT_MCP_CALL_TIMEOUT_MS ?? 900000) },
    );
    console.log(JSON.stringify(result.structuredContent ?? result, null, 2));
  }
} finally {
  await client.close();
}

async function parseArguments(raw) {
  if (!raw) return {};
  const value = raw.startsWith("@")
    ? await readFile(raw.slice(1), "utf8")
    : raw;
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed;
}
