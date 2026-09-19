import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'examples/playground', base: './', plugins: [react()],
  resolve: { alias: { '@namayasai/backstage-plugin-jev-operations-support-common': resolve(__dirname, 'plugins/jev-operations-support-common/src/index.ts') } },
  build: { outDir: '../../dist/playground', emptyOutDir: true },
});
