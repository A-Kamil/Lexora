import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// The lawyer dashboard reads demo data from `src/mocks` for now (see
// `src/lib/api.ts`); no dev proxy is needed until the backend exposes its
// read API.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: { port: 5173 },
});
