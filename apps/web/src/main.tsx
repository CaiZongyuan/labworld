import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createApiClient } from '@labos-threejs/sdk';
import '@labos-threejs/ui/styles.css';
import { createAppRouter } from './router';

const queryClient = new QueryClient();
const router = createAppRouter({
  apiClient: createApiClient(window.location.origin),
  docsUrl:
    import.meta.env.VITE_DOCS_URL ?? 'https://caizongyuan.github.io/labworld/',
});
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
