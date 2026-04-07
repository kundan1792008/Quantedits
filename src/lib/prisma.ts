/**
 * Prisma client singleton.
 *
 * Prisma v7 requires a driver adapter for direct database connections.
 * We use @prisma/adapter-pg backed by a pg Pool so that the same Pool
 * is reused across hot-reloads in development.
 */

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  pgPool?: Pool;
};

function createPool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

const pool = globalForPrisma.pgPool ?? createPool();
const adapter = new PrismaPg(pool);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.pgPool = pool;
  globalForPrisma.prisma = prisma;
}
