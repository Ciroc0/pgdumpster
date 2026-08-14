import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";

import { extractAuthContractSubset } from "./auth-contract-subset.mjs";

const source = "https://api.supabase.com/api/v1-json";
const response = await globalThis.fetch(source, {
  signal: globalThis.AbortSignal.timeout(30_000),
});
if (!response.ok)
  throw new Error(`OpenAPI fetch failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const { operations, schemas } = extractAuthContractSubset(
  JSON.parse(bytes.toString("utf8")),
);
const snapshot = {
  schemaVersion: 1,
  source,
  sourceBytes: bytes.length,
  sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  retrievedAt: new Date().toISOString(),
  operations,
  schemas,
};
await writeFile(
  "contracts/supabase-auth-contracts-2026-08-14.json",
  `${JSON.stringify(snapshot, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
