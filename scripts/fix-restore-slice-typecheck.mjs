import { readFile, rm, writeFile } from "node:fs/promises";

async function edit(pathname, transform) {
  const before = await readFile(pathname, "utf8");
  const after = transform(before);
  if (after === before) {
    throw new Error(`${pathname}: expected typecheck fix was not applied`);
  }
  await writeFile(pathname, after, "utf8");
}

function replaceOnce(text, search, replacement, label) {
  const first = text.indexOf(search);
  if (first < 0) throw new Error(`${label}: target not found`);
  if (text.indexOf(search, first + search.length) >= 0) {
    throw new Error(`${label}: target was not unique`);
  }
  return text.slice(0, first) + replacement + text.slice(first + search.length);
}

await edit("src/core/restore/database-supplement-handlers.ts", (text) =>
  replaceOnce(
    text,
    "  component: DatabaseSupplementRestoreComponent,\n  artifacts: readonly string[],\n): Promise<string[]> {",
    "  _component: DatabaseSupplementRestoreComponent,\n  artifacts: readonly string[],\n): Promise<string[]> {",
    "database sourceHashes unused component",
  ),
);

await edit("tests/unit/edge-function-restore.test.ts", (text) => {
  let changed = text;
  changed = replaceOnce(
    changed,
    "interface FunctionMetadata {\n  id: string;",
    "interface FunctionMetadata {\n  [key: string]: unknown;\n  id: string;",
    "Edge Function metadata passthrough index signature",
  );
  changed = replaceOnce(
    changed,
    "  ezbr_sha256?: string;",
    "  ezbr_sha256?: string | undefined;",
    "Edge Function explicit undefined override",
  );
  return changed;
});

await edit("tests/unit/file-storage-restore.test.ts", (text) =>
  replaceOnce(
    text,
    "const seen: { method?: string; headers: Headers }[] = [];",
    "const seen: { method: string | undefined; headers: Headers }[] = [];",
    "File Storage request capture exact optional type",
  ),
);

await edit("tests/unit/restore-runtime-margin-hardening.test.ts", (text) =>
  replaceOnce(
    text,
    "const requests: { method?: string; headers: Headers }[] = [];",
    "const requests: { method: string | undefined; headers: Headers }[] = [];",
    "Runtime margin request capture exact optional type",
  ),
);

await edit("tests/unit/vector-storage-restore.test.ts", (text) =>
  replaceOnce(
    text,
    "  createBucket(bucketName: string) {",
    '  createBucket(\n    bucketName: string,\n  ): ReturnType<VectorMutationClient["createBucket"]> {',
    "Vector fake createBucket return type",
  ),
);

await rm(new URL(import.meta.url));
