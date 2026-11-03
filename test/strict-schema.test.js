"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine, MOCK, freshTmpDir, withMockEnv } = require("./helpers/env.js");
const { stripOptionalNulls, toStrictSchema } = require("../scripts/strict-schema.js");

const { resolveWorkerOpts } = engine._internal;

// A Claude Workflow-style schema: no additionalProperties, `note` optional,
// a nested object with its own optional field, and an array of objects.
const LOOSE = {
  type: "object",
  properties: {
    summary: { type: "string" },
    note: { type: "string" },
    level: { type: "string", enum: ["low", "high"] },
    detail: {
      type: "object",
      properties: { file: { type: "string" }, line: { type: "integer" } },
      required: ["file"]
    },
    items: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, tag: { type: "string" } }, required: ["id"] }
    }
  },
  required: ["summary", "detail", "items"]
};

test("toStrictSchema closes every object and lists every property as required", () => {
  const strict = toStrictSchema(LOOSE);
  assert.strictEqual(strict.additionalProperties, false);
  assert.deepStrictEqual(strict.required, ["summary", "note", "level", "detail", "items"]);
  assert.strictEqual(strict.properties.detail.additionalProperties, false);
  assert.deepStrictEqual(strict.properties.detail.required, ["file", "line"]);
  assert.strictEqual(strict.properties.items.items.additionalProperties, false);
  assert.deepStrictEqual(strict.properties.items.items.required, ["id", "tag"]);
});

test("toStrictSchema makes only originally-optional properties nullable", () => {
  const strict = toStrictSchema(LOOSE);
  assert.strictEqual(strict.properties.summary.type, "string");
  assert.deepStrictEqual(strict.properties.note.type, ["string", "null"]);
  assert.deepStrictEqual(strict.properties.level.enum, ["low", "high", null]);
  assert.deepStrictEqual(strict.properties.detail.properties.line.type, ["integer", "null"]);
  assert.deepStrictEqual(toStrictSchema({ type: "object", properties: { any: {} } }).properties.any, {
    anyOf: [{}, { type: "null" }]
  });
});

test("toStrictSchema is idempotent on an already-strict schema and leaves inputs untouched", () => {
  const before = JSON.stringify(LOOSE);
  toStrictSchema(LOOSE);
  assert.strictEqual(JSON.stringify(LOOSE), before);
  assert.deepStrictEqual(toStrictSchema(engine.WORKER_SCHEMA), engine.WORKER_SCHEMA);
  assert.deepStrictEqual(toStrictSchema(toStrictSchema(LOOSE)), toStrictSchema(LOOSE));
});

test("toStrictSchema preserves an explicit additionalProperties", () => {
  const strict = toStrictSchema({ type: "object", properties: {}, additionalProperties: { type: "string" } });
  assert.deepStrictEqual(strict.additionalProperties, { type: "string" });
});

test("stripOptionalNulls drops strict-mode nulls for optional properties only", () => {
  const value = {
    summary: "s",
    note: null,
    level: null,
    detail: { file: "a.js", line: null },
    items: [{ id: "1", tag: null }, { id: "2", tag: "x" }]
  };
  assert.deepStrictEqual(stripOptionalNulls(value, LOOSE), {
    summary: "s",
    detail: { file: "a.js" },
    items: [{ id: "1" }, { id: "2", tag: "x" }]
  });
  const nullable = { type: "object", properties: { maybe: { type: ["string", "null"] } } };
  assert.deepStrictEqual(stripOptionalNulls({ maybe: null }, nullable), { maybe: null }, "a declared null survives");
});

test("resolveWorkerOpts keeps the caller schema and derives the strict wire schema", () => {
  const resolved = resolveWorkerOpts({ schema: LOOSE });
  assert.strictEqual(resolved.schema, LOOSE);
  assert.deepStrictEqual(resolved.wireSchema, toStrictSchema(LOOSE));
  assert.strictEqual(resolveWorkerOpts({ schema: null }).wireSchema, null);
});

test("validateAgainstSchema accepts type unions", () => {
  const schema = { type: "object", properties: { v: { type: ["string", "null"] } } };
  assert.strictEqual(engine.validateAgainstSchema({ v: null }, schema).ok, true);
  assert.strictEqual(engine.validateAgainstSchema({ v: "x" }, schema).ok, true);
  assert.strictEqual(engine.validateAgainstSchema({ v: 1 }, schema).ok, false);
});

test("spawnWorker returns the original schema's shape from a strict-mode answer", async () => {
  const home = freshTmpDir("ultracode-strict-home-");
  const response = JSON.stringify({
    summary: "ok",
    note: null,
    level: "low",
    detail: { file: "a.js", line: null },
    items: []
  });
  const result = await withMockEnv({ MOCK_CODEX_RESPONSE: response }, () =>
    engine.spawnWorker("strict", { codex_bin: MOCK, codex_home: home, cwd: home, schema: LOOSE })
  );
  assert.strictEqual(result.status, "completed");
  assert.deepStrictEqual(result.value, { summary: "ok", level: "low", detail: { file: "a.js" }, items: [] });
});
