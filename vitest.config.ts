import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15000,
    slowTestThreshold: 250,
    pool: 'forks',
    // Reuse a single fork process for all test files — avoids ~30 cold-start
    // overheads on Windows where forking is expensive.
    forks: {
      singleFork: true,
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/generated/**',
        'src/**/index.ts',
        'src/api/server.ts',
      ],
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
    },
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});
