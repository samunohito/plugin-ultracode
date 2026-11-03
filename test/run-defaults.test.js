"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { engine, MOCK, freshSessionDir, freshTmpDir, readInvocations, withMockEnv } = require("./helpers/env.js");
const { runScript } = require("../scripts/ultracode-script-runner.js");

function baseOpts(extra = {}) {
  const home = freshTmpDir("ultracode-defaults-home-");
  return { codex_bin: MOCK, codex_home: home, cwd: home, ...extra };
}

async function scriptInvocations(source, extra = {}) {
  const sessionDir = freshSessionDir();
  const rec = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, () =>
    runScript({ source, ...baseOpts(), ...extra })
  );
  assert.strictEqual(rec.status, "completed", rec.error);
  return { rec, calls: readInvocations(sessionDir) };
}

test("run-level model and reasoning effort become every script worker's default", async () => {
  const { calls } = await scriptInvocations(
    "await agent('plain', { schema: null });" +
      "await agent('own effort', { schema: null, reasoning_effort: 'high' });" +
      "await agent('claude effort', { schema: null, effort: 'low' });" +
      "await agent('own model', { schema: null, model: 'gpt-other' });" +
      "await fanout([{ prompt: 'fanout spec', schema: null }]);" +
      "await loopUntilDry(() => 'loop round', { maxRounds: 1 });" +
      "return true;",
    { model: "gpt-run", reasoning_effort: "minimal" }
  );
  const seen = calls.map(({ argv }) => {
    const modelAt = argv.indexOf("-m");
    const effortArg = argv.find((arg) => String(arg).startsWith("model_reasoning_effort="));
    return [modelAt >= 0 ? argv[modelAt + 1] : null, effortArg ? JSON.parse(effortArg.split("=")[1]) : null];
  });
  assert.strictEqual(seen.length, 6);
  assert.deepStrictEqual(seen.slice(0, 4), [
    ["gpt-run", "minimal"],
    ["gpt-run", "high"],
    ["gpt-run", "low"],
    ["gpt-other", "minimal"]
  ]);
  assert.deepStrictEqual(seen[4], ["gpt-run", "minimal"], "fanout's unset model/effort keep the run default");
  assert.deepStrictEqual(seen[5], ["gpt-run", "minimal"], "loopUntilDry uses the run default");
});

test("without run-level or per-call values no override reaches Codex", async () => {
  const { calls } = await scriptInvocations("await agent('plain', { schema: null }); return true;");
  assert.strictEqual(calls.length, 1);
  assert.ok(!calls[0].argv.includes("-m"));
  assert.ok(!calls[0].argv.some((arg) => String(arg).startsWith("model_reasoning_effort=")));
});

test("claude_compat: a dropped Claude model falls back to the run-level model", async () => {
  const { rec, calls } = await scriptInvocations("await agent('a', { model: 'sonnet' }); return true;", {
    claude_compat: true,
    model: "gpt-run"
  });
  const argv = calls[0].argv;
  assert.strictEqual(argv[argv.indexOf("-m") + 1], "gpt-run");
  assert.strictEqual(rec.warnings.length, 1);
});

test("reasoning effort is passed through to Codex instead of a fixed GPT-5.6 list", async () => {
  const sessionDir = freshSessionDir();
  const home = freshTmpDir("ultracode-effort-home-");
  const workflow = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, () =>
    engine.runWorkflow({
      cwd: home,
      codex_bin: MOCK,
      codex_home: home,
      workers_spec: [{ prompt: "minimal effort", reasoning_effort: "minimal" }]
    })
  );
  assert.strictEqual(workflow.status, "completed");
  assert.ok(readInvocations(sessionDir)[0].argv.includes('model_reasoning_effort="minimal"'));
});

test("a non-string reasoning effort is rejected before any worker spawns", async () => {
  const home = freshTmpDir("ultracode-effort-home-");
  await assert.rejects(
    () => engine.runWorkflow({ cwd: home, codex_bin: MOCK, codex_home: home, task: "t", reasoning_effort: 5 }),
    /reasoning_effort must be a non-empty string/
  );
  await assert.rejects(
    () =>
      engine.runWorkflow({
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        workers_spec: [{ prompt: "p", reasoning_effort: "  " }]
      }),
    /workers_spec\[0\]\.reasoning_effort must be a non-empty string/
  );
});
