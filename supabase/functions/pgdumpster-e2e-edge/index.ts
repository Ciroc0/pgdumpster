Deno.serve(() =>
  Response.json({
    type: "pgdumpster-e2e-edge",
    schemaVersion: 1,
  }),
);
