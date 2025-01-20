import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources directly; no build step required.
    alias: [{ find: /^@ferrule\/([a-z-]+)$/, replacement: `${packagesDir}$1/src/index.ts` }],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
