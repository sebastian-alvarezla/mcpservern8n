import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { prisma } from "./lib/prisma";
import { Channel } from "@prisma/client";

const PORT = Number(process.env.PORT ?? 3333);
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN ?? "";

const transports = new Map<string, SSEServerTransport>();

// Cache del token SSO
let ssoTokenCache: { token: string; expiresAt: number } | null = null;

async function getSSOToken(): Promise<string> {
  // Si hay token en cache y no ha expirado, usarlo
  if (ssoTokenCache && Date.now() < ssoTokenCache.expiresAt) {
    return ssoTokenCache.token;
  }

  // Obtener nuevo token
  const tokenResponse = await fetch(process.env.SSO_TOKEN_URL!, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: process.env.SSO_CLIENT_ID!,
      client_secret: process.env.SSO_CLIENT_SECRET!,
      username: process.env.SSO_USERNAME!,
      password: process.env.SSO_PASSWORD!,
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

function assertAuth(req: IncomingMessage) {
  if (!MCP_BEARER_TOKEN) return;
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${MCP_BEARER_TOKEN}`) {
    const err: any = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

function parseChannel(input: string): Channel {
  const v = input.toLowerCase();
  if (v === "whatsapp") return Channel.whatsapp;
  if (v === "web") return Channel.web;
  return Channel.other;
}

async function ensureUserAndConversation(args: {
  channel: string;
  externalId: string;
  phone?: string;
  docNumber?: string;
}) {
  const channel = parseChannel(args.channel);

  const user = await prisma.user.upsert({
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
    conversation = await prisma.conversation.create({
      data: { userId: user.id },
    });
  }

  await prisma.conversationState.upsert({
    where: { conversationId: conversation.id },
    create: { conversationId: conversation.id, data: {} },
    update: {},
  });

  return { user, conversation };
}

async function main() {
  const mcp = new McpServer({
    name: "mcp-server-agent",
    version: "0.1.0",
  });

  /**
   * Tool 1: ping
   */
  mcp.tool(
    "ping",
    "Devuelve pong",
    {},
    async () => {
      return { content: [{ type: "text", text: "pong" }] };
    }
  );

  /**
   * Tool 2: initConversation
   */
  mcp.tool(
    "initConversation",
    "Inicializa usuario/conversación (idempotente) y asegura state en DB",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
      phone: z.string().optional(),
      docNumber: z.string().optional(),
    },
    async (args) => {
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
    }
  );

  /**
   * Tool 3: requestPolicyConsent
   */
  mcp.tool(
    "requestPolicyConsent",
    "Solicita al usuario que acepte la política de datos enviando un template de WhatsApp con botones",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
    },
    async (args) => {
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
    }
  );

  /**
   * Tool 4: recordConsent
   */
  mcp.tool(
    "recordConsent",
    "Registra aceptación/rechazo de política de tratamiento de datos",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
      policyVersion: z.string().min(1),
      accepted: z.boolean(),
      meta: z.record(z.string(), z.any()).optional(),
    },
    async (args) => {
      const { channel, externalId, policyVersion, accepted, meta } = args;

      const { conversation } = await ensureUserAndConversation({
        channel,
        externalId,
      });

      const consent = await prisma.consent.create({
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
    }
  );

  /**
   * Tool 5: saveDocNumber
   */
  mcp.tool(
    "saveDocNumber",
    "Guarda el número de documento de identidad del usuario",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
      docNumber: z.string().min(1),
    },
    async (args) => {
      const { channel, externalId, docNumber } = args;

      const { user } = await ensureUserAndConversation({
        channel,
        externalId,
      });

      const updatedUser = await prisma.user.update({
        where: { id: user.id },
        data: { docNumber },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ 
          userId: updatedUser.id,
          docNumber: updatedUser.docNumber 
        }) }],
      };
    }
  );

  /**
   * Tool 6: requestDocNumberConfirmation
   */
  mcp.tool(
    "requestDocNumberConfirmation",
    "Solicita confirmación del número de documento mediante template de WhatsApp",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
      docNumber: z.string().min(1),
    },
    async (args) => {
      const { channel, externalId, docNumber } = args;

      const { conversation } = await ensureUserAndConversation({
        channel,
        externalId,
      });

      // Actualizar estado para indicar que estamos esperando confirmación
      await prisma.conversationState.update({
        where: { conversationId: conversation.id },
        data: { 
          data: { 
            step: "awaiting_doc_confirmation",
            docNumber: docNumber 
          } 
        },
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
    }
  );

  /**
   * Tool 7: confirmDocNumber
   */
  mcp.tool(
    "confirmDocNumber",
    "El usuario confirma que su número de documento es correcto",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
    },
    async (args) => {
      const { channel, externalId } = args;

      const { conversation } = await ensureUserAndConversation({
        channel,
        externalId,
      });

      // Actualizar estado
      await prisma.conversationState.update({
        where: { conversationId: conversation.id },
        data: { 
          data: { 
            step: "document_confirmed"
          } 
        },
      });

      return {
        content: [{ 
          type: "text", 
          text: JSON.stringify({ 
            confirmed: true,
            message: "Documento confirmado correctamente"
          }) 
        }],
      };
    }
  );

  /**
   * Tool 8: validateCurrentUser
   */
  mcp.tool(
    "validateCurrentUser",
    "Valida el usuario actual en el SSO usando el documento guardado en su estado",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
    },
    async (args) => {
      const { channel, externalId } = args;

      // Obtener el documento del usuario desde la BD
      const { user, conversation } = await ensureUserAndConversation({
        channel,
        externalId,
      });

      if (!user.docNumber) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              exists: false,
              error: "No document number found for user",
            }),
          }],
        };
      }

      try {
        // Obtener token OAuth2 (con cache)
        const accessToken = await getSSOToken();

        // Validar existencia del usuario
        const checkUrl = `${process.env.SSO_CHECK_EXISTENCE_URL}?documento=${user.docNumber}`;
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
              docNumber: user.docNumber,
              userData: userData,
            }),
          }],
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              exists: false,
              error: error.message,
              docNumber: user.docNumber,
            }),
          }],
        };
      }
    }
  );

  /**
   * Tool 9: validateUserInSSO
   */
  mcp.tool(
    "validateUserInSSO",
    "Valida la existencia del usuario en el SSO mediante su documento",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
      docNumber: z.string().min(1),
    },
    async (args) => {
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
      } catch (error: any) {
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
    }
  );

  /**
   * Tool 10: getState
   */
  mcp.tool(
    "getState",
    "Obtiene el estado JSON de la conversación",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
    },
    async (args) => {
      const { channel, externalId } = args;

      const { conversation } = await ensureUserAndConversation({
        channel,
        externalId,
      });

      const state = await prisma.conversationState.findUnique({
        where: { conversationId: conversation.id },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ data: state?.data ?? {} }) }],
      };
    }
  );

  /**
   * Tool 11: setState
   */
  mcp.tool(
    "setState",
    "Actualiza el estado JSON: replace=true reemplaza, si no hace merge superficial",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
      data: z.record(z.string(), z.any()),
      replace: z.boolean().default(false),
    },
    async (args) => {
      const { channel, externalId, data, replace } = args;

      const { conversation } = await ensureUserAndConversation({
        channel,
        externalId,
      });

      const current = await prisma.conversationState.findUnique({
        where: { conversationId: conversation.id },
      });

      const nextData =
        replace || !current?.data || typeof current.data !== "object"
          ? data
          : { ...(current.data as any), ...data };

      await prisma.conversationState.update({
        where: { conversationId: conversation.id },
        data: { data: nextData },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  /**
   * Tool 12: appendMessage
   */
  mcp.tool(
    "appendMessage",
    "Guarda un mensaje en la conversación",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
      role: z.string().min(1),
      content: z.string().min(1),
      meta: z.record(z.string(), z.any()).optional(),
    },
    async (args) => {
      const { channel, externalId, role, content, meta } = args;

      const { conversation } = await ensureUserAndConversation({
        channel,
        externalId,
      });

      const msg = await prisma.message.create({
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
    }
  );

  /**
   * Tool 13: getConversationSummary
   */
  mcp.tool(
    "getConversationSummary",
    "Devuelve info básica: último consentimiento, estado y últimos N mensajes",
    {
      channel: z.string().default("whatsapp"),
      externalId: z.string().min(1),
      lastMessages: z.number().int().min(1).max(50).default(10),
    },
    async (args) => {
      const { channel, externalId, lastMessages } = args;

      const { user, conversation } = await ensureUserAndConversation({
        channel,
        externalId,
      });

      const [state, lastConsent, messages] = await Promise.all([
        prisma.conversationState.findUnique({
          where: { conversationId: conversation.id },
        }),
        prisma.consent.findFirst({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: "desc" },
        }),
        prisma.message.findMany({
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
    }
  );

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

        const transport = new SSEServerTransport("/mcp/messages", res);
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
    } catch (e: any) {
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
