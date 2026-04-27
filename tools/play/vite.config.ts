import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "web",
  server: {
    port: 7323,
    strictPort: true,
    // Proxy card content from the designer server. Run `tools/designer`
    // (port 7321) alongside this app for the Battle screen to load real
    // content; without it the 3D battlefield will show a connect error.
    proxy: {
      "/api": {
        target: "http://localhost:7321",
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@ry":  path.resolve(__dirname, "../../src"),
      "@sim": path.resolve(__dirname, "../../src/sim"),
    },
  },
  plugins: [react()],
});
