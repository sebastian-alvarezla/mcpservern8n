"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const zod_1 = require("zod");
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const prisma_1 = require("./lib/prisma");
const client_1 = require("@prisma/client");
const PORT = Number(process.env.PORT ?? 3333);
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";
const transports = new Map();
// Cache del token SSO
let ssoTokenCache = null;
async function getSSOToken() {
    // Si hay token en cache y no ha expirado, usarlo
    if (ssoTokenCache && Date.now() < ssoTokenCache.expiresAt) {
        return ssoTokenCache.token;
    }
    // Obtener nuevo token
    const tokenResponse = await fetch(process.env.SSO_TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "password",
            client_id: process.env.SSO_CLIENT_ID,
            client_secret: process.env.SSO_CLIENT_SECRET,
            username: process.env.SSO_USERNAME,
            password: process.env.SSO_PASSWORD,
        }),
    });
    if (!tokenResponse.ok) {
        throw new Error(`Token request failed: ${tokenResponse.statusText}`);
    }
    const tokenData = await tokenResponse.json();
    // Cachear token (expira en expires_in segundos - 60s de margen)
    const expiresIn = tokenData.expires_in || 300;
    ssoTokenCache = {
        token: tokenData.access_token,
        expiresAt: Date.now() + (expiresIn - 60) * 1000,
    };
    return tokenData.access_token;
}
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
function parseChannel(input) {
    const v = input.toLowerCase();
    if (v === "whatsapp")
        return client_1.Channel.whatsapp;
    if (v === "web")
        return client_1.Channel.web;
    return client_1.Channel.other;
}
async function ensureUserAndConversation(args) {
    const channel = parseChannel(args.channel);
    const user = await prisma_1.prisma.user.upsert({
        where: { channel_externalId: { channel, externalId: args.externalId } },
        create: {
            channel,
            externalId: args.externalId,
            phone: args.phone,
            docNumber: args.docNumber,
            conversations: { create: {} },
        },
        update: {
            phone: args.phone ?? undefined,
            docNumber: args.docNumber ?? undefined,
        },
        include: { conversations: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    let conversation = user.conversations[0];
    if (!conversation) {
        conversation = await prisma_1.prisma.conversation.create({
            data: { userId: user.id },
        });
    }
    await prisma_1.prisma.conversationState.upsert({
        where: { conversationId: conversation.id },
        create: { conversationId: conversation.id, data: {} },
        update: {},
    });
    return { user, conversation };
}
async function main() {
    const mcp = new mcp_js_1.McpServer({
        name: "mcp-server-agent",
        version: "0.1.0",
    });
    /**
     * Tool 1: ping
     */
    mcp.tool("ping", "Devuelve pong", {}, async () => {
        return { content: [{ type: "text", text: "pong" }] };
    });
    /**
     * Tool 2: initConversation
     */
    mcp.tool("initConversation", "Inicializa usuario/conversación (idempotente) y asegura state en DB", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
        phone: zod_1.z.string().optional(),
        docNumber: zod_1.z.string().optional(),
    }, async (args) => {
        const { channel, externalId, phone, docNumber } = args;
        const { user, conversation } = await ensureUserAndConversation({
            channel,
            externalId,
            phone,
            docNumber,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        userId: user.id,
                        conversationId: conversation.id,
                    }),
                },
            ],
        };
    });
    /**
     * Tool 3: requestPolicyConsent
     */
    mcp.tool("requestPolicyConsent", "Solicita al usuario que acepte la política de datos enviando un template de WhatsApp con botones", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
    }, async (args) => {
        const { channel, externalId } = args;
        await ensureUserAndConversation({
            channel,
            externalId,
        });
        // Retorna instrucción para n8n de enviar el template
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        action: "sendPolicyTemplate",
                        templateName: "policy_consent",
                        message: "Se debe enviar el template de políticas de WhatsApp"
                    })
                }],
        };
    });
    /**
     * Tool 4: recordConsent
     */
    mcp.tool("recordConsent", "Registra aceptación/rechazo de política de tratamiento de datos", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
        policyVersion: zod_1.z.string().min(1),
        accepted: zod_1.z.boolean(),
        meta: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
    }, async (args) => {
        const { channel, externalId, policyVersion, accepted, meta } = args;
        const { conversation } = await ensureUserAndConversation({
            channel,
            externalId,
        });
        const consent = await prisma_1.prisma.consent.create({
            data: {
                conversationId: conversation.id,
                policyVersion,
                accepted,
                acceptedAt: accepted ? new Date() : null,
                meta: meta ?? {},
            },
        });
        return {
            content: [{ type: "text", text: JSON.stringify({ consentId: consent.id }) }],
        };
    });
    /**
     * Tool 5: saveDocNumber
     */
    mcp.tool("saveDocNumber", "Guarda el número de documento de identidad del usuario", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
        docNumber: zod_1.z.string().min(1),
    }, async (args) => {
        const { channel, externalId, docNumber } = args;
        const { user } = await ensureUserAndConversation({
            channel,
            externalId,
        });
        const updatedUser = await prisma_1.prisma.user.update({
            where: { id: user.id },
            data: { docNumber },
        });
        return {
            content: [{ type: "text", text: JSON.stringify({
                        userId: updatedUser.id,
                        docNumber: updatedUser.docNumber
                    }) }],
        };
    });
    /**
     * Tool 6: requestDocNumberConfirmation
     */
    mcp.tool("requestDocNumberConfirmation", "Solicita confirmación del número de documento mediante template de WhatsApp", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
        docNumber: zod_1.z.string().min(1),
    }, async (args) => {
        const { channel, externalId, docNumber } = args;
        await ensureUserAndConversation({
            channel,
            externalId,
        });
        // Retorna instrucción para n8n de enviar el template de confirmación
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        action: "sendDocConfirmation",
                        templateName: "doc_confirmation",
                        docNumber: docNumber,
                        message: "Se debe enviar el template de confirmación de documento"
                    })
                }],
        };
    });
    /**
     * Tool 7: validateUserInSSO
     */
    mcp.tool("validateUserInSSO", "Valida la existencia del usuario en el SSO mediante su documento", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
        docNumber: zod_1.z.string().min(1),
    }, async (args) => {
        const { channel, externalId, docNumber } = args;
        try {
            // Paso 1: Obtener token OAuth2 (con cache)
            const accessToken = await getSSOToken();
            // Paso 2: Validar existencia del usuario
            const checkUrl = `${process.env.SSO_CHECK_EXISTENCE_URL}?documento=${docNumber}`;
            const checkResponse = await fetch(checkUrl, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
            });
            if (!checkResponse.ok) {
                throw new Error(`User check failed: ${checkResponse.statusText}`);
            }
            const userData = await checkResponse.json();
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            exists: userData.exists || false,
                            docNumber,
                            userData: userData,
                        }),
                    }],
            };
        }
        catch (error) {
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            exists: false,
                            error: error.message,
                            docNumber,
                        }),
                    }],
            };
        }
    });
    /**
     * Tool 8: getState
     */
    mcp.tool("getState", "Obtiene el estado JSON de la conversación", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
    }, async (args) => {
        const { channel, externalId } = args;
        const { conversation } = await ensureUserAndConversation({
            channel,
            externalId,
        });
        const state = await prisma_1.prisma.conversationState.findUnique({
            where: { conversationId: conversation.id },
        });
        return {
            content: [{ type: "text", text: JSON.stringify({ data: state?.data ?? {} }) }],
        };
    });
    /**
     * Tool 9: setState
     */
    mcp.tool("setState", "Actualiza el estado JSON: replace=true reemplaza, si no hace merge superficial", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
        data: zod_1.z.record(zod_1.z.string(), zod_1.z.any()),
        replace: zod_1.z.boolean().default(false),
    }, async (args) => {
        const { channel, externalId, data, replace } = args;
        const { conversation } = await ensureUserAndConversation({
            channel,
            externalId,
        });
        const current = await prisma_1.prisma.conversationState.findUnique({
            where: { conversationId: conversation.id },
        });
        const nextData = replace || !current?.data || typeof current.data !== "object"
            ? data
            : { ...current.data, ...data };
        await prisma_1.prisma.conversationState.update({
            where: { conversationId: conversation.id },
            data: { data: nextData },
        });
        return {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        };
    });
    /**
     * Tool 10: appendMessage
     */
    mcp.tool("appendMessage", "Guarda un mensaje en la conversación", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
        role: zod_1.z.string().min(1),
        content: zod_1.z.string().min(1),
        meta: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
    }, async (args) => {
        const { channel, externalId, role, content, meta } = args;
        const { conversation } = await ensureUserAndConversation({
            channel,
            externalId,
        });
        const msg = await prisma_1.prisma.message.create({
            data: {
                conversationId: conversation.id,
                role,
                content,
                meta: meta ?? {},
            },
        });
        return {
            content: [{ type: "text", text: JSON.stringify({ messageId: msg.id }) }],
        };
    });
    /**
     * Tool 11: getConversationSummary
     */
    mcp.tool("getConversationSummary", "Devuelve info básica: último consentimiento, estado y últimos N mensajes", {
        channel: zod_1.z.string().default("whatsapp"),
        externalId: zod_1.z.string().min(1),
        lastMessages: zod_1.z.number().int().min(1).max(50).default(10),
    }, async (args) => {
        const { channel, externalId, lastMessages } = args;
        const { user, conversation } = await ensureUserAndConversation({
            channel,
            externalId,
        });
        const [state, lastConsent, messages] = await Promise.all([
            prisma_1.prisma.conversationState.findUnique({
                where: { conversationId: conversation.id },
            }),
            prisma_1.prisma.consent.findFirst({
                where: { conversationId: conversation.id },
                orderBy: { createdAt: "desc" },
            }),
            prisma_1.prisma.message.findMany({
                where: { conversationId: conversation.id },
                orderBy: { createdAt: "desc" },
                take: lastMessages,
            }),
        ]);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        user: {
                            id: user.id,
                            channel: user.channel,
                            externalId: user.externalId,
                            phone: user.phone,
                        },
                        conversationId: conversation.id,
                        consent: lastConsent
                            ? {
                                policyVersion: lastConsent.policyVersion,
                                accepted: lastConsent.accepted,
                                acceptedAt: lastConsent.acceptedAt,
                            }
                            : null,
                        state: state?.data ?? {},
                        messages: messages.reverse(),
                    }),
                },
            ],
        };
    });
    const server = (0, node_http_1.createServer)(async (req, res) => {
        try {
            if (!req.url) {
                res.writeHead(400).end("Bad Request");
                return;
            }
            if (req.method === "GET" && req.url === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            /**
             * 1) SSE handshake
             */
            if (req.method === "GET" && req.url.startsWith("/mcp/sse")) {
                assertAuth(req);
                const transport = new sse_js_1.SSEServerTransport("/mcp/messages", res);
                transports.set(transport.sessionId, transport);
                res.on("close", () => {
                    transports.delete(transport.sessionId);
                });
                await mcp.connect(transport);
                return;
            }
            /**
             * 2) POST messages
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
        console.log(`SSE:    http://localhost:${PORT}/mcp/sse`);
        console.log(`POST:   http://localhost:${PORT}/mcp/messages?sessionId=...`);
    });
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
