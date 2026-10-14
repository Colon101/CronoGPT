import { createServer } from "node:http";
import { handleMcpHttpRequest, MCP_PATH, shutdownMcpRuntime } from "./mcp.js";
import { validateRuntimeConfiguration } from "./runtime-config.js";

validateRuntimeConfiguration();
const port = parsePort(process.env.PORT);
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const shutdownGraceMs = 210_000;
let shuttingDown = false;

const server = createServer((req, res) => {
  if (!hasValidRequestUrl(req.url, req.headers.host)) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Bad Request");
    return;
  }

  void handleMcpHttpRequest(req, res).catch((error) => {
    console.error("Unhandled HTTP request error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("Internal server error");
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

server.listen(port, host, () => {
  console.log(`cronogpt MCP server listening on http://${host}:${port}${MCP_PATH}`);
});

process.once("SIGTERM", () => beginGracefulShutdown("SIGTERM"));
process.once("SIGINT", () => beginGracefulShutdown("SIGINT"));

function beginGracefulShutdown(signal: "SIGTERM" | "SIGINT") {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; stopping new HTTP connections and allowing in-flight MCP/browser work up to ${shutdownGraceMs} ms to finish.`);

  const forceTimer = setTimeout(() => {
    console.error(`Graceful shutdown exceeded ${shutdownGraceMs} ms; closing remaining HTTP connections.`);
    server.closeAllConnections();
    process.exit(1);
  }, shutdownGraceMs);
  forceTimer.unref();

  const shutdownStartedAt = Date.now();
  server.close(async (error) => {
    if (error) {
      console.error("HTTP server shutdown failed:", error);
      process.exitCode = 1;
      return;
    }
    const remainingMs = Math.max(0, shutdownGraceMs - (Date.now() - shutdownStartedAt));
    const runtime = await shutdownMcpRuntime(remainingMs).catch((runtimeError) => ({
      drained: false,
      error: runtimeError instanceof Error ? runtimeError.message : "Unknown MCP runtime shutdown error",
    }));
    clearTimeout(forceTimer);
    if (runtime && typeof runtime === "object" && "drained" in runtime && runtime.drained === false) {
      console.error("MCP/browser runtime did not drain cleanly before shutdown:", runtime);
      process.exitCode = 1;
      return;
    }
    console.log("HTTP and MCP/browser runtime shutdown completed.");
  });
  server.closeIdleConnections();
}

function hasValidRequestUrl(requestUrl: string | undefined, hostHeader: string | undefined) {
  if (!requestUrl) return false;
  try {
    new URL(requestUrl, `http://${hostHeader ?? "localhost"}`);
    return true;
  } catch {
    return false;
  }
}

export function parsePort(value: string | undefined) {
  const normalized = value?.trim() || "8787";
  if (!/^\d+$/.test(normalized)) throw new Error(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`);
  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`);
  }
  return port;
}
