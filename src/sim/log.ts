/**
 * OT-compliant structured event logger — browser-safe core.
 *
 * NDJSON, append-only, wide flat rows with namespaced field keys.
 * `console.log` is banned inside `src/sim/`; everything goes through
 * Logger.emit so the schema stays consistent.
 *
 * This module has NO Node-only dependencies and is safe to import
 * from the browser. The Node-only `FileLogger` lives in `log-fs.ts`
 * so importing it from a browser bundle doesn't trip Vite's "module
 * externalized for browser compatibility" warning.
 *
 * Two implementations:
 *   - `MemoryLogger` (browser / tests)  — here.
 *   - `FileLogger`   (Node tools)       — see `log-fs.ts`.
 */

export const SCHEMA_VERSION = 1;

export interface LoggerBaseFields {
  /** Globally unique battle id. */
  battle_id: string;
  /** RNG seed for this battle. */
  seed: number;
  /** Git hash of the sim module (or "unversioned"). */
  service_version: string;
  /** Git hash of cards/ at battle start. */
  content_version: string;
}

export interface LoggerInit extends LoggerBaseFields {
  /** Wall-clock provider; injectable for tests. Default uses Date. */
  now?: () => string;
  /** Sim-tick reader; injectable. Default returns 0. */
  tick?: () => number;
}

export interface Logger {
  emit(eventKind: string, fields: Record<string, unknown>): void;
  flush(): Promise<void>;
  setTickReader(read: () => number): void;
}

function defaultNow(): string {
  return new Date().toISOString();
}

export abstract class BaseLogger implements Logger {
  protected base: LoggerBaseFields;
  protected now: () => string;
  protected tickRead: () => number;

  constructor(init: LoggerInit) {
    this.base = {
      battle_id: init.battle_id,
      seed: init.seed,
      service_version: init.service_version,
      content_version: init.content_version,
    };
    this.now = init.now ?? defaultNow;
    this.tickRead = init.tick ?? (() => 0);
  }

  setTickReader(read: () => number): void {
    this.tickRead = read;
  }

  emit(eventKind: string, fields: Record<string, unknown>): void {
    const row: Record<string, unknown> = {
      ts: this.now(),
      tick: this.tickRead(),
      schema_version: SCHEMA_VERSION,
      service_name: "rgyoons-sim",
      ...this.base,
      event_kind: eventKind,
      ...fields,
    };
    this.write(JSON.stringify(row) + "\n");
  }

  abstract write(line: string): void;
  abstract flush(): Promise<void>;
}

// ---------- Null (perf benches / discarded output) ----------

/** No-op logger: skips JSON.stringify entirely. Use for perf
 *  benchmarks or any callsite that throws away the events anyway. */
export class NullLogger implements Logger {
  emit(_eventKind: string, _fields: Record<string, unknown>): void {
    void _eventKind;
    void _fields;
  }
  async flush(): Promise<void> {}
  setTickReader(_read: () => number): void {
    void _read;
  }
}

// ---------- Memory (browser / tests) ----------

export class MemoryLogger extends BaseLogger {
  private rows: string[] = [];

  write(line: string): void {
    this.rows.push(line);
  }

  async flush(): Promise<void> {
    // No-op; rows are already in memory.
  }

  /** Returns and clears buffered rows. */
  drain(): string[] {
    const out = this.rows;
    this.rows = [];
    return out;
  }

  /** Returns a single NDJSON blob without clearing. */
  asBlob(): string {
    return this.rows.join("");
  }

  size(): number {
    return this.rows.length;
  }
}
