import { describe, expect, it } from "vitest";

import {
  assertNoCaseFoldCollisions,
  assertSafeBundlePath,
} from "../../src/security/bundle-path.js";

describe("bundle path safety", () => {
  it.each([
    "../escape",
    "/absolute",
    "C:/windows/path",
    "folder\\file",
    "folder//file",
    "folder/./file",
    "folder/../file",
    "CON",
    "folder/NUL.txt",
    "trailing.",
    "trailing ",
  ])("rejects %s", (candidate) => {
    expect(() => {
      assertSafeBundlePath(candidate);
    }).toThrow();
  });

  it("accepts an opaque nested payload path", () => {
    expect(() => {
      assertSafeBundlePath("storage/files/sha256/aa/digest");
    }).not.toThrow();
  });

  it("rejects case-fold collisions", () => {
    expect(() => {
      assertNoCaseFoldCollisions(["payload/A", "payload/a"]);
    }).toThrow(/collision/u);
  });
});
