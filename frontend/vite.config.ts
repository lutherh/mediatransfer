import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: true,
    hmr: {
      // Use a dedicated path for HMR WebSocket so query params (e.g. ?token=)
      // don't interfere with the WebSocket handshake
      path: '/__vite_hmr',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    slowTestThreshold: 300,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/vite-env.d.ts',
      ],
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
    },
  },
});
