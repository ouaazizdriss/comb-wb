import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 2000 },
});
