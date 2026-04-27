# Raging Yoons — Designer

In-browser admin tool for sketching the v0 unit grid + synergies. Cards are
YAML-fronted markdown stored in `cards/` at the repo root; every save
auto-commits and pushes (so git history *is* the design history).

## Run

```
cd tools/designer
npm install
npm run dev
```

- Web UI: <http://localhost:7322>
- API server: <http://localhost:7321>

(Ports 7321/7322 specifically to dodge the usual 5173-5175 Vite range.)

## Architecture

- `server.mjs` — Express server. Card CRUD + `/api/chat` SSE endpoint that
  spawns `claude -p` with the locked design docs and selected cards as
  context.
- `web/` — Vite + React + TS. Card grid, editor pane, chat pane.
- `cards/` (at repo root) — YAML-fronted markdown, one card per unit / env /
  curiosity / role / synergy. Saves auto-commit to git.
