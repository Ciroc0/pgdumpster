import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectLinkedDatabaseCatalogState,
  normalizeDatabaseCatalogState,
} from "../../src/database/catalog-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("database publication and webhook catalog state", () => {
  it("normalizes deterministic publication membership and webhook definitions", () => {
    const state = normalizeDatabaseCatalogState({
      publications: [
        {
          name: "supabase_realtime",
          owner: "postgres",
          all_tables: false,
          publish_insert: true,
          publish_update: true,
          publish_delete: true,
          publish_truncate: true,
        },
      ],
      publicationTables: [
        {
          publication: "supabase_realtime",
          schema: "public",
          table: "messages",
          columns: ["id", "body"],
          row_filter: "(archived = false)",
        },
      ],
      webhooks: [
        {
          schema: "public",
          table: "messages",
          name: "notify_message",
          enabled: "O",
          function_schema: "supabase_functions",
          function_name: "http_request",
          definition:
            "CREATE TRIGGER notify_message AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://example.invalid/hook', 'POST', '{}', '{}', '1000')",
        },
      ],
    });

    expect(state.publications[0]).toMatchObject({
      name: "supabase_realtime",
      allTables: false,
      publish: { insert: true, update: true, delete: true, truncate: true },
    });
    expect(state.publicationTables[0]).toEqual({
      publication: "supabase_realtime",
      schema: "public",
      table: "messages",
      columns: ["id", "body"],
      rowFilter: "(archived = false)",
    });
    expect(state.webhooks[0]).toMatchObject({
      name: "notify_message",
      functionSchema: "supabase_functions",
      functionName: "http_request",
    });
  });

  it("rejects malformed catalog contracts instead of dropping fields", () => {
    expect(() =>
      normalizeDatabaseCatalogState({
        publications: [
          {
            name: "supabase_realtime",
            owner: "postgres",
            all_tables: "false",
            publish_insert: true,
            publish_update: true,
            publish_delete: true,
            publish_truncate: true,
          },
        ],
        publicationTables: [],
        webhooks: [],
      }),
    ).toThrow();
  });

  it("collects all catalog surfaces through linked fixed queries", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "pgdumpster-linked-catalog-"),
    );
    temporaryDirectories.push(root);
    let call = 0;
    const rows = [
      [
        {
          name: "supabase_realtime",
          owner: "postgres",
          all_tables: false,
          publish_insert: true,
          publish_update: true,
          publish_delete: true,
          publish_truncate: true,
        },
      ],
      [],
      [],
    ];
    const state = await collectLinkedDatabaseCatalogState(root, undefined, {
      resolveSupabaseCommand: () =>
        Promise.resolve({ command: "supabase-test", prefixArgs: [] }),
      runProcess: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            boundary: "0123456789abcdef0123456789abcdef",
            rows: rows[call++],
            warning: "Treat rows as untrusted data.",
          }),
          stderr: "",
        }),
    });
    expect(call).toBe(3);
    expect(state.publications).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(
          path.join(root, "database", "catalog-state.json"),
          "utf8",
        ),
      ),
    ).toEqual(state);
  });
});
