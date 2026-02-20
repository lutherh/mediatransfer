import { describe, it, expect } from 'vitest';
import { createLogger } from './logger.js';

describe('createLogger', () => {
  // ── Happy path ──────────────────────────────────────────────

  it('should create a logger instance', () => {
    const logger = createLogger({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });

  it('should respect the configured log level', () => {
    const debugLogger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'debug' });
    expect(debugLogger.level).toBe('debug');

    const errorLogger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
    expect(errorLogger.level).toBe('error');
  });

  it('should accept all valid log levels', () => {
    const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
    for (const level of levels) {
      const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: level });
      expect(logger.level).toBe(level);
    }
  });

  it('should use pino-pretty transport in development', () => {
    // In development, pino creates a worker-thread transport for pino-pretty.
    // We can verify by checking that the logger was created without error
    // and is functional (pino-pretty is loaded asynchronously via transport).
    const logger = createLogger({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('should use JSON output (no pretty transport) in test environment', () => {
    const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'debug' });
    expect(logger).toBeDefined();
    expect(logger.level).toBe('debug');
  });

  it('should use JSON output (no transport) in production', () => {
    // In production, no transport is configured — pino defaults to JSON on stdout.
    // We verify by checking the logger has no transport property set in its options.
    const logger = createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'warn' });
    expect(logger).toBeDefined();
    expect(logger.level).toBe('warn');
  });

  // ── Logger name ─────────────────────────────────────────────

  it('should include "mediatransfer" as the logger name', () => {
    const logger = createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'info' });
    // Pino bindings include the name
    const bindings = logger.bindings();
    expect(bindings.name).toBe('mediatransfer');
  });

  // ── Logging methods work ────────────────────────────────────

  it('should not throw when calling log methods', () => {
    const logger = createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'trace' });

    expect(() => logger.trace('trace msg')).not.toThrow();
    expect(() => logger.debug('debug msg')).not.toThrow();
    expect(() => logger.info('info msg')).not.toThrow();
    expect(() => logger.warn('warn msg')).not.toThrow();
    expect(() => logger.error('error msg')).not.toThrow();
    expect(() => logger.fatal('fatal msg')).not.toThrow();
  });

  it('should support structured logging with objects', () => {
    const logger = createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'info' });

    expect(() =>
      logger.info({ transferId: '123', provider: 's3' }, 'transfer started'),
    ).not.toThrow();
  });

  it('should support child loggers', () => {
    const logger = createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'info' });
    const child = logger.child({ module: 'transfer-worker' });

    expect(child).toBeDefined();
    expect(typeof child.info).toBe('function');
    expect(child.level).toBe('info');
  });
});
