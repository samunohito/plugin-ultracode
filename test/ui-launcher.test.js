"use strict";

const test = require("node:test");
const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("path");

const { engine, MOCK, freshTmpDir, withCodexHome } = require("./helpers/env.js");
const { ensureUiServer, metadataPathForRunsDir, shouldLaunchUi } = require("../scripts/ultracode-ui-launcher.js");
const { runScript } = require("../scripts/ultracode-script-runner.js");

const CLI = path.join(__dirname, "..", "scripts", "ultracode-cli.js");

async function fetchJson(url) {
  const response = await fetch(url);
  assert.strictEqual(response.status, 200, `GET ${url} returned ${response.status}`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  assert.strictEqual(response.status, 200, `POST ${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  assert.strictEqual(response.status, 200, `PUT ${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function deleteJson(url) {
  const response = await fetch(url, { method: "DELETE" });
  const text = await response.text();
  assert.strictEqual(response.status, 200, `DELETE ${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function stopServer(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}

test("shouldLaunchUi only defaults on when explicitly enabled by input or env", () => {
  const previous = process.env.ULTRACODE_UI;
  try {
    delete process.env.ULTRACODE_UI;
    assert.strictEqual(shouldLaunchUi({}), false);
    assert.strictEqual(shouldLaunchUi({ ui: true }), true);
    assert.strictEqual(shouldLaunchUi({ ui: false }), false);
    process.env.ULTRACODE_UI = "1";
    assert.strictEqual(shouldLaunchUi({}), true);
    process.env.ULTRACODE_UI = "0";
    assert.strictEqual(shouldLaunchUi({}), false);
  } finally {
    if (previous === undefined) delete process.env.ULTRACODE_UI;
    else process.env.ULTRACODE_UI = previous;
  }
});

test("runWorkflow ui:true launches the dashboard server and serves the workflow journal", async () => {
  let serverPid = null;
  await withCodexHome(async (home) => {
    try {
      const workflowDir = path.join(home, ".claude", "workflows");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowDir, "ui-audit.js"),
        'export const meta = { name: "UI Audit", description: "server list smoke" }; return { ok: true };\n'
      );
      const events = [];
      const record = await engine.runWorkflow({
        workers_spec: [{ label: "ui-smoke", prompt: "return a tiny UI smoke result", schema: null }],
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        ui: true,
        on_event: (event) => events.push(event)
      });
      serverPid = record.ui && record.ui.server_pid;

      assert.strictEqual(record.status, "completed");
      assert.ok(record.ui, "record includes ui metadata");
      assert.strictEqual(record.ui.status, "ready");
      assert.match(record.ui.url, new RegExp(`/workflow/${record.id}$`));
      assert.ok(events.some((event) => event.type === "ui.ready" && event.url === record.ui.url));

      const metaPath = metadataPathForRunsDir(path.dirname(record.state_path));
      assert.strictEqual(metaPath, path.join(record.state_dir, "ui", "server.json"));

      const health = await fetchJson(`${record.ui.server_url}/api/health`);
      assert.strictEqual(health.ok, true);
      assert.strictEqual(health.pid, serverPid);

      const emptyHookSessions = await fetchJson(`${record.ui.server_url}/api/hook-sessions`);
      assert.deepStrictEqual(emptyHookSessions.sessions, []);

      fs.mkdirSync(path.join(home, "loop", "sessions"), { recursive: true });
      fs.mkdirSync(path.join(home, "peer", "sessions"), { recursive: true });
      fs.writeFileSync(
        path.join(home, "loop", "sessions", "loop-a.json"),
        JSON.stringify({
          goal: "ship the loop UI",
          activated_at: "2026-07-06T01:00:00.000Z",
          updated_at: "2026-07-06T01:02:00.000Z",
          continues: 1,
          reviews: [{ at: "2026-07-06T01:01:00.000Z", kind: "stop", decision: "block", review: "Tests missing.", next_prompt: "Run npm test.", confidence: "high" }]
        })
      );
      fs.writeFileSync(
        path.join(home, "peer", "sessions", "peer-a.json"),
        JSON.stringify({
          updated_at: "2026-07-06T01:03:00.000Z",
          reviews: [{ at: "2026-07-06T01:03:00.000Z", kind: "prompt", prompt: "review this", amended_prompt: "review this with tests", review: "Added verification.", confidence: "high" }]
        })
      );
      const hookSessions = await fetchJson(`${record.ui.server_url}/api/hook-sessions`);
      assert.strictEqual(hookSessions.codex_home, home);
      assert.deepStrictEqual(hookSessions.sessions.map((session) => session.namespace), ["peer", "loop"]);
      assert.strictEqual(hookSessions.sessions.find((session) => session.namespace === "loop").goal, "ship the loop UI");
      assert.strictEqual(hookSessions.sessions.find((session) => session.namespace === "peer").reviews[0].amended_prompt, "review this with tests");

      const apiRecord = await fetchJson(`${record.ui.server_url}/api/workflows/${record.id}`);
      assert.strictEqual(apiRecord.id, record.id);
      assert.strictEqual(apiRecord.workers.length, 1);
      assert.strictEqual(apiRecord.ui.url, record.ui.url);

      const definitions = await fetchJson(`${record.ui.server_url}/api/workflow-definitions`);
      assert.ok(definitions.workflows.some((workflow) => workflow.id === "ui-audit" && workflow.scope === "project"));

      const htmlResponse = await fetch(record.ui.url);
      assert.strictEqual(htmlResponse.status, 200);
      assert.match(await htmlResponse.text(), /Ultracode Run/);

      for (const asset of [
        "/app.js",
        "/styles.css",
        "/vendor/react.production.min.js",
        "/vendor/react-dom.production.min.js",
        "/vendor/three.module.min.js",
        "/vendor/three.core.min.js"
      ]) {
        const assetResponse = await fetch(`${record.ui.server_url}${asset}`);
        assert.strictEqual(assetResponse.status, 200, `${asset} is served`);
      }
    } finally {
      await stopServer(serverPid);
    }
  });
});

test("dashboard API reconciles stale running workflow records before serving them", async () => {
  const runsDir = freshTmpDir("ultracode-ui-stale-runs-");
  let serverPid = null;
  try {
    const id = "stale-ui-reconcile";
    const startedAt = "2026-06-20T00:00:00.000Z";
    const statePath = path.join(runsDir, `${id}.json`);
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(
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
          events: []
        },
        null,
        2
      )}\n`
    );

    const server = await ensureUiServer(runsDir, { ui_port: 0 });
    serverPid = server.pid;

    const byId = await fetchJson(`${server.url}/api/workflows/${id}`);
    assert.strictEqual(byId.status, "abandoned");
    assert.strictEqual(byId.observed_status, "abandoned");
    assert.match(byId.abandoned_reason, /controller pid 2147483647 is not live/);
    assert.strictEqual(byId.workers[0].status, "abandoned");
    assert.strictEqual(byId.workers[1].status, "abandoned");
    assert.strictEqual(byId.workers[2].status, "completed");

    const latest = await fetchJson(`${server.url}/api/workflows/latest`);
    assert.strictEqual(latest.id, id);
    assert.strictEqual(latest.status, "abandoned");

    const list = await fetchJson(`${server.url}/api/workflows`);
    assert.strictEqual(list.workflows[0].id, id);
    assert.strictEqual(list.workflows[0].status, "abandoned");

    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.strictEqual(persisted.status, "abandoned");
  } finally {
    await stopServer(serverPid);
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("CLI run launches the dashboard by default and --no-ui disables it", async () => {
  const home = freshTmpDir("ultracode-cli-ui-");
  let serverPid = null;
  try {
    const workersSpec = JSON.stringify([{ label: "cli-ui", prompt: "cli ui smoke", schema: null }]);
    const env = { ...process.env, CODEX_HOME: home, CODEX_CLI_PATH: MOCK, ULTRACODE_NO_AUTO_UPDATE: "1" };
    const enabled = childProcess.spawnSync(
      process.execPath,
      [CLI, "--workers-spec", workersSpec, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
      { env, encoding: "utf8" }
    );
    assert.strictEqual(enabled.status, 0, enabled.stderr);
    const enabledRecord = JSON.parse(enabled.stdout);
    serverPid = enabledRecord.ui && enabledRecord.ui.server_pid;
    assert.strictEqual(enabledRecord.options.ui, true);
    assert.strictEqual(enabledRecord.ui.status, "ready");

    const disabled = childProcess.spawnSync(
      process.execPath,
      [CLI, "--workers-spec", workersSpec, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home, "--no-ui"],
      { env, encoding: "utf8" }
    );
    assert.strictEqual(disabled.status, 0, disabled.stderr);
    const disabledRecord = JSON.parse(disabled.stdout);
    assert.strictEqual(disabledRecord.options.ui, false);
    assert.strictEqual(disabledRecord.ui, undefined);
  } finally {
    await stopServer(serverPid);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("dashboard API saves a script run as a project workflow definition", async () => {
  let serverPid = null;
  await withCodexHome(async (home) => {
    try {
      const record = await runScript({
        source: 'export const meta = { name: "Script Save" }; const v = await agent("save me"); return { ok: !!v };',
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        ui: true
      });
      serverPid = record.ui && record.ui.server_pid;
      assert.strictEqual(record.status, "completed");

      const saved = await postJson(`${record.ui.server_url}/api/workflow-definitions`, {
        workflow_id: record.id,
        name: "Saved From UI",
        scope: "project"
      });
      assert.strictEqual(saved.saved, true);
      assert.strictEqual(saved.workflow.id, "saved-from-ui");
      assert.ok(fs.existsSync(path.join(home, ".claude", "workflows", "saved-from-ui.js")));
    } finally {
      await stopServer(serverPid);
    }
  });
});

test("dashboard API updates, runs, and deletes saved workflow definitions", async () => {
  let serverPid = null;
  await withCodexHome(async (home) => {
    try {
      const record = await runScript({
        source: 'export const meta = { name: "Library Host" }; return { ok: true };',
        state_dir: path.join(home, "selected-state"),
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        ui: true
      });
      serverPid = record.ui && record.ui.server_pid;
      const workflowDir = path.join(home, ".claude", "workflows");
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(
        path.join(workflowDir, "library-run.js"),
        [
          'export const meta = { name: "Library Run", phases: [{ title: "Run", detail: "Smoke" }] };',
          'phase("Run");',
          'const value = await agent("library smoke");',
          'return { arg: args && args.value, ok: !!value };'
        ].join("\n")
      );

      const updated = await putJson(`${record.ui.server_url}/api/workflow-definitions/library-run`, {
        source: 'export const meta = { name: "Library Run", description: "updated" }; return { updated: args.value };\n'
      });
      assert.strictEqual(updated.workflow.description, "updated");

      const launched = await postJson(`${record.ui.server_url}/api/workflow-definitions/library-run/run`, {
        args: { value: 42 },
        codex_bin: MOCK,
        codex_home: home
      });
      assert.strictEqual(launched.started, true);
      assert.strictEqual(launched.status, "completed");
      assert.deepStrictEqual(launched.record.result, { updated: 42 });
      assert.strictEqual(launched.record.state_dir, record.state_dir);
      assert.strictEqual(path.dirname(launched.record.state_path), path.dirname(record.state_path));

      const deleted = await deleteJson(`${record.ui.server_url}/api/workflow-definitions/library-run`);
      assert.strictEqual(deleted.deleted, true);
      assert.strictEqual(fs.existsSync(path.join(workflowDir, "library-run.js")), false);
    } finally {
      await stopServer(serverPid);
    }
  });
});

// Explicit status UI recovery regressions.
function status(home, args = [], preload) {
  const result = childProcess.spawnSync(process.execPath, [
    ...(preload ? ["--require", preload] : []), CLI, "status", ...args
  ], {
    cwd: home,
    env: {
      ...process.env,
      CODEX_CLI_PATH: MOCK,
      ULTRACODE_UI: "1",
      ULTRACODE_NO_AUTO_UPDATE: "1",
      MOCK_CODEX_SESSION_DIR: path.join(home, "status-worker-sessions")
    },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(home, "status-worker-sessions")), false, "status must not run workers");
  return JSON.parse(result.stdout);
}

async function stop(pid) {
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function fixture(home) {
  return engine.runWorkflow({
    workers_spec: [{ label: "recovery", prompt: "return a result", schema: null }],
    cwd: home, state_dir: path.join(home, "original"), codex_bin: MOCK, codex_home: home, ui: false
  });
}

function withoutUi(record) {
  const { ui, events, ...rest } = record;
  return rest;
}

async function cleanupServer(metaPath) {
  if (fs.existsSync(metaPath)) await stop(JSON.parse(fs.readFileSync(metaPath)).pid);
}

test("status --ui recovers a stopped dashboard from the actual journal and reuses a healthy server", async () => {
  await withCodexHome(async (home) => {
    const record = await fixture(home);
    const runsDir = path.dirname(record.state_path);
    const metaPath = metadataPathForRunsDir(runsDir);
    try {
      const oldServer = await ensureUiServer(runsDir);
      record.ui = { status: "ready", url: `${oldServer.url}/stale`, server_pid: oldServer.pid };
      fs.writeFileSync(record.state_path, JSON.stringify(record));
      await stop(oldServer.pid);
      const args = ["--state-path", record.state_path, "--state-dir", path.join(home, "different"), "--ui"];
      const recovered = status(home, args);
      assert.equal(recovered.ui.status, "ready");
      assert.notEqual(recovered.ui.server_pid, oldServer.pid);
      assert.notEqual(recovered.ui.url, record.ui.url);
      assert.equal(recovered.ui.state_path, record.state_path);
      assert.equal((await fetch(`${recovered.ui.server_url}/api/health`)).status, 200);
      assert.deepStrictEqual(withoutUi(recovered), withoutUi(record), "workflow results and status remain unchanged");
      assert.deepStrictEqual(recovered.events.slice(0, -1), record.events);
      assert.equal(recovered.events.at(-1).type, "ui.ready");
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(record.state_path)), recovered);
      const served = await (await fetch(`${recovered.ui.server_url}/api/workflows/${record.id}`)).json();
      assert.equal(served.id, record.id);
      assert.equal(fs.existsSync(path.join(home, "different")), false);

      const reused = status(home, args);
      assert.equal(reused.ui.server_pid, recovered.ui.server_pid);
      assert.equal(reused.ui.url, recovered.ui.url);
      assert.equal(reused.events.length, recovered.events.length + 1);
      assert.deepStrictEqual(withoutUi(reused), withoutUi(record));
    } finally {
      await cleanupServer(metaPath);
    }
  });
});

test("ordinary status and --no-ui leave a stopped dashboard and journal untouched", async () => {
  await withCodexHome(async (home) => {
    const record = await fixture(home);
    const metaPath = metadataPathForRunsDir(path.dirname(record.state_path));
    try {
      const server = await ensureUiServer(path.dirname(record.state_path));
      record.ui = { status: "ready", url: `${server.url}/stale`, server_pid: server.pid };
      fs.writeFileSync(record.state_path, JSON.stringify(record));
      await stop(server.pid);
      const journal = fs.readFileSync(record.state_path, "utf8");
      const metadata = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, "utf8") : null;
      for (const flags of [[], ["--no-ui"], ["--ui", "--no-ui"]]) {
        assert.deepStrictEqual(status(home, ["--state-path", record.state_path, ...flags]), record);
        assert.equal(fs.readFileSync(record.state_path, "utf8"), journal);
        assert.equal(fs.existsSync(metaPath) ? fs.readFileSync(metaPath, "utf8") : null, metadata);
      }
    } finally {
      await cleanupServer(metaPath);
    }
  });
});

test("status --ui with no workflow does not start a dashboard", async () => {
  await withCodexHome(async (home) => {
    const stateDir = path.join(home, "empty");
    assert.equal(status(home, ["--state-dir", stateDir, "--ui"]).status, "missing");
    const missing = childProcess.spawnSync(process.execPath, [CLI, "status", "--ui",
      "--state-path", path.join(stateDir, "runs", "missing.json")], {
      cwd: home, encoding: "utf8",
      env: { ...process.env, CODEX_CLI_PATH: MOCK, ULTRACODE_NO_AUTO_UPDATE: "1" }
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ENOENT/);
    assert.equal(fs.existsSync(stateDir), false);
  });
});

test("status --ui persists failure without a stale URL when startup metadata has no healthy server", async () => {
  await withCodexHome(async (home) => {
    const record = await fixture(home);
    record.ui = { status: "ready", url: "http://stale.invalid/workflow/old" };
    fs.writeFileSync(record.state_path, JSON.stringify(record));
    // Simulate a server publishing metadata before failing readiness. No real child is spawned.
    const preload = path.join(home, "unhealthy-server.cjs");
    fs.writeFileSync(preload, `
      const fs = require('node:fs');
      require('node:child_process').spawn = (exe, args, options) => {
        if (!args[0].endsWith('ultracode-ui-server.js')) throw new Error('Unexpected worker invocation');
        fs.writeFileSync(options.env.ULTRACODE_UI_META_PATH, JSON.stringify({
          url: 'http://127.0.0.1:1', pid: process.pid, runs_dir: options.env.ULTRACODE_UI_RUNS_DIR
        }));
        return { unref() {}, kill() {} };
      };
    `);
    const failed = status(home, ["--state-path", record.state_path, "--ui"], preload);
    assert.equal(failed.ui.status, "failed");
    assert.equal(failed.ui.url, undefined);
    assert.equal(failed.events.at(-1).type, "ui.failed");
    assert.equal(failed.events.some((event) => event.type === "ui.ready"), false);
    assert.deepStrictEqual(withoutUi(failed), withoutUi(record));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(record.state_path)), failed);
  });
});

test("status --ui preserves controller completion journaled during dashboard startup", async () => {
  await withCodexHome(async (home) => {
    const completed = await fixture(home);
    completed.workers[0].result = { answer: "new terminal result" };
    const running = JSON.parse(JSON.stringify(completed));
    running.status = "running";
    running.workers[0].status = "running";
    running.workers[0].result = null;
    fs.writeFileSync(completed.state_path, JSON.stringify(running));
    const preload = path.join(home, "complete-during-ui-start.cjs");
    fs.writeFileSync(preload, `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const spawn = cp.spawn;
      cp.spawn = (exe, args, options) => {
        if (!args[0].endsWith('ultracode-ui-server.js')) throw new Error('Unexpected worker invocation');
        fs.writeFileSync(${JSON.stringify(completed.state_path)}, ${JSON.stringify(JSON.stringify(completed))});
        return spawn(exe, args, options);
      };
    `);
    try {
      const recovered = status(home, ["--state-path", completed.state_path, "--ui"], preload);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(completed.state_path)), completed,
        "status must not overwrite the active controller's final journal");
      assert.deepStrictEqual(withoutUi(recovered), withoutUi(completed),
        "return the newest workflow results alongside the recovered dashboard");
      assert.equal(recovered.ui.status, "ready");
      assert.equal(recovered.events.at(-1).type, "ui.ready");
    } finally {
      await cleanupServer(metadataPathForRunsDir(path.dirname(completed.state_path)));
    }
  });
});
