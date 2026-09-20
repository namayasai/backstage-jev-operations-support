import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: {
    '@namayasai/backstage-plugin-jev-operations-support-common': resolve(__dirname, 'plugins/jev-operations-support-common/src/index.ts'),
    '@namayasai/backstage-plugin-jev-operations-support-backend/client': resolve(__dirname, 'plugins/jev-operations-support-backend/src/client.ts'),
  } },
  test: {
    include: ['plugins/**/*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    // Several tests do real socket I/O through supertest or render real MUI trees in jsdom.
    // That work is normally well under vitest's 5s defaults, but under full-suite parallel load
    // a worker thread can be starved of CPU by the ~19 other files running concurrently, pushing
    // an otherwise-fast test just over the default budget (observed once at ~5004ms). This isn't
    // slow or broken tests, it's CPU contention between parallel workers, so give every test (and
    // hook) real headroom globally rather than scattering per-file overrides. No assertion changes.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ['./test-setup.ts'],
  },
});
