-- CreateTable
CREATE TABLE "mcp_users" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "policyAccepted" BOOLEAN NOT NULL DEFAULT false,
    "policySentAt" TIMESTAMP(3),
    "policyAcceptedAt" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_users_userId_key" ON "mcp_users"("userId");
