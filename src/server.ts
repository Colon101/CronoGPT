import { createServer } from "node:http";
import { handleMcpHttpRequest, MCP_PATH } from "./mcp.js";
import { validateRuntimeConfiguration } from "./runtime-config.js";

validateRuntimeConfiguration();
const port = parsePort(process.env.PORT);
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

const server = createServer((req, res) => {
  void handleMcpHttpRequest(req, res).catch((error) => {
    console.error("Unhandled HTTP request error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("Internal server error");
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

server.listen(port, host, () => {
  console.log(`cronogpt MCP server listening on http://${host}:${port}${MCP_PATH}`);
});

export function parsePort(value: string | undefined) {
  const normalized = value?.trim() || "8787";
  if (!/^\d+$/.test(normalized)) throw new Error(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`);
  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`);
  }
  return port;
}
