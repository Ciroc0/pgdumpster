import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { z } from "zod";

import { extractApiKeyContractSubset } from "./api-key-contract-subset.mjs";
import { extractAuthContractSubset } from "./auth-contract-subset.mjs";
import { extractControlPlaneContractSubset } from "./control-plane-contract-subset.mjs";
import { extractEdgeContractSubset } from "./edge-contract-subset.mjs";
import { extractProjectContractSubset } from "./project-contract-subset.mjs";
import { extractPlatformV2ContractSubset } from "./platform-v2-contract-subset.mjs";

const baselineSchema = z
  .object({
    source: z.string().url().startsWith("https://"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive(),
  })
  .passthrough();

const baselines = [
  "contracts/supabase-management-api-2026-08-13.json",
  "contracts/supabase-management-v2-api-2026-08-14.json",
  "contracts/supabase-changelog-2026-08-13.json",
  "contracts/supabase-storage-api-2026-08-14.json",
];
/** @type {Map<string, Buffer>} */
const fetchedBodies = new Map();

for (const baselinePath of baselines) {
  const baseline = baselineSchema.parse(
    JSON.parse(await readFile(baselinePath, "utf8")),
  );
  const response = await globalThis.fetch(baseline.source, {
    headers: { accept: "application/json,text/markdown;q=0.9,*/*;q=0.1" },
    signal: globalThis.AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Official contract fetch failed for ${baseline.source}: HTTP ${response.status}`,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  fetchedBodies.set(baseline.source, body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (body.length !== baseline.bytes || sha256 !== baseline.sha256) {
    throw new Error(
      `Official contract drift detected for ${baseline.source}: expected ${baseline.bytes}/${baseline.sha256}, received ${body.length}/${sha256}`,
    );
  }
  process.stdout.write(`MATCH ${baseline.source} ${sha256}\n`);
}

const subsetSnapshotSchema = z.object({
  source: z.string().url(),
  sourceBytes: z.number().int().positive(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  operations: z.record(z.string(), z.unknown()),
  schemas: z.record(z.string(), z.unknown()),
  responseSchemas: z.record(z.string(), z.unknown()).optional(),
});

/**
 * @param {string} snapshotPath
 * @param {string} label
 * @param {(openapi: unknown) => { operations: Record<string, unknown>, schemas: Record<string, unknown> }} extract
 */
async function checkSubset(snapshotPath, label, extract) {
  const snapshot = subsetSnapshotSchema.parse(
    JSON.parse(await readFile(snapshotPath, "utf8")),
  );
  const sourceBody = fetchedBodies.get(snapshot.source);
  if (sourceBody === undefined) {
    throw new Error(
      `${label} snapshot source has no pinned baseline: ${snapshot.source}`,
    );
  }
  const sourceSha256 = createHash("sha256").update(sourceBody).digest("hex");
  if (
    sourceBody.length !== snapshot.sourceBytes ||
    sourceSha256 !== snapshot.sourceSha256
  ) {
    throw new Error(
      `${label} snapshot source metadata does not match the pinned Management OpenAPI`,
    );
  }
  const extracted = extract(JSON.parse(sourceBody.toString("utf8")));
  if (
    JSON.stringify(extracted.operations) !==
      JSON.stringify(snapshot.operations) ||
    JSON.stringify(extracted.schemas) !== JSON.stringify(snapshot.schemas) ||
    (snapshot.responseSchemas !== undefined &&
      JSON.stringify(extracted.responseSchemas) !==
        JSON.stringify(snapshot.responseSchemas))
  ) {
    throw new Error(
      `${label} contract subset is stale or was modified independently of Management OpenAPI`,
    );
  }
  process.stdout.write(`MATCH ${label} contract subset ${sourceSha256}\n`);
}

await checkSubset(
  "contracts/supabase-auth-contracts-2026-08-14.json",
  "Auth",
  extractAuthContractSubset,
);
await checkSubset(
  "contracts/supabase-platform-v2-contracts-2026-08-14.json",
  "Platform v2",
  extractPlatformV2ContractSubset,
);
await checkSubset(
  "contracts/supabase-project-contracts-2026-08-14.json",
  "Project",
  extractProjectContractSubset,
);
await checkSubset(
  "contracts/supabase-api-key-contracts-2026-08-14.json",
  "API key",
  extractApiKeyContractSubset,
);
await checkSubset(
  "contracts/supabase-edge-contracts-2026-08-14.json",
  "Edge",
  extractEdgeContractSubset,
);
await checkSubset(
  "contracts/supabase-control-plane-contracts-2026-08-14.json",
  "Control plane",
  extractControlPlaneContractSubset,
);
