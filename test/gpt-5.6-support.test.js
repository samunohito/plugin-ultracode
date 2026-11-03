"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  engine,
  MOCK,
  freshSessionDir,
  readInvocations,
  withCodexHome,
  withMockEnv,
  withCodexCliPath
} = require("./helpers/env.js");

const {
  GPT_5_6_MODELS,
  GPT_5_6_REASONING_EFFORTS,
  runPipelineSpec,
  runWorkflow
} = engine;

test("unset model and reasoning effort inherit the Codex config across workflow surfaces", async () => {
  await withCodexHome(async (home) => {
    const sessionDir = freshSessionDir();
    const fixed = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, () =>
      runWorkflow({ task: "default fixed workflow", workers: 1, cwd: home, codex_bin: MOCK, codex_home: home })
    );
    assert.ok(fixed.options.model == null);
    assert.ok(fixed.options.reasoning_effort == null);
    assert.ok(fixed.workers[0].model == null);
    assert.ok(fixed.workers[0].reasoning_effort == null);

    const panel = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, () =>
      runWorkflow({ cwd: home, codex_bin: MOCK, codex_home: home, workers_spec: [{ prompt: "default panel" }] })
    );
    assert.ok(panel.options.model == null);
    assert.ok(panel.options.reasoning_effort == null);
    assert.ok(panel.workers[0].model == null);
    assert.ok(panel.workers[0].reasoning_effort == null);

    const dag = await withCodexCliPath(MOCK, () =>
      withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, () =>
        runPipelineSpec({ cwd: home, codex_bin: MOCK, codex_home: home, steps: [{ id: "default", prompt: "default DAG" }] })
      )
    );
    assert.ok(dag.options.model == null);
    assert.ok(dag.options.reasoning_effort == null);
    assert.ok(dag.steps[0].model == null);
    assert.ok(dag.steps[0].reasoning_effort == null);

    const invocations = readInvocations(sessionDir);
    assert.strictEqual(invocations.length, 3);
    for (const { argv } of invocations) {
      assert.ok(!argv.includes("-m"), `no model override passed to Codex: ${argv.join(" ")}`);
      assert.ok(
        !argv.some((arg) => String(arg).startsWith("model_reasoning_effort=")),
        `no reasoning override passed to Codex: ${argv.join(" ")}`
      );
    }
  });
});

test("GPT-5.6 models and their supported reasoning efforts are accepted and journaled", async () => {
  await withCodexHome(async (home) => {
    const sessionDir = freshSessionDir();
    const workers_spec = GPT_5_6_MODELS.flatMap((model) =>
      GPT_5_6_REASONING_EFFORTS.map((reasoning_effort) => ({
        label: `${model}-${reasoning_effort}`,
        prompt: `exercise ${model} at ${reasoning_effort}`,
        model,
        reasoning_effort
      }))
    );

    const workflow = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, () =>
      runWorkflow({
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: workers_spec.length,
        workers_spec
      })
    );

    assert.strictEqual(workflow.status, "completed");
    assert.strictEqual(workflow.workers.length, workers_spec.length);
    const invocations = readInvocations(sessionDir);
    assert.strictEqual(invocations.length, workers_spec.length);
    for (const model of GPT_5_6_MODELS) {
      for (const reasoning_effort of GPT_5_6_REASONING_EFFORTS) {
        assert.ok(
          workflow.workers.some((worker) => worker.model === model && worker.reasoning_effort === reasoning_effort),
          `expected ${model} with ${reasoning_effort} to be preserved`
        );
        assert.ok(
          invocations.some(
            ({ argv }) =>
              argv.includes(model) && argv.includes(`model_reasoning_effort=${JSON.stringify(reasoning_effort)}`)
          ),
          `expected ${model} with ${reasoning_effort} to be passed to Codex`
        );
      }
    }
  });
});

test("GPT-5.6 reasoning efforts flow through fixed and DAG workflow paths", async () => {
  await withCodexHome(async (home) => {
    const fixed = await withMockEnv({}, () =>
      runWorkflow({
        task: "fixed workflow GPT-5.6 contract",
        workers: 1,
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        model: "gpt-5.6-sol",
        reasoning_effort: "ultra"
      })
    );
    assert.strictEqual(fixed.workers[0].model, "gpt-5.6-sol");
    assert.strictEqual(fixed.workers[0].reasoning_effort, "ultra");

    const dag = await withCodexCliPath(MOCK, () =>
      withMockEnv({}, () =>
        runPipelineSpec({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          steps: [{ id: "fast", prompt: "DAG GPT-5.6 contract", model: "gpt-5.6-luna", reasoning_effort: "none" }]
        })
      )
    );
    assert.strictEqual(dag.steps[0].model, "gpt-5.6-luna");
    assert.strictEqual(dag.steps[0].reasoning_effort, "none");
  });
});
