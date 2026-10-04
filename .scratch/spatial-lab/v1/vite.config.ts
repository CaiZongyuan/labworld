import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: `${repository}apps/web/public`,
  resolve: {
    alias: {
      '@labos-threejs/ui': `${repository}packages/ui/src`,
      cn: `${repository}packages/ui/node_modules/cn/dist/index.js`,
    },
    dedupe: ['react', 'react-dom', 'three', '@react-three/fiber'],
  },
  server: { fs: { allow: [repository] } },
});
