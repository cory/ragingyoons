/**
 * Tactic A/B harness — same comp, two tactic profiles, mirror battles
 * across many seeds. Reports which profile wins more.
 *
 * Usage:
 *   tsx tools/sim-runner/tactic-ab.ts \
 *     --comp test-park-snipe \
 *     --role archer \
 *     --field archerKiteFraction \
 *     --baseline 0.7 --variant 0.5 \
 *     --seeds 50 --ticks 1000
 *
 * What it does: runs N battles where side A uses BASELINE on the
 * given role/field, side B uses VARIANT on that same role/field.
 * The rest of A and B are identical. The result is a clean winrate
 * comparison: if VARIANT wins materially more, that's a tactic
 * improvement. If they're 50/50, the field doesn't matter at this
 * value. If VARIANT wins materially less, the change is a
 * regression.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MemoryLogger,
  logSetupEvents,
  resolveTimeout,
  setupBattle,
  tick,
  type BattleConfig,
  type ContentBundle,
} from "../../src/sim/index.js";
import { loadContentFromFs } from "../../src/sim/load-fs.js";
import type { RoleId } from "../../src/sim/content.js";
import type { TacticOverrideMap, TacticProfile } from "../../src/sim/tactics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface Args {
  comp: string;
  role: RoleId;
  field: keyof TacticProfile;
  baseline: number;
  variant: number;
  seeds: number;
  ticks: number;
  startSeed: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    comp: "test-city-swarm",
    role: "archer",
    field: "archerKiteFraction",
    baseline: 0.7,
    variant: 0.5,
    seeds: 30,
    ticks: 1000,
    startSeed: 0xc0ffee,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--comp") (out.comp = String(v)), i++;
    else if (a === "--role") (out.role = v as RoleId), i++;
    else if (a === "--field") (out.field = v as keyof TacticProfile), i++;
    else if (a === "--baseline") (out.baseline = Number(v)), i++;
    else if (a === "--variant") (out.variant = Number(v)), i++;
    else if (a === "--seeds") (out.seeds = Number(v)), i++;
    else if (a === "--ticks") (out.ticks = Number(v)), i++;
    else if (a === "--seed") (out.startSeed = Number(v)), i++;
  }
  return out;
}

function gitHash(scope: string): string {
  try {
    return execSync(`git -C "${REPO_ROOT}" rev-parse HEAD:"${scope}"`, {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString("utf8")
      .trim();
  } catch {
    return "unversioned";
  }
}

function uuidv4(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  a[6] = (a[6] & 0x0f) | 0x40;
  a[8] = (a[8] & 0x3f) | 0x80;
  const h = [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface Outcome {
  seed: number;
  winner: -1 | 0 | 1;
  finalTick: number;
}

async function runOne(
  content: ContentBundle,
  comp: string,
  seed: number,
  ticks: number,
  tacticsA: TacticOverrideMap,
  tacticsB: TacticOverrideMap,
): Promise<Outcome> {
  const battleId = uuidv4();
  const cfg: BattleConfig = {
    seed,
    battleId,
    compA: comp,
    compB: comp,
    bounds: { w: 100, h: 100 },
    verbosity: "events",
    tacticsA,
    tacticsB,
  };
  const log = new MemoryLogger({
    battle_id: battleId,
    seed,
    service_version: gitHash("src/sim"),
    content_version: content.version,
  });
  const state = setupBattle(content, cfg);
  log.setTickReader(() => state.tick);
  log.emit("battle_start", { comp_a: comp, comp_b: comp, bounds_w: 100, bounds_h: 100 });
  logSetupEvents(state, log);
  for (let i = 0; i < ticks; i++) {
    tick(state, content, log);
    if (state.winner !== -1 || state.endReason !== null) break;
  }
  if (state.winner === -1 && state.endReason === null) resolveTimeout(state);
  return { seed, winner: state.winner, finalTick: state.tick };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const content = await loadContentFromFs({ repoRoot: REPO_ROOT });
  if (!content.comps.has(args.comp)) {
    throw new Error(`unknown comp "${args.comp}"`);
  }

  process.stdout.write(
    `[ab] comp=${args.comp} role=${args.role} field=${String(args.field)} ` +
      `baseline=${args.baseline} variant=${args.variant} seeds=${args.seeds} ticks=${args.ticks}\n`,
  );

  const baselineOverrides: TacticOverrideMap = {
    [args.role]: { [args.field]: args.baseline as never },
  };
  const variantOverrides: TacticOverrideMap = {
    [args.role]: { [args.field]: args.variant as never },
  };

  const outcomes: Outcome[] = [];
  const t0 = Date.now();
  for (let i = 0; i < args.seeds; i++) {
    const seed = args.startSeed + i;
    // Side A = baseline, Side B = variant. Winner=0 means baseline won.
    const o = await runOne(content, args.comp, seed, args.ticks, baselineOverrides, variantOverrides);
    outcomes.push(o);
  }
  const elapsedMs = Date.now() - t0;

  let baselineWins = 0;
  let variantWins = 0;
  let draws = 0;
  for (const o of outcomes) {
    if (o.winner === 0) baselineWins++;
    else if (o.winner === 1) variantWins++;
    else draws++;
  }

  const decisive = baselineWins + variantWins;
  const variantRate = decisive > 0 ? variantWins / decisive : 0;
  const verdict =
    decisive < 6
      ? "INCONCLUSIVE (need ≥ 6 decisive outcomes)"
      : Math.abs(variantRate - 0.5) <= 0.15
        ? "TIE — field doesn't matter at these values"
        : variantRate > 0.65
          ? "VARIANT WINS"
          : variantRate < 0.35
            ? "BASELINE WINS"
            : "leaning";

  process.stdout.write(`[ab] ${args.seeds} battles in ${(elapsedMs / 1000).toFixed(2)}s\n`);
  process.stdout.write(
    `[ab] baseline ${baselineWins}, variant ${variantWins}, draws ${draws} → variant winrate ${(variantRate * 100).toFixed(1)}%\n`,
  );
  process.stdout.write(`[ab] verdict: ${verdict}\n`);

  // Now reverse the sides (B = baseline, A = variant) to control for
  // mirror-match side bias (we know park-snipe mirror is biased ~69%
  // toward A). If the verdict flips when sides swap, the result is a
  // side-bias artifact rather than a real tactic effect.
  process.stdout.write(`\n[ab] reversed (A=variant, B=baseline) to control for side bias…\n`);
  const reversed: Outcome[] = [];
  for (let i = 0; i < args.seeds; i++) {
    const seed = args.startSeed + i;
    const o = await runOne(content, args.comp, seed, args.ticks, variantOverrides, baselineOverrides);
    reversed.push(o);
  }
  let revVariantWins = 0;
  let revBaselineWins = 0;
  for (const o of reversed) {
    if (o.winner === 0) revVariantWins++;
    else if (o.winner === 1) revBaselineWins++;
  }
  const revDecisive = revVariantWins + revBaselineWins;
  const revVariantRate = revDecisive > 0 ? revVariantWins / revDecisive : 0;
  process.stdout.write(
    `[ab] reversed: variant ${revVariantWins}, baseline ${revBaselineWins} → variant winrate ${(revVariantRate * 100).toFixed(1)}%\n`,
  );

  // True effect ≈ average of forward + reversed variant rates
  const trueRate =
    decisive > 0 && revDecisive > 0
      ? (variantRate + revVariantRate) / 2
      : -1;
  if (trueRate >= 0) {
    process.stdout.write(`[ab] side-bias-corrected variant winrate: ${(trueRate * 100).toFixed(1)}%\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`[ab] failed: ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
