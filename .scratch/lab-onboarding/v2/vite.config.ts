import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@labos-threejs/ui': `${repository}packages/ui/src`,
      cn: `${repository}packages/ui/node_modules/cn`,
    },
    dedupe: ['react', 'react-dom', 'three', '@react-three/fiber'],
  },
  server: {
    port: 5194,
    fs: { allow: [repository] },
    // Forwarded browser warnings append to this log; watching it creates a reload loop.
    watch: { ignored: ['**/dev-server.log', '**/evidence/**', '**/dist/**'] },
  },
});
