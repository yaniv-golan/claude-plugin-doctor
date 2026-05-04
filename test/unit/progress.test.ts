import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Progress } from "../../src/progress.js";

class StringSink extends Writable {
  chunks: string[] = [];
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (e?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

describe("Progress", () => {
  it("emits phase_start and phase_end NDJSON events to the sink", () => {
    const sink = new StringSink();
    const p = new Progress({ enabled: false, isTty: false, ndjsonStream: sink });
    p.start("init");
    p.end("init", 7);
    const lines = sink
      .text()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "phase_start", phase: "init" });
    expect(lines[1]).toMatchObject({ type: "phase_end", phase: "init", durationMs: 7 });
  });

  it("emits phase_progress with counts and item label", () => {
    const sink = new StringSink();
    const p = new Progress({ enabled: false, isTty: false, ndjsonStream: sink });
    p.update("check_marketplaces", 3, 12, "acme");
    const ev = JSON.parse(sink.text().trim());
    expect(ev).toMatchObject({
      type: "phase_progress",
      phase: "check_marketplaces",
      current: 3,
      total: 12,
      item: "acme",
    });
  });

  it("emits scan_done with exit code", () => {
    const sink = new StringSink();
    const p = new Progress({ enabled: false, isTty: false, ndjsonStream: sink });
    p.emitDone(123, 2);
    const ev = JSON.parse(sink.text().trim());
    expect(ev).toMatchObject({ type: "scan_done", durationMs: 123, exitCode: 2 });
  });

  it("is silent when enabled is false and no sink is provided", () => {
    const p = new Progress({ enabled: false, isTty: false });
    expect(() => {
      p.start("init");
      p.update("init", 1, 2);
      p.end("init", 1);
    }).not.toThrow();
  });
});
