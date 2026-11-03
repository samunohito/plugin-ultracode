"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const { freshTmpDir } = require("./helpers/env.js");
const { parseCodexVersion, updatePlugin } = require("../scripts/plugin-updater.js");

const CLI = path.join(__dirname, "..", "scripts", "ultracode-cli.js");
const MOCK_CODEX_PLUGIN = path.join(__dirname, "fixtures", "mock-codex-plugin.js");

function readLog(logPath) {
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ULTRACODE_UI: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("parseCodexVersion splits semantic version from Codex cache-buster metadata", () => {
  assert.deepStrictEqual(parseCodexVersion("0.3.0+codex.20260601143116"), {
    version: "0.3.0+codex.20260601143116",
    base_version: "0.3.0",
    cache_buster: "20260601143116",
    cache_buster_kind: "codex_timestamp"
  });
});

test("updatePlugin times out (and kills the child) on a hung marketplace", async () => {
  const dir = freshTmpDir("ultracode-update-timeout-");
  const manifestPath = path.join(dir, "plugin.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ name: "ultracode", version: "0.3.0+codex.20260601143116" }));

  const started = Date.now();
  await assert.rejects(
    () =>
      updatePlugin({
        manifest_path: manifestPath,
        codex_bin: MOCK_CODEX_PLUGIN,
        cwd: dir,
        timeout_ms: 150,
        env: { ...process.env, MOCK_CODEX_PLUGIN_SLEEP_MS: "5000" }
      }),
    /timed out/
  );
  assert.ok(Date.now() - started < 4000, "rejected on the timeout, not after the 5s sleep");
});

test("updatePlugin refreshes the marketplace snapshot before reinstalling Ultracode", async () => {
  const dir = freshTmpDir("ultracode-update-");
  const logPath = path.join(dir, "codex-plugin.log");
  const manifestPath = path.join(dir, "plugin.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ name: "ultracode", version: "0.3.0+codex.20260601143116" }));

  const result = await updatePlugin({
    manifest_path: manifestPath,
    codex_bin: MOCK_CODEX_PLUGIN,
    marketplace: "just-every",
    cwd: dir,
    env: { ...process.env, MOCK_CODEX_PLUGIN_LOG: logPath }
  });

  assert.strictEqual(result.kind, "plugin_update");
  assert.strictEqual(result.plugin, "ultracode");
  assert.strictEqual(result.current_base_version, "0.3.0");
  assert.strictEqual(result.cache_buster, "20260601143116");
  assert.strictEqual(result.updated_for_future_sessions, true);
  assert.strictEqual(result.restart_required, true);

  const entries = readLog(logPath);
  assert.deepStrictEqual(entries.map((entry) => entry.args), [
    ["plugin", "marketplace", "upgrade", "just-every"],
    ["plugin", "add", "ultracode@just-every"]
  ]);
});

test("opted-in auto-update runs before a command, never changes its stdout, and is throttled", async () => {
  const dir = freshTmpDir("ultracode-auto-update-cli-");
  const logPath = path.join(dir, "codex-plugin.log");
  // CODEX_HOME=dir keeps the throttle stamp in a fresh dir; ULTRACODE_AUTO_UPDATE="1"
  // opts in and ULTRACODE_NO_AUTO_UPDATE="0" neutralizes an outer-shell opt-out.
  const env = {
    CODEX_HOME: dir,
    MOCK_CODEX_PLUGIN_LOG: logPath,
    ULTRACODE_AUTO_UPDATE: "1",
    ULTRACODE_NO_AUTO_UPDATE: "0"
  };

  // First run: no throttle stamp yet -> the updater runs before the command.
  const first = await runCli(["workflow", "list", "--codex-bin", MOCK_CODEX_PLUGIN, "--cwd", dir], env);
  assert.strictEqual(first.code, 0, `cli exited 0 (stderr: ${first.stderr})`);
  assert.strictEqual(JSON.parse(first.stdout).kind, "workflow_definitions", "the command's stdout JSON is unchanged");
  assert.match(first.stderr, /auto-update/);
  assert.deepStrictEqual(readLog(logPath).map((entry) => entry.args), [
    ["plugin", "marketplace", "upgrade", "just-every"],
    ["plugin", "add", "ultracode@just-every"]
  ]);

  // Second run within the interval: throttled -> NO further update commands.
  const second = await runCli(["workflow", "list", "--codex-bin", MOCK_CODEX_PLUGIN, "--cwd", dir], env);
  assert.strictEqual(second.code, 0, `cli exited 0 (stderr: ${second.stderr})`);
  assert.doesNotMatch(second.stderr, /auto-update/, "second run within 24h is throttled");
  assert.strictEqual(readLog(logPath).length, 2, "no extra update commands logged on the throttled run");
});

test("ULTRACODE_NO_AUTO_UPDATE=1 disables the auto-update entirely", async () => {
  const dir = freshTmpDir("ultracode-no-auto-update-cli-");
  const logPath = path.join(dir, "codex-plugin.log");
  const { code, stdout, stderr } = await runCli(["workflow", "list", "--codex-bin", MOCK_CODEX_PLUGIN, "--cwd", dir], {
    CODEX_HOME: dir,
    MOCK_CODEX_PLUGIN_LOG: logPath,
    ULTRACODE_NO_AUTO_UPDATE: "1"
  });

  assert.strictEqual(code, 0, `cli exited 0 (stderr: ${stderr})`);
  assert.strictEqual(JSON.parse(stdout).kind, "workflow_definitions");
  assert.doesNotMatch(stderr, /auto-update/);
  assert.strictEqual(fs.existsSync(logPath), false, "the updater never ran");
});

test("auto-update never runs unless opted in", async () => {
  const dir = freshTmpDir("ultracode-default-no-auto-update-cli-");
  const logPath = path.join(dir, "codex-plugin.log");
  const { code, stdout, stderr } = await runCli(["workflow", "list", "--codex-bin", MOCK_CODEX_PLUGIN, "--cwd", dir], {
    CODEX_HOME: dir,
    MOCK_CODEX_PLUGIN_LOG: logPath,
    ULTRACODE_AUTO_UPDATE: "0",
    ULTRACODE_NO_AUTO_UPDATE: "0"
  });

  assert.strictEqual(code, 0, `cli exited 0 (stderr: ${stderr})`);
  assert.strictEqual(JSON.parse(stdout).kind, "workflow_definitions");
  assert.doesNotMatch(stderr, /auto-update/);
  assert.strictEqual(fs.existsSync(logPath), false, "the updater never ran");
});
