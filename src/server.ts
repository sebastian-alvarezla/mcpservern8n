import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 3333);
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function assertAuth(req: IncomingMessage) {
  if (!MCP_BEARER_TOKEN) return;
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${MCP_BEARER_TOKEN}`) {
    const err: any = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

async function main() {
  const mcp = new McpServer({
    name: "mcp-server-agent",
    version: "0.1.0",
  });

  // Tool demo (sin args)
  mcp.tool(
    "ping",
    "Devuelve pong",
    { paramsSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: "pong" }] })
  );

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      setCors(res);

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!req.url) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request" }));
        return;
      }

      // Health
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      /**
       * MCP endpoint para n8n (HTTP Streamable)
       * n8n MCP Client -> POST https://.../mcp
       */
      if (req.method === "POST" && req.url === "/mcp") {
        assertAuth(req);

        // OJO: en tu versión, el constructor NO recibe (req, res)
        const transport = new StreamableHTTPServerTransport();

        // Conectar el server MCP al transport
        await mcp.connect(transport);

        // Delegar el handling del request al transport (AQUÍ sí van req/res)
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    } catch (e: any) {
      const status = e?.statusCode ?? 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e?.message ?? "Internal error" }));
    }
  });

  server.listen(PORT, () => {
    console.log(`✅ MCP server listening on http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`MCP (n8n): http://localhost:${PORT}/mcp`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
