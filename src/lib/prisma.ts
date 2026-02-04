import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

declare global {
  var __prisma: PrismaClient | undefined;
}

const connectionString = process.env.DATABASE_URL || "";
const isProduction = connectionString.includes("render.com") || 
                     connectionString.includes("amazonaws.com") ||
                     connectionString.includes("sslmode");

const pool = new Pool({ 
  connectionString,
  ssl: isProduction ? {
    rejectUnauthorized: false,
  } : undefined
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