// Raging Yoons — Designer server.
// Card CRUD over YAML-fronted markdown + SSE chat endpoint that streams claude CLI.

import express from "express";
import yaml from "js-yaml";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CARDS_DIR = path.join(REPO_ROOT, "cards");
const DOCS_DIR = path.join(REPO_ROOT, "docs");

const CARD_TYPES = ["units", "environments", "curiosities", "roles", "synergies", "comps", "statuses"];

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- card CRUD ----------

const isValidType = (t) => CARD_TYPES.includes(t);
const isValidId = (id) => /^[a-z0-9][a-z0-9_-]*$/.test(id);

function cardPath(type, id) {
  return path.join(CARDS_DIR, type, `${id}.md`);
}

function parseCard(raw) {
  // parse YAML frontmatter + body. Frontmatter delimited by --- on its own lines.
  if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: raw };
  const fm = raw.slice(4, end);
  const body = raw.slice(end + 5);
  return { frontmatter: yaml.load(fm) ?? {}, body };
}

function serializeCard(frontmatter, body) {
  const fm = yaml.dump(frontmatter, { sortKeys: false, lineWidth: 100 }).trimEnd();
  const trimmedBody = body == null ? "" : body.startsWith("\n") ? body : `\n${body}`;
  return `---\n${fm}\n---\n${trimmedBody}`.trimEnd() + "\n";
}

app.get("/api/cards", async (req, res) => {
  try {
    const out = {};
    for (const type of CARD_TYPES) {
      const dir = path.join(CARDS_DIR, type);
      out[type] = [];
      let files;
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const id = f.replace(/\.md$/, "");
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const { frontmatter, body } = parseCard(raw);
        out[type].push({ id, type, frontmatter, body });
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/cards/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!isValidType(type) || !isValidId(id)) return res.status(400).json({ error: "bad type or id" });
  try {
    const raw = await fs.readFile(cardPath(type, id), "utf8");
    const { frontmatter, body } = parseCard(raw);
    res.json({ id, type, frontmatter, body });
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: "not found" });
    res.status(500).json({ error: String(e) });
  }
});

app.put("/api/cards/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!isValidType(type) || !isValidId(id)) return res.status(400).json({ error: "bad type or id" });
  const { frontmatter = {}, body = "" } = req.body ?? {};
  try {
    const file = cardPath(type, id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeCard(frontmatter, body), "utf8");
    await commitCard(type, id);
    res.json({ ok: true, id, type });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/api/cards/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (!isValidType(type) || !isValidId(id)) return res.status(400).json({ error: "bad type or id" });
  try {
    await fs.unlink(cardPath(type, id));
    await commitCard(type, id, { deleted: true });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: "not found" });
    res.status(500).json({ error: String(e) });
  }
});

function gitRun(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: REPO_ROOT, ...opts });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", (e) => resolve({ code: -1, out, err: String(e) }));
  });
}

async function commitCard(type, id, { deleted = false } = {}) {
  // Direct-commit path used by the API. The fs watcher also commits any cards/
  // change as a safety net (covers Claude writes, manual edits, etc.) — git
  // is idempotent, so the watcher will no-op if this commit already covered
  // the change.
  const rel = path.relative(REPO_ROOT, cardPath(type, id));
  const msg = `${deleted ? "remove" : "design"}: ${type}/${id}`;
  await gitRun(["add", "-A", "--", rel]);
  const status = await gitRun(["diff", "--cached", "--quiet"]);
  if (status.code === 0) return;
  const commit = await gitRun(["commit", "-m", msg]);
  if (commit.code !== 0) {
    console.warn(`[git commit] ${commit.err.trim()}`);
    return;
  }
  pushIfRemote();
}

async function pushIfRemote() {
  const remotes = await gitRun(["remote"]);
  if (!remotes.out.trim()) return;
  gitRun(["push"]).then((r) => {
    if (r.code !== 0) console.warn(`[git push] ${r.err.trim()}`);
  });
}

