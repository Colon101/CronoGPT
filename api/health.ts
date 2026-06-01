import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    name: "cronogpt",
    mcp: "/mcp",
    status: "ok",
    backend: process.env.CRONOMETER_BACKEND ?? "auto",
    authConfigured: Boolean(process.env.CRONOGPT_API_TOKEN),
    remoteBrowserConfigured: Boolean(process.env.REMOTE_CHROME_WS_ENDPOINT || process.env.BROWSERLESS_WS_ENDPOINT),
    serverlessChromiumConfigured: process.env.CRONOMETER_SERVERLESS_CHROMIUM !== "false",
    terraConfigured: Boolean(process.env.TERRA_API_KEY && process.env.TERRA_DEV_ID && process.env.TERRA_USER_ID),
  }));
}
