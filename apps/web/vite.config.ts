import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite dev server runs locally, but the engine's data + audio segments
// live on Whatbox. The dev workflow assumes an SSH tunnel is open:
//   ssh -N -L 20100:127.0.0.1:20100 whatbox &
// so /api/* and /hls/* requests from the React app reach the real
// engine through the tunnel.
//
// Override via env if you want to point at a local engine instead:
//   VITE_API_TARGET=http://127.0.0.1:3001 npm run dev --workspace=@pavoia/web
const PROXY_TARGET = process.env.VITE_API_TARGET ?? "http://127.0.0.1:20100";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: PROXY_TARGET,
        changeOrigin: false,
      },
      "/hls": {
        target: PROXY_TARGET,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // The engine's Hono static handler will serve these files in
    // production. Keep entry filenames hashed for cache-busting.
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
