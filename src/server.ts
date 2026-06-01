import { createCronoHttpServer, MCP_PATH } from "./mcp.js";

const port = Number(process.env.PORT ?? 8787);

createCronoHttpServer().listen(port, () => {
  console.log(`CronoGPT MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
