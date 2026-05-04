import { describe, expect, it } from "vitest";
import { detectSessionBloat } from "../../../../src/drift/traps/session-bloat.js";
import type { RootRef, SessionLocalDir } from "../../../../src/types.js";

const nowMs = Date.now();
const OLD_MS = nowMs - 20 * 24 * 60 * 60 * 1000; // 20 days ago (older than default 14)
const RECENT_MS = nowMs - 3 * 24 * 60 * 60 * 1000; // 3 days ago (newer than default 14)

function makeDir(
  parentRoot: string,
  lastModified: number,
  approxSizeBytes: number,
): SessionLocalDir {
  return {
    kind: "session-local",
    pathOnDisk: `${parentRoot}/sessions/${lastModified}`,
    parentRoot,
    lastModified,
    approxSizeBytes,
  };
}

describe("detectSessionBloat", () => {
  it("returns empty when sessionLocals is empty", () => {
    expect(detectSessionBloat({ sessionLocals: [] })).toEqual([]);
  });

  it("returns empty when all dirs are recent (within threshold)", () => {
    const traps = detectSessionBloat({
      sessionLocals: [makeDir("/root1", RECENT_MS, 1024)],
    });
    expect(traps).toEqual([]);
  });

  it("emits one trap per root for old dirs", () => {
    const traps = detectSessionBloat({
      sessionLocals: [makeDir("/root1", OLD_MS, 1024), makeDir("/root2", OLD_MS, 2048)],
    });
    expect(traps).toHaveLength(2);
    expect(traps.every((t) => t.kind === "session-bloat-cleanup-eligible")).toBe(true);
  });

  it("aggregates multiple old dirs under the same root into one trap", () => {
    const traps = detectSessionBloat({
      sessionLocals: [
        makeDir("/root1", OLD_MS, 1024),
        makeDir("/root1", OLD_MS - 1000, 2048),
        makeDir("/root1", OLD_MS - 2000, 4096),
      ],
    });
    expect(traps).toHaveLength(1);
    expect(traps[0]?.bytesReclaimable).toBe(1024 + 2048 + 4096);
    expect(traps[0]?.dirsCount).toBe(3);
  });

  it("excludes recent dirs from aggregation", () => {
    const traps = detectSessionBloat({
      sessionLocals: [
        makeDir("/root1", OLD_MS, 1000),
        makeDir("/root1", RECENT_MS, 5000), // recent — excluded
        makeDir("/root1", OLD_MS - 1000, 2000),
      ],
    });
    expect(traps).toHaveLength(1);
    expect(traps[0]?.bytesReclaimable).toBe(3000);
    expect(traps[0]?.dirsCount).toBe(2);
  });

  it("uses parentRootRefMap when provided", () => {
    const rootRef: RootRef = { kind: "cowork", accountId: "acc1", orgId: "org1" };
    const traps = detectSessionBloat({
      sessionLocals: [makeDir("/root1", OLD_MS, 1024)],
      parentRootRefMap: new Map([["/root1", rootRef]]),
    });
    expect(traps[0]?.subject.ref).toEqual(rootRef);
  });

  it("uses fallback cowork RootRef when parentRootRefMap is missing", () => {
    const traps = detectSessionBloat({
      sessionLocals: [makeDir("/root1", OLD_MS, 1024)],
    });
    expect(traps[0]?.subject.ref).toEqual({ kind: "cowork", accountId: "", orgId: "" });
  });

  it("respects custom olderThanDays", () => {
    // 5-day-old dir; default threshold is 14 → not triggered; 3-day threshold → triggered
    const dir = makeDir("/root1", nowMs - 5 * 24 * 60 * 60 * 1000, 1024);

    const defaultTraps = detectSessionBloat({ sessionLocals: [dir] });
    expect(defaultTraps).toHaveLength(0);

    const customTraps = detectSessionBloat({ sessionLocals: [dir], olderThanDays: 3 });
    expect(customTraps).toHaveLength(1);
  });
});
