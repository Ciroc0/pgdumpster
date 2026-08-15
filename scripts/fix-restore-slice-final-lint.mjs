import { readFile, rm, writeFile } from "node:fs/promises";

async function edit(pathname, transform) {
  const before = await readFile(pathname, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`${pathname}: expected lint fix was not applied`);
  await writeFile(pathname, after, "utf8");
}

await edit("src/core/restore/database-supplement-handlers.ts", (text) => {
  const pattern = /observed !== undefined &&\s*observed\.schemaHash === desired\.schemaHash &&\s*observed\.dataHash === desired\.dataHash/u;
  if (!pattern.test(text)) throw new Error("migration optional-chain target not found");
  return text.replace(
    pattern,
    "observed?.schemaHash === desired.schemaHash &&\n        observed?.dataHash === desired.dataHash",
  );
});

await edit("src/core/restore/file-storage-handlers.ts", (text) => {
  const pattern = /evidence === undefined \|\|\s*evidence\.sha256 !== entry\.sha256 \|\|\s*evidence\.bytes !== entry\.bytes/u;
  if (!pattern.test(text)) throw new Error("storage evidence optional-chain target not found");
  return text.replace(
    pattern,
    "evidence?.sha256 !== entry.sha256 ||\n              evidence?.bytes !== entry.bytes",
  );
});

await edit("tests/unit/edge-function-restore.test.ts", (text) => {
  const target = "      const url = String(input);";
  if (!text.includes(target)) throw new Error("Edge RequestInfo normalization target not found");
  return text.replace(
    target,
    `      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;`,
  );
});

await edit("tests/unit/file-storage-restore.test.ts", (text) => {
  let changed = text;
  const seenPattern = /const seen: \{ method\?: string; headers\?: HeadersInit \}\[\] = \[\];/u;
  if (!seenPattern.test(changed)) throw new Error("File Storage seen-header target not found");
  changed = changed.replace(
    seenPattern,
    "const seen: { method?: string; headers: Headers }[] = [];",
  );
  const pushPattern = /seen\.push\(\{ method: init\?\.method, headers: init\?\.headers \}\);/u;
  if (!pushPattern.test(changed)) throw new Error("File Storage header capture target not found");
  changed = changed.replace(
    pushPattern,
    "seen.push({ method: init?.method, headers: new Headers(init?.headers) });",
  );
  const headersPattern = /const headers = new Headers\(upload\?\.headers\);/u;
  if (!headersPattern.test(changed)) throw new Error("File Storage header assertion target not found");
  changed = changed.replace(
    headersPattern,
    "const headers = upload?.headers ?? new Headers();",
  );
  return changed;
});

await edit("tests/unit/restore-runtime-margin-hardening.test.ts", (text) => {
  const target = `function client(
  fixture: VectorFixture,
  overrides: Partial<VectorMutationClient> = {},`;
  if (!text.includes(target)) throw new Error("Vector runtime helper target not found");
  return text.replace(
    target,
    `function client(
  fixture: VectorFixture,
  overrides: Partial<VectorMutationClient> = {},`,
  ).replace(
    `): VectorMutationClient {
  return {`,
    `): VectorMutationClient {
  void fixture;
  return {`,
  );
});

await rm(new URL(import.meta.url));
