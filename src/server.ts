import { createServer } from "node:http";
import { handleMcpHttpRequest, MCP_PATH } from "./mcp.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

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

function hasValidRequestUrl(requestUrl: string | undefined, hostHeader: string | undefined) {
  if (!requestUrl) return false;
  try {
    new URL(requestUrl, `http://${hostHeader ?? "localhost"}`);
    return true;
  } catch {
    return false;
  }
}
