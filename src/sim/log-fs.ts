/**
 * Node-only sink for the sim logger. `FileLogger` writes NDJSON to
 * disk in append-only chunks. `buildLogFilePath` is a date-stamped
 * path helper for `logs/battles/{date}/`.
 *
 * Browser code must NOT import from this file — `node:fs` etc. are
 * not available in a Vite bundle. Use `MemoryLogger` from `./log.ts`
 * instead.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

import { BaseLogger, type LoggerInit } from "./log.js";

export interface FileLoggerOpts extends LoggerInit {
  /** Output file path. Parent dir is created if missing. */
  filePath: string;
  /** Bytes; flush whenever buffered output exceeds this. Default 64 KiB. */
  flushBytes?: number;
}

export class FileLogger extends BaseLogger {
  private filePath: string;
  private buf: string[] = [];
  private bufBytes = 0;
  private flushBytes: number;
  private writePromise: Promise<void> = Promise.resolve();
  private opened = false;

  constructor(opts: FileLoggerOpts) {
    super(opts);
    this.filePath = opts.filePath;
    this.flushBytes = opts.flushBytes ?? 64 * 1024;
  }

  write(line: string): void {
    this.buf.push(line);
    this.bufBytes += Buffer.byteLength(line, "utf8");
    if (this.bufBytes >= this.flushBytes) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.opened) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      this.opened = true;
    }
    if (this.buf.length === 0) return this.writePromise;
    const chunk = this.buf.join("");
    this.buf = [];
    this.bufBytes = 0;
    this.writePromise = this.writePromise.then(() => fs.appendFile(this.filePath, chunk, "utf8"));
    return this.writePromise;
  }
}

export function buildLogFilePath(rootDir: string, battleId: string, seed: number): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const ts = d.toISOString().replace(/[:.]/g, "-");
  return path.join(rootDir, "logs", "battles", `${yyyy}-${mm}-${dd}`, `battle-${ts}-${seed}-${battleId.slice(0, 8)}.ndjson`);
}
