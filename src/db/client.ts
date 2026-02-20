import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

let prisma: PrismaClient | null = null;

/**
 * Get the singleton Prisma client instance.
 * Creates one on first call; reuses it on subsequent calls.
 */
export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required to initialize Prisma client');
    }

    const adapter = new PrismaPg({ connectionString: databaseUrl });
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}

/**
 * Disconnect the Prisma client and reset the singleton.
 * Call this during graceful shutdown.
 */
export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

/**
 * Replace the singleton with a custom instance (e.g., for testing).
 * @param client - The PrismaClient instance to use.
 */
export function setPrismaClient(client: PrismaClient): void {
  prisma = client;
}

/**
 * Reset the singleton to null (for testing teardown).
 */
export function resetPrismaClient(): void {
  prisma = null;
}
