import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The service worker cache is tied to the build by client/scripts/stamp-sw.mjs,
// which runs after `vite build` (see package.json "build").
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
  preview: { port: 4173, proxy: { '/api': 'http://localhost:4000' } },
});
