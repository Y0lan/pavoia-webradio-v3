import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { PlaybackProvider } from "./audio/PlaybackProvider.tsx";
import { ArtistDrawerProvider } from "./components/ArtistDrawer.tsx";
import { router } from "./router.tsx";
import "./index.css";

// One QueryClient for the whole app. Defaults match v1's polling
// budget but TanStack Query handles the visibility-pause logic
// (refetchOnWindowFocus + automatic pause when tab hidden).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Server data we display is mostly "current track" — fresh
      // for ~5 s is fine for a radio. Individual queries can
      // override via { staleTime, refetchInterval }.
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing #root element in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PlaybackProvider>
        <ArtistDrawerProvider>
          <RouterProvider router={router} />
        </ArtistDrawerProvider>
      </PlaybackProvider>
    </QueryClientProvider>
  </StrictMode>,
);
