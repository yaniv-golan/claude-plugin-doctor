import type { CpdErrorCode, ErrorEnvelope } from "./types.js";

export class CpdError extends Error {
  readonly code: CpdErrorCode;
  readonly hint?: string;

  constructor(code: CpdErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "CpdError";
    this.code = code;
    if (hint) this.hint = hint;
  }

  toEnvelope(extra?: { runId?: string; logFile?: string }): ErrorEnvelope {
    const env: ErrorEnvelope = {
      ok: false,
      code: this.code,
      message: this.message,
    };
    if (this.hint) env.hint = this.hint;
    if (extra?.runId) env.runId = extra.runId;
    if (extra?.logFile) env.logFile = extra.logFile;
    return env;
  }
}
