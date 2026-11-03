"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { engine, MOCK, MOCK_FAIL, withCodexHome, withMockEnv, freshCounterPath } = require("./helpers/env.js");
const { runWorkflow, readWorkflow } = engine;

async function stopServer(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}

test("legacy fan-out: 2 workers complete, aggregate doubles, state re-readable", async () => {
  await withCodexHome(async (home) => {
    const usage = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 3 };
    const wf = await withMockEnv({ MOCK_CODEX_USAGE: JSON.stringify(usage) }, async () =>
      runWorkflow({
        task: "investigate the thing",
        workers: 2,
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: 2,
        model: "gpt-5.6-terra",
        reasoning_effort: "high"
      })
    );

    assert.strictEqual(wf.status, "completed");
    assert.strictEqual(wf.options.model, "gpt-5.6-terra");
    assert.strictEqual(wf.options.reasoning_effort, "high");
    assert.strictEqual(wf.workers.length, 2);
    assert.ok(wf.workers.every((w) => w.status === "completed"));
    assert.ok(wf.workers.every((w) => w.model === "gpt-5.6-terra"));
    assert.ok(wf.workers.every((w) => w.reasoning_effort === "high"));

    // aggregate_usage = 2x per-worker. total_tokens per worker = 10+5+3 = 18 => 36
    assert.strictEqual(wf.aggregate_usage.total_tokens, 36);
    assert.strictEqual(wf.aggregate_usage.input_tokens, 20);

    // state file written at wf.state_path and re-readable via readWorkflow.
    const reread = await readWorkflow({ workflow_id: wf.id });
    assert.strictEqual(reread.id, wf.id);
    assert.strictEqual(reread.status, "completed");
    assert.strictEqual(reread.workers.length, 2);
  });
});

test("workers_spec: explicit path runs both specs (incl schema:null), stores spec", async () => {
  await withCodexHome(async (home) => {
    const wf = await withMockEnv({}, async () =>
      runWorkflow({
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: 2,
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
        workers_spec: [
          { prompt: "spec one", label: "alpha" },
          { prompt: "spec two", label: "beta", schema: null, model: "gpt-5.6-luna", reasoning_effort: "high" }
        ]
      })
    );

    assert.strictEqual(wf.status, "completed");
    assert.strictEqual(wf.name, "Alpha Beta");
    assert.strictEqual(wf.slug, "alpha-beta");
    assert.match(wf.id, /-alpha-beta$/);
    assert.strictEqual(wf.options.explicit, true);
    assert.strictEqual(wf.workers.length, 2);
    assert.ok(wf.workers.every((w) => w.status === "completed"));
    // Each worker has a stored spec for resume.
    assert.ok(wf.workers.every((w) => w.spec && typeof w.spec.prompt === "string"));
    const alpha = wf.workers.find((w) => w.label === "alpha");
    assert.strictEqual(alpha.model, "gpt-5.6-terra", "top-level model inherited from workflow");
    assert.strictEqual(alpha.reasoning_effort, "medium", "top-level reasoning inherited from workflow");
    const beta = wf.workers.find((w) => w.label === "beta");
    assert.strictEqual(beta.spec.schema, null, "schema:null preserved in stored spec");
    assert.strictEqual(beta.model, "gpt-5.6-luna", "top-level model override is journaled");
    assert.strictEqual(beta.reasoning_effort, "high", "top-level reasoning override is journaled");
    assert.strictEqual(beta.value, beta.result, "raw-text workers expose both result and value");
  });
});

test("workers_spec: concurrent launch is slightly staggered inside one workflow", async () => {
  await withCodexHome(async (home) => {
    const wf = await withMockEnv({ MOCK_CODEX_RESPONSE: "ok" }, async () =>
      runWorkflow({
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: 3,
        launch_stagger_ms: 8,
        workers_spec: [
          { prompt: "spec one", label: "alpha", schema: null },
          { prompt: "spec two", label: "beta", schema: null },
          { prompt: "spec three", label: "gamma", schema: null }
        ]
      })
    );

    assert.strictEqual(wf.status, "completed");
    assert.strictEqual(wf.options.launch_stagger_ms, 8);
    const staggers = wf.events.filter((e) => e.type === "worker.launch_stagger");
    assert.ok(staggers.length >= 2, `expected at least two staggered starts, got ${staggers.length}`);
    assert.ok(staggers.every((e) => e.delay_ms >= 0 && e.delay_ms <= 20), "stagger delays stay tiny");
  });
});

