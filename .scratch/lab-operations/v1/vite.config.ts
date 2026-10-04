import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@labos-threejs/ui': `${repository}packages/ui/src` },
    dedupe: ['react', 'react-dom', 'three'],
  },
  server: { fs: { allow: [repository] } },
});
