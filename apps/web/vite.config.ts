import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, '');
  const target =
    process.env.VITE_API_PROXY ?? env.VITE_API_PROXY ?? 'http://127.0.0.1:3000';
  return {
    envDir: workspaceRoot,
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: Number(process.env.WEB_PORT ?? 5173),
      strictPort: true,
      // Proxy the backend namespaces only, not the `/api` prefix: the SPA
      // owns sibling routes like /api-keys, and a prefix proxy turns a
      // refresh or deep link to them into the API's 404.
      proxy: {
        '/api/v1': { target },
        '/api/openapi.json': { target },
        '/health': { target },
      },
    },
  };
});