test("ui workflow persists worker starts before first completion", async () => {
  let run = null;
  let serverPid = null;
  await withCodexHome(async (home) => {
    try {
      run = withMockEnv({ MOCK_CODEX_SLEEP_MS: "500" }, async () =>
        runWorkflow({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          concurrency: 2,
          ui: true,
          workers_spec: [
            { prompt: "slow spec one", label: "alpha", schema: null },
            { prompt: "slow spec two", label: "beta", schema: null }
          ]
        })
      );

      const runsDir = engine.stateDir();
      let midFlight = null;
      for (let i = 0; i < 80; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        let files = [];
        try {
          files = fs.readdirSync(runsDir).filter((file) => file.endsWith(".json"));
        } catch {
          files = [];
        }
        for (const file of files) {
          const parsed = JSON.parse(fs.readFileSync(path.join(runsDir, file), "utf8"));
          serverPid = parsed.ui && parsed.ui.server_pid;
          const events = Array.isArray(parsed.events) ? parsed.events : [];
          const workers = Array.isArray(parsed.workers) ? parsed.workers : [];
          const startedCount = events.filter((event) => event.type === "worker.started").length;
          if (
            parsed.status === "running" &&
            startedCount === 2 &&
            workers.some((worker) => worker.status === "running") &&
            workers.every((worker) => worker.status !== "completed")
          ) {
            midFlight = parsed;
            break;
          }
        }
        if (midFlight) break;
      }

      assert.ok(midFlight, "state file should show running workers before the first completion");
      assert.strictEqual(midFlight.workers.filter((worker) => worker.status === "pending").length, 0);

      const final = await run;
      serverPid = final.ui && final.ui.server_pid;
      assert.strictEqual(final.status, "completed");
    } finally {
      if (run) await run.catch(() => {});
      await stopServer(serverPid);
    }
  });
});

test("partial status: exactly one of two workers fails => status 'partial'", async () => {
  await withCodexHome(async (home) => {
    // runExplicitWorkflow uses one shared codex_bin for every spec. To get a
    // genuine single-record partial (>=1 completed, >=1 failed) we force exactly
    // one invocation (index 0, per a fresh counter) of the mock to exit non-zero.
    const counter = freshCounterPath();
    const wf = await withMockEnv(
      { MOCK_CODEX_FAIL_ON_INVOCATION: "0", MOCK_CODEX_COUNTER: counter },
      async () =>
        runWorkflow({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          // Serialize so invocation indices are deterministic: the first worker
          // (index 0) fails, the second (index 1) completes.
          concurrency: 1,
          workers_spec: [
            { prompt: "a", label: "alpha" },
            { prompt: "b", label: "beta" }
          ]
        })
    );
    assert.strictEqual(wf.status, "partial");
    const failed = wf.workers.filter((w) => w.status === "failed");
    const completed = wf.workers.filter((w) => w.status === "completed");
    assert.strictEqual(failed.length, 1, "exactly one worker failed");
    assert.strictEqual(completed.length, 1, "exactly one worker completed");
  });
});

test("readWorkflow marks running records abandoned when recorded controller is gone", async () => {
  await withCodexHome(async () => {
    const id = "stale-controller-test";
    const statePath = engine.statePathFor(id);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          id,
          status: "running",
          started_at: startedAt,
          completed_at: null,
          controller: {
            pid: 2147483647,
            started_at: startedAt,
            heartbeat_at: startedAt,
            platform: process.platform
          },
          state_path: statePath,
          workers: [
            { id: "pending", status: "pending" },
            { id: "running", status: "running" },
            { id: "completed", status: "completed" }
          ],
          events: [],
          aggregate_usage: engine.sumUsageFromWorkers([])
        },
        null,
        2
      )
    );

    const observed = await readWorkflow({ workflow_id: id });
    assert.strictEqual(observed.status, "abandoned");
    assert.strictEqual(observed.observed_status, "abandoned");
    assert.match(observed.abandoned_reason, /controller pid 2147483647 is not live/);
    assert.strictEqual(observed.workers[0].status, "abandoned");
    assert.strictEqual(observed.workers[1].status, "abandoned");
    assert.strictEqual(observed.workers[2].status, "completed");

    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.strictEqual(persisted.status, "abandoned", "status reconciliation is persisted for dashboards");
  });
});

test("fully-failing workflow (shared failing bin) => status 'failed'", async () => {
  await withCodexHome(async (home) => {
    const failed = await withMockEnv({}, async () =>
      runWorkflow({
        cwd: home,
        codex_bin: MOCK_FAIL,
        codex_home: home,
        concurrency: 2,
        workers_spec: [{ prompt: "a" }, { prompt: "b" }]
      })
    );
    assert.strictEqual(failed.status, "failed");
    assert.ok(failed.workers.every((w) => w.status === "failed"));
  });
});

test("journaled JSON contains workers status, aggregate_usage, events, aggregate", async () => {
  await withCodexHome(async (home) => {
    const wf = await withMockEnv({}, async () =>
      runWorkflow({
        task: "journal check",
        workers: 1,
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: 1
      })
    );
    const reread = await readWorkflow({ workflow_id: wf.id });
    assert.ok(Array.isArray(reread.workers));
    assert.ok(reread.workers.every((w) => typeof w.status === "string"));
    assert.ok(reread.aggregate_usage && typeof reread.aggregate_usage.total_tokens === "number");
    assert.ok(Array.isArray(reread.events), "events journaled");
    assert.ok(reread.aggregate && Array.isArray(reread.aggregate.summary), "compactWorkflow aggregate present");
  });
});
