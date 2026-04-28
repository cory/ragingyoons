/**
 * Browser-safe public sim API.
 *
 *   import { setupBattle, tick, MemoryLogger } from '@sim/index.js'
 *
 * This module has no Node-only dependencies. Node tools that need
 * `loadContentFromFs`, `FileLogger`, or `buildLogFilePath` should
 * import them from the explicit Node-only entry points:
 *
 *   import { loadContentFromFs } from '@sim/load-fs.js';
 *   import { FileLogger, buildLogFilePath } from '@sim/log-fs.js';
 *
 * Keeping the Node bits out of `index.ts` keeps Vite from trying to
 * externalize `node:fs` / `node:child_process` in the viewer bundle.
 */

export {
  setupBattle,
  setupShapeBattle,
  summarize,
  logSetupEvents,
  findRacRowById,
  findBinRowById,
  TICK_RATE_HZ,
  SECONDS_PER_TICK,
  TARGET_KIND_NONE,
  TARGET_KIND_RAC,
  TARGET_KIND_BIN,
} from "./state.js";
export type { ShapeBattleConfig, ShapeBattleSide } from "./state.js";
export { tick, TICK_SUMMARY_EVERY } from "./tick.js";
export { resolveTimeout } from "./subsys/win.js";
export { SUDDEN_DEATH_TICK, DECAY_FRAC_PER_SEC } from "./subsys/decay.js";
export { MemoryLogger, SCHEMA_VERSION } from "./log.js";
export type { Logger, LoggerInit, LoggerBaseFields } from "./log.js";
export type {
  BattleConfig,
  BattleState,
  BinTable,
  RacTable,
  AtkTable,
  Owner,
  StatusInstance,
} from "./state.js";
export type {
  ContentBundle,
  CompDef,
  UnitDef,
  StatusDef,
  EnvDef,
  CuriosityDef,
  RoleDef,
  RoleId,
  EnvId,
  CuriosityId,
  SpawnCadence,
} from "./content.js";
