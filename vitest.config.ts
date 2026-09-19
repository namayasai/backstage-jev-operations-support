import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: { '@namayasai/backstage-plugin-jev-operations-support-common': resolve(__dirname, 'plugins/jev-operations-support-common/src/index.ts') } },
  test: { include: ['plugins/**/*.test.{ts,tsx}'], environment: 'node', restoreMocks: true },
});
