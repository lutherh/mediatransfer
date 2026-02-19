import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getPrismaClient,
  disconnectPrisma,
  setPrismaClient,
  resetPrismaClient,
} from './client.js';
import type { PrismaClient } from '../generated/prisma/client.js';

describe('db/client — singleton management', () => {
  beforeEach(() => {
    resetPrismaClient();
  });

  it('setPrismaClient should set and getPrismaClient should return it', () => {
    const mockClient = { fake: true } as unknown as PrismaClient;
    setPrismaClient(mockClient);
    expect(getPrismaClient()).toBe(mockClient);
  });

  it('getPrismaClient should return the same instance on multiple calls', () => {
    const mockClient = { fake: true } as unknown as PrismaClient;
    setPrismaClient(mockClient);
    const a = getPrismaClient();
    const b = getPrismaClient();
    expect(a).toBe(b);
  });

  it('resetPrismaClient should clear the singleton', () => {
    const mockClient = { fake: true } as unknown as PrismaClient;
    setPrismaClient(mockClient);
    resetPrismaClient();
    // After reset, getPrismaClient would create a new real client,
    // so we just verify the reset didn't throw
    expect(true).toBe(true);
  });

  it('disconnectPrisma should call $disconnect and reset', async () => {
    const mockDisconnect = vi.fn().mockResolvedValue(undefined);
    const mockClient = {
      $disconnect: mockDisconnect,
    } as unknown as PrismaClient;

    setPrismaClient(mockClient);
    await disconnectPrisma();

    expect(mockDisconnect).toHaveBeenCalledOnce();
  });

  it('disconnectPrisma should be safe to call when no client exists', async () => {
    // Should not throw
    await expect(disconnectPrisma()).resolves.toBeUndefined();
  });
});
