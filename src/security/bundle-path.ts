import path from "node:path";

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function assertSafeBundlePath(bundlePath: string): void {
  if (
    bundlePath.length === 0 ||
    bundlePath.includes("\\") ||
    bundlePath.includes("\0")
  ) {
    throw new Error(`Unsafe bundle path: ${JSON.stringify(bundlePath)}`);
  }
  if (path.posix.isAbsolute(bundlePath) || path.win32.isAbsolute(bundlePath)) {
    throw new Error(`Absolute bundle path is forbidden: ${bundlePath}`);
  }

  const segments = bundlePath.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED.test(segment)
    ) {
      throw new Error(`Unsafe bundle path segment: ${JSON.stringify(segment)}`);
    }
  }

  if (path.posix.normalize(bundlePath) !== bundlePath) {
    throw new Error(`Non-canonical bundle path: ${bundlePath}`);
  }
}

export function assertNoCaseFoldCollisions(paths: readonly string[]): void {
  const folded = new Map<string, string>();
  for (const bundlePath of paths) {
    const key = bundlePath.normalize("NFC").toLocaleLowerCase("en-US");
    const existing = folded.get(key);
    if (existing !== undefined && existing !== bundlePath) {
      throw new Error(
        `Case-folding path collision: ${existing} and ${bundlePath}`,
      );
    }
    folded.set(key, bundlePath);
  }
}
