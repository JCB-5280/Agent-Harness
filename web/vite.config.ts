import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the dashboard into ../public, which the Fastify server serves as static
// files. In a corp deploy the Docker build runs `npm --prefix web run build`.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: '../public', emptyOutDir: true },
});
