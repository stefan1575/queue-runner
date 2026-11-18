// The window's page, built into desktop-dist/renderer and loaded from disk by the main process.
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: fileURLToPath(new URL('../desktop-dist/renderer', import.meta.url)), emptyOutDir: true },
});
