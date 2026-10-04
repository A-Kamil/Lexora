import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// The dashboard reads the API's /api/cases (apps/api, port 3000 by default; LEXORA_API_URL overrides).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.LEXORA_API_URL ?? 'http://localhost:3000',
      '/health': process.env.LEXORA_API_URL ?? 'http://localhost:3000',
    },
  },
});
