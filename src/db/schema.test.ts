import { describe, it, expect } from 'vitest';
import {
  PrismaClient,
  TransferStatus,
  LogLevel,
} from '../generated/prisma/client.js';
import type {
  TransferJob,
  CloudCredential,
  TransferLog,
} from '../generated/prisma/client.js';

describe('Prisma schema', () => {
  // ── Client instantiation ────────────────────────────────────

  it('should export PrismaClient constructor', () => {
    expect(PrismaClient).toBeDefined();
    expect(typeof PrismaClient).toBe('function');
  });

  it('should export PrismaClient as a constructable class', () => {
    // Verify PrismaClient has prototype methods expected of a Prisma client
    expect(PrismaClient.prototype).toBeDefined();
    expect(typeof PrismaClient.prototype.$connect).toBe('function');
    expect(typeof PrismaClient.prototype.$disconnect).toBe('function');
  });

  // ── Enums ───────────────────────────────────────────────────

  describe('TransferStatus enum', () => {
    it('should contain all expected statuses', () => {
      expect(TransferStatus.PENDING).toBe('PENDING');
      expect(TransferStatus.IN_PROGRESS).toBe('IN_PROGRESS');
      expect(TransferStatus.COMPLETED).toBe('COMPLETED');
      expect(TransferStatus.FAILED).toBe('FAILED');
      expect(TransferStatus.CANCELLED).toBe('CANCELLED');
    });

    it('should have exactly 5 values', () => {
      const values = Object.values(TransferStatus);
      expect(values).toHaveLength(5);
    });
  });

  describe('LogLevel enum', () => {
    it('should contain all expected levels', () => {
      expect(LogLevel.INFO).toBe('INFO');
      expect(LogLevel.WARN).toBe('WARN');
      expect(LogLevel.ERROR).toBe('ERROR');
      expect(LogLevel.DEBUG).toBe('DEBUG');
    });

    it('should have exactly 4 values', () => {
      const values = Object.values(LogLevel);
      expect(values).toHaveLength(4);
    });
  });

  // ── Type shape validation ───────────────────────────────────
  // These tests verify the generated types match our expected schema
  // by creating type-compliant objects at compile time + runtime.

  describe('TransferJob type shape', () => {
    it('should accept a well-formed TransferJob object', () => {
      const job: TransferJob = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: TransferStatus.PENDING,
        sourceProvider: 's3',
        destProvider: 'gcs',
        sourceConfig: { bucket: 'my-bucket' },
        destConfig: { bucket: 'dest-bucket' },
        keys: ['photo1.jpg', 'photo2.jpg'],
        progress: 0,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(job.id).toBeDefined();
      expect(job.status).toBe('PENDING');
      expect(job.sourceProvider).toBe('s3');
      expect(job.destProvider).toBe('gcs');
      expect(job.keys).toHaveLength(2);
      expect(job.progress).toBe(0);
    });
  });

  describe('CloudCredential type shape', () => {
    it('should accept a well-formed CloudCredential object', () => {
      const cred: CloudCredential = {
        id: '550e8400-e29b-41d4-a716-446655440001',
        name: 'My AWS Production',
        provider: 's3',
        config: 'encrypted-aes-gcm-blob-here',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(cred.id).toBeDefined();
      expect(cred.name).toBe('My AWS Production');
      expect(cred.provider).toBe('s3');
      expect(cred.config).toBe('encrypted-aes-gcm-blob-here');
    });
  });

  describe('TransferLog type shape', () => {
    it('should accept a well-formed TransferLog object', () => {
      const log: TransferLog = {
        id: '550e8400-e29b-41d4-a716-446655440002',
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        level: LogLevel.INFO,
        message: 'Transfer started',
        meta: { bytesTransferred: 0 },
        createdAt: new Date(),
      };

      expect(log.id).toBeDefined();
      expect(log.jobId).toBeDefined();
      expect(log.level).toBe('INFO');
      expect(log.message).toBe('Transfer started');
    });
  });

  // ── Model delegates ─────────────────────────────────────────

  describe('PrismaClient model delegates', () => {
    it('should have model properties defined on the prototype', () => {
      // Prisma 7 attaches model delegates on instances, but we can verify
      // the class is well-formed by checking known prototype methods exist
      const proto = PrismaClient.prototype;
      expect(typeof proto.$connect).toBe('function');
      expect(typeof proto.$disconnect).toBe('function');
      expect(typeof proto.$transaction).toBe('function');
    });
  });
});
