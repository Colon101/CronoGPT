import { createCronoHttpServer, MCP_PATH } from "./mcp.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

createCronoHttpServer().listen(port, host, () => {
  console.log(`cronogpt MCP server listening on http://${host}:${port}${MCP_PATH}`);
});
