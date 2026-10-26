import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import './styles/tokens.css';
import { App } from './shell/App.tsx';
import { useApp } from './lib/store.ts';

// Dev-only hook for the screenshot tool (tools/shot.mjs). Not present in production builds.
if (import.meta.env.DEV) {
  (window as any).__comb = { openTab: (...a: Parameters<ReturnType<typeof useApp.getState>['openTab']>) => useApp.getState().openTab(...a), store: useApp };
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
