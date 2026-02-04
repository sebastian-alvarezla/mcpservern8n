import { createServer } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
const PORT = Number(process.env.PORT ?? 3333);
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";
// Guardamos transportes por sessionId
const transports = new Map();
function assertAuth(req) {
    if (!MCP_BEARER_TOKEN)
        return;
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${MCP_BEARER_TOKEN}`) {
        const err = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
    }
}
async function main() {
    const mcp = new McpServer({
        name: "mcp-server-agent",
        version: "0.1.0",
    });
    // Tool demo para probar rápido desde n8n
    mcp.tool("ping", "Devuelve pong", { paramsSchema: z.object({}) }, async () => {
        return { content: [{ type: "text", text: "pong" }] };
    });
    const server = createServer(async (req, res) => {
        try {
            if (!req.url) {
                res.writeHead(400).end("Bad Request");
                return;
            }
            // Health
            if (req.method === "GET" && req.url === "/health") {
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
                const transport = new SSEServerTransport("/mcp/messages", res);
                transports.set(transport.sessionId, transport);
                // cuando el cliente cierre, limpiamos
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
                const urlObj = new URL(req.url, `http://localhost:${PORT}`);
                const sessionId = urlObj.searchParams.get("sessionId");
                if (!sessionId) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "Missing sessionId" }));
                    return;
                }
                const transport = transports.get(sessionId);
                if (!transport) {
                    res.writeHead(404, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "Unknown sessionId" }));
                    return;
                }
                await transport.handlePostMessage(req, res);
                return;
            }
            res.writeHead(404).end("Not Found");
        }
        catch (e) {
            const status = e?.statusCode ?? 500;
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: e?.message ?? "Internal error" }));
        }
    });
    server.listen(PORT, () => {
        console.log(`✅ MCP server listening on http://localhost:${PORT}`);
        console.log(`Health: http://localhost:${PORT}/health`);
        console.log(`SSE:   http://localhost:${PORT}/mcp/sse`);
        console.log(`POST:  http://localhost:${PORT}/mcp/messages?sessionId=...`);
    });
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