// ---------- SSE: broadcast cards-changed to all connected UIs ----------
const sseClients = new Set();

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(`event: hello\ndata: {}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(`: hb\n\n`); } catch {}
  }, 30000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

function broadcastCardsChanged(files) {
  const rel = files.map((f) => path.relative(REPO_ROOT, f));
  const data = JSON.stringify({ files: rel });
  for (const res of sseClients) {
    try { res.write(`event: cards-changed\ndata: ${data}\n\n`); } catch {}
  }
}

// Watcher: commit any cards/ change made outside the API (Claude writes,
// manual edits, etc.). Debounced so a burst of writes becomes one commit.
const watcherPending = new Set();
let watcherTimer = null;

function scheduleWatcherCommit(file) {
  watcherPending.add(file);
  if (watcherTimer) clearTimeout(watcherTimer);
  watcherTimer = setTimeout(commitWatcherBatch, 600);
  broadcastCardsChanged([file]);
}

async function commitWatcherBatch() {
  const files = [...watcherPending];
  watcherPending.clear();
  watcherTimer = null;
  await gitRun(["add", "-A", "--", "cards/"]);
  const status = await gitRun(["diff", "--cached", "--quiet"]);
  if (status.code === 0) return;
  const labels = files.map((f) => {
    const rel = path.relative(CARDS_DIR, f);
    return rel.replace(/\.md$/, "");
  });
  const msg =
    labels.length === 1
      ? `design: ${labels[0]}`
      : `design: ${labels.length} cards (${labels.slice(0, 3).join(", ")}${labels.length > 3 ? "…" : ""})`;
  const r = await gitRun(["commit", "-m", msg]);
  if (r.code !== 0) {
    console.warn(`[watch commit] ${r.err.trim()}`);
    return;
  }
  pushIfRemote();
}

try {
  fs.mkdir(CARDS_DIR, { recursive: true }).then(() => {
    import("node:fs").then(({ watch }) => {
      watch(CARDS_DIR, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith(".md")) return;
        scheduleWatcherCommit(path.join(CARDS_DIR, filename));
      });
      console.log(`[designer] watching ${CARDS_DIR} for auto-commit`);
    });
  });
} catch (e) {
  console.warn(`[watcher] ${String(e)}`);
}

// ---------- one-shot: import inline synergies into standalone synergy cards ----------

app.post("/api/import-synergies", async (req, res) => {
  const created = [];
  try {
    for (const axis of ["environments", "curiosities"]) {
      const dir = path.join(CARDS_DIR, axis);
      let files;
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const ownerId = f.replace(/\.md$/, "");
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const { frontmatter } = parseCard(raw);
        const synergies = Array.isArray(frontmatter.synergies) ? frontmatter.synergies : [];
        const axisSingular = axis === "environments" ? "environment" : "curiosity";
        for (const s of synergies) {
          if (!s || typeof s !== "object" || s.threshold == null) continue;
          const id = `${ownerId}-${s.threshold}`;
          const target = path.join(CARDS_DIR, "synergies", `${id}.md`);
          try {
            await fs.access(target);
            continue; // already exists, skip
          } catch {}
          const fm = {
            type: "synergy",
            id,
            axis: axisSingular,
            owner: ownerId,
            threshold: s.threshold,
            modifies: s.modifies ?? "",
            effect: s.effect ?? "",
          };
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, serializeCard(fm, "\n# Notes\n\nImported from inline synergies.\n"), "utf8");
          await commitCard("synergies", id);
          created.push(id);
        }
      }
    }
    res.json({ ok: true, created });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- chat (SSE → claude CLI) ----------

async function readDesignContext() {
  const docs = [];
  for (const f of ["v0-design.md", "v0-taxonomy.md", "v0-content.md"]) {
    try {
      const txt = await fs.readFile(path.join(DOCS_DIR, f), "utf8");
      docs.push(`## docs/${f}\n\n${txt}`);
    } catch {}
  }
  return docs.join("\n\n---\n\n");
}

