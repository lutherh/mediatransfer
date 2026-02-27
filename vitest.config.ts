import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    slowTestThreshold: 250,
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
