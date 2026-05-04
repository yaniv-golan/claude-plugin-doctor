import * as fs from "node:fs";
import * as path from "node:path";
import { newRunId, nowIso } from "./refs.js";
import type { LogLevel } from "./types.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export type LoggerOpts = {
  filePath?: string;
  consoleLevel?: LogLevel;
  fileLevel?: LogLevel;
  runId?: string;
  /** Optional human-prose sink invoked for every log entry. The writer
   *  decides whether/how to render the event. Used by `--verbose` to render
   *  one-line per-event prose to stderr, instead of the (universally
   *  awkward) "NDJSON-under-`-v`" pattern. The logger itself stays a pure
   *  NDJSON sink — humanization is the writer's responsibility. */
  humanWriter?: (msg: string, fields: Record<string, unknown>, level: LogLevel) => void;
};

export class Logger {
  private fd: number | undefined;
  private readonly runId: string;
  private readonly filePath?: string;
  private readonly fileLevel: LogLevel;
  private readonly consoleLevel?: LogLevel;
  private readonly humanWriter?: (
    msg: string,
    fields: Record<string, unknown>,
    level: LogLevel,
  ) => void;

  constructor(opts: LoggerOpts) {
    this.runId = opts.runId ?? newRunId();
    this.fileLevel = opts.fileLevel ?? "trace";
    if (opts.consoleLevel) this.consoleLevel = opts.consoleLevel;
    if (opts.humanWriter) this.humanWriter = opts.humanWriter;
    if (opts.filePath) {
      this.filePath = opts.filePath;
      fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
      this.fd = fs.openSync(opts.filePath, "a");
    }
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const entry = {
      ts: nowIso(),
      level,
      msg,
      runId: this.runId,
      ...fields,
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (this.fd !== undefined && LEVEL_ORDER[level] >= LEVEL_ORDER[this.fileLevel]) {
      try {
        fs.writeSync(this.fd, line);
      } catch {
        // logger never throws
      }
    }
    if (this.consoleLevel && LEVEL_ORDER[level] >= LEVEL_ORDER[this.consoleLevel]) {
      try {
        fs.writeSync(2, line);
      } catch {
        // ignore
      }
    }
    if (this.humanWriter) {
      try {
        this.humanWriter(msg, fields, level);
      } catch {
        // never throw from logger
      }
    }
  }

  trace(msg: string, fields?: Record<string, unknown>): void {
    this.log("trace", msg, fields);
  }
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log("error", msg, fields);
  }

  getRunId(): string {
    return this.runId;
  }
  getFilePath(): string | undefined {
    return this.filePath;
  }

  close(): void {
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = undefined;
    }
  }
}

export function defaultLogPath(home: string): string {
  const ts = nowIso().replace(/[:.]/g, "-");
  return path.join(home, ".claude-plugin-doctor", "logs", `cpd-${ts}.log`);
}
