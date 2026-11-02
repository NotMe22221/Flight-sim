import { defineConfig } from 'vitest/config';

// GitHub Pages serves project sites from /<repo>/ — set VITE_BASE in CI.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
