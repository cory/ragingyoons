import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CARDS_DIR = path.join(REPO_ROOT, "cards");
const CARD_TYPES = [
  "units",
  "environments",
  "curiosities",
  "roles",
  "synergies",
  "comps",
  "statuses",
];

/** Tiny middleware that mirrors the designer's /api/cards endpoint —
 *  reads cards/ from the repo, parses YAML frontmatter, returns the
 *  same shape the browser sim-bridge expects. The lab is read-only
 *  for now (no card editing UI), so we only implement GET. */
function cardsApiPlugin(): Plugin {
  return {
    name: "steering-lab-cards-api",
    configureServer(server) {
      server.middlewares.use("/api/cards", async (req, res, next) => {
        if (req.method !== "GET") return next();
        try {
          const out: Record<string, unknown[]> = {};
          for (const type of CARD_TYPES) {
            const dir = path.join(CARDS_DIR, type);
            out[type] = [];
            let files: string[] = [];
            try {
              files = await fs.readdir(dir);
            } catch {
              continue;
            }
            for (const f of files) {
              if (!f.endsWith(".md")) continue;
              const id = f.replace(/\.md$/, "");
              const raw = await fs.readFile(path.join(dir, f), "utf8");
              let frontmatter: unknown = {};
              let body = raw;
              if (raw.startsWith("---\n")) {
                const end = raw.indexOf("\n---\n", 4);
                if (end >= 0) {
                  frontmatter = yaml.load(raw.slice(4, end)) ?? {};
                  body = raw.slice(end + 5);
                }
              }
              out[type].push({ id, type, frontmatter, body });
            }
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(out));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

export default defineConfig({
  root: "web",
  server: {
    port: 7327,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@sim": path.resolve(__dirname, "../../src/sim"),
    },
  },
  plugins: [react(), cardsApiPlugin()],
});
