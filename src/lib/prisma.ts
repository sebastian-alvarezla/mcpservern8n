import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

declare global {
  var __prisma: PrismaClient | undefined;
}

// Detectar si la URL requiere SSL (contiene sslmode o es una conexión externa)
const connectionString = process.env.DATABASE_URL || "";
const requiresSSL = connectionString.includes("sslmode=require") || 
                    connectionString.includes("render.com") ||
                    connectionString.includes("amazonaws.com");

const pool = new Pool({ 
  connectionString,
  ssl: requiresSSL ? { rejectUnauthorized: false } : false
});
const adapter = new PrismaPg(pool);

export const prisma =
  global.__prisma ??
  new PrismaClient({
    adapter,
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}