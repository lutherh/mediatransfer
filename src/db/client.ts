import { PrismaClient } from '../generated/prisma/client.js';

let prisma: PrismaClient | null = null;

/**
 * Get the singleton Prisma client instance.
 * Creates one on first call; reuses it on subsequent calls.
 */
export function getPrismaClient(): PrismaClient {
  if (!prisma) {
    // Adapter / connection options are injected via prisma.config.ts at runtime.
    // The Prisma 7 constructor type demands adapter|accelerateUrl but the
    // runtime engine resolves the datasource from the config file.
    prisma = new (PrismaClient as unknown as new () => PrismaClient)();
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
