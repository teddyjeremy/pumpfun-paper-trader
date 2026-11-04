import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../src/server.js";

// Vercel Node.js Function adapter. Fastify handles all routes; the process
// remains stateless between invocations, so this endpoint is for dashboard
// visibility only, not the always-on market listener or execution worker.
export default async function handler(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  await app.ready();
  app.server.emit("request", request, response);
}