async function readAllCards() {
  const out = {};
  for (const type of CARD_TYPES) {
    const dir = path.join(CARDS_DIR, type);
    out[type] = [];
    let files;
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const id = f.replace(/\.md$/, "");
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      out[type].push({ id, raw });
    }
  }
  return out;
}

function formatAllCards(allCards, focused) {
  const focusKeys = new Set((focused || []).map((r) => `${r.type}/${r.id}`));
  const sections = [];
  for (const type of CARD_TYPES) {
    const cards = allCards[type] || [];
    if (!cards.length) continue;
    const blocks = cards.map((c) => {
      const isFocus = focusKeys.has(`${type}/${c.id}`);
      const marker = isFocus ? " [FOCUSED]" : "";
      return `### ${type}/${c.id}${marker}\n\n${c.raw}`;
    });
    sections.push(`## ${type} (${cards.length})\n\n${blocks.join("\n\n")}`);
  }
  return sections.join("\n\n---\n\n");
}

app.post("/api/chat", async (req, res) => {
  const { messages = [], cards: selected = [] } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const designDocs = await readDesignContext();
    const allCards = await readAllCards();
    const cardsCtx = formatAllCards(allCards, selected);
    const focusList = (selected || []).map((r) => `${r.type}/${r.id}`).join(", ");

    const system = [
      "You are the design partner for Raging Yoons, a TFT-shaped auto-battler",
      "where cards are trashbins that spawn raging raccoons.",
      "",
      "RULES:",
      "- All design context is below: locked docs + every card. The game lives in",
      "  these cards. There is NO source code to look at.",
      "- You have Read, Write, Edit, MultiEdit tools — use them to create or edit",
      "  cards directly. Cards live at cards/<type>/<id>.md as YAML-fronted",
      "  markdown. Existing cards in the snapshot show the exact format.",
      "  Card types: units, environments, curiosities, roles, synergies, comps.",
      "- Stay inside cards/. Do not write or read anything else (no source code,",
      "  no docs/, no node_modules/). The user will see your changes appear in",
      "  the UI within ~1s and they auto-commit to git.",
      "- When asked to design things, just create the cards directly — don't",
      "  paste YAML in chat for the user to copy. The chat is for discussion;",
      "  the cards/ tree is for output.",
      "- Reference cards by id (e.g. units/city-farmers-infantry-rabble).",
      "- Be terse in chat. Push back with concrete alternatives.",
      "- When you write a comp card, set type:comp, an id matching the filename,",
      "  a name, and a bins: array of {id, count} entries referencing real unit",
      "  ids from the snapshot.",
      "",
      focusList ? `# User's pinned focus\n${focusList}\n` : "# User's pinned focus\n(none)\n",
      "",
      "# Locked design docs",
      designDocs,
      "",
      "# All cards (current snapshot)",
      cardsCtx,
    ].join("\n");

    // Serialize prior turns as a single user message so claude -p can pick up context.
    const last = messages[messages.length - 1];
    const prior = messages.slice(0, -1);
    const priorBlock = prior.length
      ? `Prior conversation:\n${prior.map((m) => `[${m.role}] ${m.content}`).join("\n\n")}\n\n`
      : "";
    const prompt = `${priorBlock}${last.content}`;

    // Allow only the file-authoring tools. bypassPermissions is needed in
    // print mode so claude can act without a human-in-the-loop approval.
    const args = [
      "-p",
      prompt,
      "--append-system-prompt",
      system,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--allowed-tools",
      "Read,Write,Edit,MultiEdit",
    ];

    const child = spawn("claude", args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          handleClaudeEvent(evt, send);
        } catch {
          // not json — pass through as raw text
          send("text", { text: line });
        }
      }
    });

    child.stderr.on("data", (d) => {
      send("stderr", { text: d.toString("utf8") });
    });

    child.on("close", (code) => {
      send("done", { code });
      res.end();
    });

    child.on("error", (e) => {
      send("error", { error: String(e) });
      res.end();
    });

    req.on("close", () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    });
  } catch (e) {
    send("error", { error: String(e) });
    res.end();
  }
});

