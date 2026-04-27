import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "web",
  server: {
    port: 7325,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@ry": path.resolve(__dirname, "../../src"),
    },
  },
  plugins: [react()],
});
