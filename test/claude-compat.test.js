"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const {
  engine,
  MOCK,
  freshCounterPath,
  freshSessionDir,
  freshTmpDir,
  readInvocations,
  withMockEnv
} = require("./helpers/env.js");
const { runScript } = require("../scripts/ultracode-script-runner.js");

function baseOpts(extra = {}) {
  const home = freshTmpDir("ultracode-compat-home-");
  return { codex_bin: MOCK, codex_home: home, cwd: home, ...extra };
}

function compat(source, extra = {}) {
  return runScript({ source, claude_compat: true, ...baseOpts(), ...extra });
}

// ---------------------------------------------------------------------------
// Resume: only the unchanged prefix of agent() calls is replayed.
// ---------------------------------------------------------------------------

async function runThenResume(firstSource, secondSource) {
  const opts = baseOpts();
  const first = await runScript({ source: firstSource, ...opts });
  assert.strictEqual(first.status, "completed");
  const second = await runScript({ source: secondSource, resume_from_run_id: first.id, ...opts });
  assert.strictEqual(second.status, "completed");
  return second.workers.map((worker) => Boolean(worker.cached));
}

test("resume: an unchanged script replays every call from the journal", async () => {
  const source = "await agent('a', { schema: null }); await agent('b', { schema: null }); return 1;";
  assert.deepStrictEqual(await runThenResume(source, source), [true, true]);
});

test("resume: an edited call and every later call run live, even identical ones", async () => {
  const cached = await runThenResume(
    "await agent('a', { schema: null }); await agent('b', { schema: null }); await agent('c', { schema: null }); return 1;",
    "await agent('a', { schema: null }); await agent('B!', { schema: null }); await agent('c', { schema: null }); return 1;"
  );
  assert.deepStrictEqual(cached, [true, false, false], "'c' is identical but follows the edit, so it is live");
});

test("resume: an edited first call makes the whole run live", async () => {
  const cached = await runThenResume(
    "await agent('a', { schema: null }); await agent('b', { schema: null }); return 1;",
    "await agent('A!', { schema: null }); await agent('b', { schema: null }); return 1;"
  );
  assert.deepStrictEqual(cached, [false, false]);
});

test("resume: N identical calls replay N distinct journaled results", async () => {
  const counter = freshCounterPath();
  const opts = baseOpts();
  const source =
    "const votes = await parallel([0, 1].map(() => () => agent('same', { schema: null }))); return votes;";
  const first = await withMockEnv(
    { MOCK_CODEX_COUNTER: counter, MOCK_CODEX_RESPONSE: "even", MOCK_CODEX_ALT_RESPONSE: "odd" },
    () => runScript({ source, concurrency: 1, ...opts })
  );
  assert.deepStrictEqual([...first.result].sort(), ["even", "odd"]);
  const second = await runScript({ source, resume_from_run_id: first.id, ...opts });
  assert.ok(second.workers.every((worker) => worker.cached));
  assert.deepStrictEqual([...second.result].sort(), ["even", "odd"], "each call got its own prior result");
});

// ---------------------------------------------------------------------------
// Sandboxed, deterministic execution in claude_compat.
// ---------------------------------------------------------------------------

test("claude_compat runs without Node host globals; native scripts keep them", async () => {
  const source = "return [typeof setTimeout, typeof Buffer, typeof require, typeof JSON];";
  const sandboxed = await compat(source);
  assert.strictEqual(sandboxed.status, "completed");
  assert.deepStrictEqual(sandboxed.result, ["undefined", "undefined", "undefined", "object"]);
  const native = await runScript({ source, ...baseOpts() });
  assert.deepStrictEqual(native.result, ["function", "function", "undefined", "object"], "require is module-scoped, never global");
});

for (const [expr, label] of [
  ["Date.now()", "Date.now()"],
  ["new Date()", "new Date()"],
  ["Date()", "Date()"],
  ["Math.random()", "Math.random()"]
]) {
  test(`claude_compat: ${label} throws so resume stays deterministic`, async () => {
    const rec = await compat(`return ${expr};`);
    assert.strictEqual(rec.status, "failed");
    assert.match(rec.error, new RegExp(`${label.replace(/[().]/g, "\\$&")} is not available`));
  });
}

test("claude_compat: deterministic Date APIs keep working", async () => {
  const rec = await compat(
    "const d = new Date(0); return [d.toISOString(), d instanceof Date, Date.parse('1970-01-02T00:00:00Z'), Date.UTC(1970, 0, 1)];"
  );
  assert.strictEqual(rec.status, "completed");
  assert.deepStrictEqual(rec.result, ["1970-01-01T00:00:00.000Z", true, 86_400_000, 0]);
});

