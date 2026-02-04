"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = require("pg");
const connectionString = process.env.DATABASE_URL || "";
const isProduction = connectionString.includes("render.com") ||
    connectionString.includes("amazonaws.com") ||
    connectionString.includes("sslmode");
const pool = new pg_1.Pool({
    connectionString,
    ssl: isProduction ? {
        rejectUnauthorized: false,
    } : undefined
});
const adapter = new adapter_pg_1.PrismaPg(pool);
exports.prisma = global.__prisma ??
    new client_1.PrismaClient({
        adapter,
        log: ["error", "warn"],
    });
if (process.env.NODE_ENV !== "production") {
    global.__prisma = exports.prisma;
}
