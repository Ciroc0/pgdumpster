import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { extractProjectContractSubset } from "./project-contract-subset.mjs";

const source = "https://api.supabase.com/api/v1-json";
const response = await globalThis.fetch(source, {
  signal: globalThis.AbortSignal.timeout(30_000),
});
if (!response.ok)
  throw new Error(`OpenAPI fetch failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const extracted = extractProjectContractSubset(
  JSON.parse(bytes.toString("utf8")),
);
const snapshot = {
  schemaVersion: 1,
  source,
  sourceBytes: bytes.length,
  sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  retrievedAt: new Date().toISOString(),
  ...extracted,
};
await writeFile(
  "contracts/supabase-project-contracts-2026-08-14.json",
  `${JSON.stringify(snapshot, null, 2)}\n`,
  { flag: "w", mode: 0o600 },
);