test("claude_compat: a script error from the sandbox realm keeps its message", async () => {
  const rec = await compat("throw new Error('boom from sandbox');");
  assert.strictEqual(rec.status, "failed");
  assert.strictEqual(rec.error, "boom from sandbox");
});

// ---------------------------------------------------------------------------
// Claude-only agent() options.
// ---------------------------------------------------------------------------

test("claude_compat: Claude models and agentType are reported and the Codex config is used", async () => {
  const sessionDir = freshSessionDir();
  const rec = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, () =>
    compat(
      "await agent('a', { model: 'haiku', agentType: 'code-reviewer' });" +
        "await agent('b', { model: 'claude-sonnet-5-5' });" +
        "await agent('c', { model: 'gpt-5.6-luna' });" +
        "return true;"
    )
  );
  assert.strictEqual(rec.status, "completed");
  assert.deepStrictEqual(rec.warnings, [
    'agentType "code-reviewer" has no Codex equivalent; it ran as a default Codex worker.',
    'model "haiku" is a Claude model; it ran on the model from the Codex config instead.',
    'model "claude-sonnet-5-5" is a Claude model; it ran on the model from the Codex config instead.'
  ]);
  const argvs = readInvocations(sessionDir).map(({ argv }) => argv);
  assert.strictEqual(argvs.filter((argv) => argv.includes("-m")).length, 1, "only the Codex model is passed");
  assert.ok(argvs.some((argv) => argv.includes("gpt-5.6-luna")));
});

test("claude_compat: budget meters output tokens and agent() throws once it is spent", async () => {
  const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 };
  const rec = await withMockEnv({ MOCK_CODEX_USAGE: JSON.stringify(usage) }, () =>
    compat(
      "await agent('first');" +
        "const spentAfterFirst = budget.spent();" +
        "try { await agent('second'); return { threw: false }; }" +
        "catch (error) { return { threw: true, message: error.message, spentAfterFirst }; }",
      { budget_tokens: 5 }
    )
  );
  assert.strictEqual(rec.result.threw, true);
  assert.strictEqual(rec.result.spentAfterFirst, 7, "input tokens do not count");
  assert.match(rec.result.message, /token budget exhausted \(7 \/ 5 output tokens\)/);
});

test("native scripts keep the total-token budget and a null agent() on exhaustion", async () => {
  const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 };
  const rec = await withMockEnv({ MOCK_CODEX_USAGE: JSON.stringify(usage) }, () =>
    runScript({
      source: "await agent('first'); const v = await agent('second'); return { v, spent: budget.spent() };",
      budget_tokens: 5,
      ...baseOpts()
    })
  );
  assert.strictEqual(rec.result.v, null);
  assert.ok(rec.result.spent >= 1000, "native budget counts all tokens");
});

test("claude_compat: an inline nested workflow() inherits Claude semantics", async () => {
  const rec = await withMockEnv({ MOCK_CODEX_RESPONSE: "child text" }, () =>
    compat("const child = await workflow(`\nreturn typeof (await agent('x'));\n`); return child.result;")
  );
  assert.strictEqual(rec.status, "completed");
  assert.strictEqual(rec.result, "string");
});

// ---------------------------------------------------------------------------
// Run state follows an explicit codex_home.
// ---------------------------------------------------------------------------

test("an explicit codex_home holds the run state, and status/resume read it back", async () => {
  const opts = baseOpts();
  const rec = await runScript({ source: "await agent('a', { schema: null }); return 1;", ...opts });
  assert.strictEqual(path.dirname(rec.state_path), path.join(opts.codex_home, "ultracode", "runs"));
  assert.ok(rec.script_path.startsWith(path.join(opts.codex_home, "ultracode", "scripts")));
  const read = await engine.readWorkflow({ workflow_id: rec.id, codex_home: opts.codex_home });
  assert.strictEqual(read.id, rec.id);
  const missing = await engine.readWorkflow({ workflow_id: rec.id }).catch((error) => error);
  assert.ok(missing instanceof Error, "the default home does not have this run");
  const resumed = await runScript({
    source: "await agent('a', { schema: null }); return 1;",
    resume_from_run_id: rec.id,
    ...opts
  });
  assert.strictEqual(resumed.workers[0].cached, true);
});