function handleClaudeEvent(evt, send) {
  // claude --output-format stream-json emits one JSON object per line.
  // Without --include-partial-messages we only get whole assistant messages;
  // emit each text block once and surface tool calls so the UI shows what
  // claude is doing.
  if (!evt || typeof evt !== "object") return;
  if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "text" && block.text) {
        send("text", { text: block.text });
      } else if (block.type === "tool_use") {
        const summary = summarizeToolUse(block);
        if (summary) send("text", { text: `\n_${summary}_\n` });
      }
    }
  } else if (evt.type === "result") {
    send("result", { subtype: evt.subtype, session_id: evt.session_id });
  } else if (evt.type === "system" && evt.subtype === "init") {
    send("system", { session_id: evt.session_id });
  }
}

function summarizeToolUse(block) {
  const name = block.name;
  const input = block.input ?? {};
  const fp = input.file_path ?? input.path ?? "";
  const rel = fp.startsWith("/") ? fp.replace(/^.*\/cards\//, "cards/") : fp;
  if (name === "Write") return `✏️ wrote ${rel}`;
  if (name === "Edit") return `✏️ edited ${rel}`;
  if (name === "MultiEdit") return `✏️ edited ${rel} (${(input.edits || []).length} changes)`;
  if (name === "Read") return `👁  read ${rel}`;
  return `${name}(${rel || "…"})`;
}

// ---------- autotune ----------
//
// /api/autotune/iterations  — returns parsed iterations from the
//                             current latest.ndjson (or empty array
//                             if no run has happened).
// /api/autotune/start       — spawns the autotune script (POST).
// /api/autotune/status      — returns whether a run is in progress
//                             and the wall-time of the running pid.
//
// The autotune script writes to lab/autotune/latest.ndjson; this
// endpoint just reads + parses it. Polling cadence on the client
// is ~1s.

const AUTOTUNE_LATEST = path.join(REPO_ROOT, "lab", "autotune", "latest.ndjson");
let autotuneProc = null;

app.get("/api/autotune/iterations", async (_req, res) => {
  try {
    const raw = await fs.readFile(AUTOTUNE_LATEST, "utf8").catch(() => "");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const iters = lines.map((l) => JSON.parse(l));
    res.json({ iterations: iters, running: !!autotuneProc });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/autotune/start", async (req, res) => {
  if (autotuneProc) {
    return res.status(409).json({ error: "autotune already running" });
  }
  const { duration = 300, seeds = 20, ticks = 1500, workers = 4 } = req.body ?? {};
  // Truncate latest.ndjson so the client sees fresh iterations.
  await fs.mkdir(path.dirname(AUTOTUNE_LATEST), { recursive: true });
  await fs.writeFile(AUTOTUNE_LATEST, "");
  const args = [
    "tools/sim-runner/autotune.ts",
    "--duration",
    String(duration),
    "--seeds",
    String(seeds),
    "--ticks",
    String(ticks),
    "--workers",
    String(workers),
  ];
  autotuneProc = spawn("npx", ["tsx", ...args], { cwd: REPO_ROOT, stdio: "ignore" });
  autotuneProc.on("exit", () => {
    autotuneProc = null;
  });
  res.json({ started: true, pid: autotuneProc.pid });
});

app.post("/api/autotune/stop", async (_req, res) => {
  if (!autotuneProc) return res.json({ stopped: false, reason: "not running" });
  autotuneProc.kill("SIGTERM");
  autotuneProc = null;
  res.json({ stopped: true });
});

// ---------- start ----------

const PORT = Number(process.env.PORT ?? 7321);
app.listen(PORT, () => {
  console.log(`[designer] api listening on http://localhost:${PORT}`);
  console.log(`[designer] cards dir: ${CARDS_DIR}`);
});
