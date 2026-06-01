import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcpHttpRequest } from "../src/mcp.js";

export const config = {
  maxDuration: 60,
};

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleMcpHttpRequest(req, res);
}
