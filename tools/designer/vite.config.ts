import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "web",
  server: {
    port: 7322,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:7321",
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      // Browser-safe imports from the canonical sim module. Files in
      // src/sim/ have no DOM/Babylon/Node deps; they run unchanged in
      // the browser via Vite. The viewer imports `@sim/index.js` etc.
      "@sim": path.resolve(__dirname, "../../src/sim"),
    },
  },
  plugins: [react()],
});
