import { describe, expect, it } from "vitest";
import { parseGithubUrl } from "../../src/remote-fetch.js";

describe("parseGithubUrl (audit issue #14)", () => {
  it("accepts plain owner/repo over https", () => {
    expect(parseGithubUrl("https://github.com/foo/bar")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("accepts owner/repo.git over https", () => {
    expect(parseGithubUrl("https://github.com/foo/bar.git")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("accepts repo names containing dots (was rejected pre-fix)", () => {
    // The pre-fix regex used `[^/.]+` for the repo capture, which silently
    // dropped legitimate names like `socket.io` or `node.js`. Real
    // marketplaces hosted at these URLs had their version checks skipped.
    expect(parseGithubUrl("https://github.com/socketio/socket.io")).toEqual({
      owner: "socketio",
      repo: "socket.io",
    });
    expect(parseGithubUrl("https://github.com/nodejs/node.js")).toEqual({
      owner: "nodejs",
      repo: "node.js",
    });
  });

  it("strips trailing .git from dotted names", () => {
    expect(parseGithubUrl("https://github.com/o/foo.bar.git")).toEqual({
      owner: "o",
      repo: "foo.bar",
    });
  });

  it("accepts ssh form with dotted names", () => {
    expect(parseGithubUrl("git@github.com:o/socket.io.git")).toEqual({
      owner: "o",
      repo: "socket.io",
    });
  });

  it("rejects URLs that produce an empty repo after .git strip", () => {
    // Degenerate input: github.com/owner/.git → after strip the repo is "",
    // which the validator rejects.
    expect(parseGithubUrl("https://github.com/owner/.git")).toBeUndefined();
  });

  it("rejects URLs with reserved repo names", () => {
    expect(parseGithubUrl("https://github.com/owner/.")).toBeUndefined();
    expect(parseGithubUrl("https://github.com/owner/..")).toBeUndefined();
  });

  it("rejects non-github hosts", () => {
    expect(parseGithubUrl("https://gitlab.com/foo/bar")).toBeUndefined();
    expect(parseGithubUrl("https://example.com/foo/bar.git")).toBeUndefined();
  });

  it("accepts http (in addition to https)", () => {
    expect(parseGithubUrl("http://github.com/foo/bar")).toEqual({ owner: "foo", repo: "bar" });
  });

  it("accepts trailing slash", () => {
    expect(parseGithubUrl("https://github.com/foo/bar/")).toEqual({ owner: "foo", repo: "bar" });
  });
});
