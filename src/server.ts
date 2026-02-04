import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const PORT = Number(process.env.PORT ?? 3333);
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";

// Guardamos transportes por sessionId
const transports = new Map<string, SSEServerTransport>();

function assertAuth(req: IncomingMessage) {
    if (!MCP_BEARER_TOKEN) return;
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${MCP_BEARER_TOKEN}`) {
        const err: any = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
    }
}

function setCors(res: ServerResponse) {
    // Ajusta si NO quieres "*" en prod
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization,content-type");
}

async function main() {
    const mcp = new McpServer({
        name: "mcp-server-agent",
        version: "0.1.0",
    });

    // Tool demo para probar rápido desde n8n
    mcp.tool(
        "ping",
        "Devuelve pong",
        { inputSchema: z.object({}) },
        async () => {
            return { content: [{ type: "text", text: "pong" }] };
        }
    );

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        try {
            if (!req.url) {
                res.writeHead(400).end("Bad Request");
                return;
            }

            // CORS preflight (solo si te hace falta)
            if (req.method === "OPTIONS") {
                setCors(res);
                res.writeHead(204);
                res.end();
                return;
            }

            // Health
            if (req.method === "GET" && req.url === "/health") {
                setCors(res);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            /**
             * 1) SSE handshake
             * GET /mcp/sse
             */
            if (req.method === "GET" && req.url.startsWith("/mcp/sse")) {
                assertAuth(req);

                // (Opcional) Si quieres CORS también en SSE:
                // setCors(res);

                const transport = new SSEServerTransport("/mcp/messages", res);
                transports.set(transport.sessionId, transport);

                res.on("close", () => {
                    transports.delete(transport.sessionId);
                });

                await mcp.connect(transport);
                return; // IMPORTANT: no cierres res, lo maneja SSE
            }

            /**
             * 2) endpoint para recibir mensajes
             * POST /mcp/messages?sessionId=...
             */
            if (req.method === "POST" && req.url.startsWith("/mcp/messages")) {
                assertAuth(req);

                // Importante: no hardcodear localhost en prod
                const base = `http://${req.headers.host ?? "localhost"}`;
                const urlObj = new URL(req.url, base);

                const sessionId = urlObj.searchParams.get("sessionId");
                if (!sessionId) {
                    setCors(res);
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "Missing sessionId" }));
                    return;
                }

                const transport = transports.get(sessionId);
                if (!transport) {
                    setCors(res);
                    res.writeHead(404, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "Unknown sessionId" }));
                    return;
                }

                // setCors(res); // si necesitas CORS en POST
                await transport.handlePostMessage(req, res);
                return;
            }

            res.writeHead(404).end("Not Found");
        } catch (e: any) {
            const status = e?.statusCode ?? 500;
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: e?.message ?? "Internal error" }));
        }
    });

    server.listen(PORT, "0.0.0.0", () => {
        const publicUrl = process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${PORT}`;
        console.log(`✅ MCP server listening on ${publicUrl}`);
        console.log(`Health: ${publicUrl}/health`);
        console.log(`SSE:   ${publicUrl}/mcp/sse`);
        console.log(`POST:  ${publicUrl}/mcp/messages?sessionId=...`);
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
