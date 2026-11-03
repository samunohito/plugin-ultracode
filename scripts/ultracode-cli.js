#!/usr/bin/env node
"use strict";

const engine = require("./ultracode-engine");
const fs = require("fs/promises");
const path = require("path");
// Require the runner DIRECTLY (not via engine) to keep the script contract
// clean and cycle-free (the runner requires the engine; the engine never
// top-level-requires the runner).
const scriptRunner = require("./ultracode-script-runner");
const workflowDefinitions = require("./workflow-definitions");
const pluginUpdater = require("./plugin-updater");

const NUMERIC_KEYS = new Set([
  "workers",
  "timeout_ms",
  "concurrency",
  "budget_tokens",
  "max_agents",
  "launch_stagger_ms",
  "max_retries",
  "base_delay_ms",
  "max_delay_ms",
  "ui_port"
]);
const JSON_KEYS = new Set(["workers_spec", "force_steps", "steps", "args"]);
const BOOLEAN_KEYS = new Set(["ui", "retry_jitter", "transport_strict", "auto_update", "no_auto_update", "claude_compat"]);
// Switch flags that take no value — they must NOT consume the following token,
// or a leading `--progress`/`--no-auto-update` would swallow the input positional.
const ZERO_ARG_FLAGS = new Set([
  "progress",
  "no_ui",
  "auto_update",
  "no_auto_update",
  "no_cancel_on_sigint",
  "claude_compat"
]);
// Auto-update is opt-in (it reinstalls the plugin into the user's Codex home)
// and throttled: at most one marketplace refresh per this interval (it only
// affects FUTURE Codex sessions, so per-command is pointless). Best-effort — a
// failure never breaks the command.
const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Wall-clock cap on the (best-effort) auto-update so a slow/hung marketplace
// can never stall the command it precedes.
const AUTO_UPDATE_TIMEOUT_MS = 20 * 1000;
const UI_COMMANDS = new Set(["exec", "resume", "workflow"]);
// Lifecycle / inspection / library verbs. Anything else on argv[0] is an input
// to the single unified execution command (a script input is a `*.js` path,
// `--path`, or `--source`).
const RESERVED_VERBS = new Set(["resume", "status", "workflow"]);

function parseBool(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  if (["1", "true", "yes", "on", "enabled", ""].includes(normalized)) return true;
  return true;
}

function parseArgs(argv) {
  const [command = "plan", ...rest] = argv;
  const options = {};
  let index = 0;
  // A single leading positional (before any --flag) is collected as
  // options._positional — the unified command's input token.
  if (rest.length > 0 && !rest[0].startsWith("--")) {
    options._positional = rest[0];
    options._positionals = [rest[0]];
    index = 1;
  }
  for (; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      if (!options._positionals) options._positionals = [];
      options._positionals.push(arg);
      if (options._positional === undefined) options._positional = arg;
      continue;
    }
    const key = arg.slice(2).replace(/-/g, "_");
    if (ZERO_ARG_FLAGS.has(key)) {
      options[key] = true;
      continue; // never consume the next token for a value-less switch
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function coerce(options, command) {
  for (const key of NUMERIC_KEYS) {
    if (typeof options[key] === "string") {
      const number = Number(options[key]);
      if (Number.isFinite(number)) options[key] = number;
    }
  }
  for (const key of JSON_KEYS) {
    if (typeof options[key] === "string") {
      try {
        options[key] = JSON.parse(options[key]);
      } catch (error) {
        throw new Error(`--${key} must be valid JSON: ${error.message}`);
      }
    }
  }
  if (options.no_ui) {
    options.ui = false;
    delete options.no_ui;
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in options) {
      options[key] = parseBool(options[key]);
    }
  }
  if (UI_COMMANDS.has(command) && options.ui === undefined) {
    const env = parseBool(process.env.ULTRACODE_UI);
    options.ui = env === undefined ? true : env;
  }
  if (options.progress) {
    options.on_event = (event) => {
      process.stderr.write(`[ultracode] ${event.type}${event.label ? ` ${event.label}` : ""}${event.message ? ` ${event.message}` : ""}\n`);
    };
    delete options.progress;
  }
  return options;
}

// Run an engine call that supports cancellation, wiring a one-shot SIGINT
// handler that aborts the in-flight run on the first Ctrl-C (the engine then
// returns the partially-completed, persisted workflow which main() prints) and
// hard-exits 130 on a second SIGINT. The handler is scoped to the awaited call
// and removed afterwards so it never swallows Ctrl-C for plan/status. Opt out
// with --no-cancel-on-sigint.
async function runCancellable(fn, options) {
  if (options.no_cancel_on_sigint || process.env.ULTRACODE_NO_SIGINT) {
    return fn(options);
  }
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) {
      process.stderr.write("\n[ultracode] cancelling run (Ctrl-C again to force quit)...\n");
      controller.abort("SIGINT");
    } else {
      process.stderr.write("\n[ultracode] force quit.\n");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);
  try {
    return await fn({ ...options, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function workflowCommand(options) {
  const positionals = Array.isArray(options._positionals) ? options._positionals : [];
  const action = positionals[0] || "list";
  const target = positionals[1] || options.name || options.workflow;
  const common = {
    cwd: options.cwd,
    codex_home: options.codex_home
  };
  if (action === "list") {
    return { kind: "workflow_definitions", workflows: await workflowDefinitions.listWorkflowDefinitions(common) };
  }
  if (action === "show") {
    const definition = await workflowDefinitions.resolveWorkflowDefinition(target, common);
    return {
      kind: "workflow_definition",
      ...definition
    };
  }
  if (action === "save") {
    let source = options.source;
    if (!source && options.source_path) source = await fs.readFile(options.source_path, "utf8");
    if (!source && (options.workflow_id || options.state_path || options.from_workflow_id)) {
      const record = await engine.readWorkflow({
        workflow_id: options.from_workflow_id || options.workflow_id,
        state_path: options.state_path,
        codex_home: options.codex_home
      });
      if (!record || record.status === "missing") throw new Error("No workflow record found to save.");
      const scriptPath = record.script_path || record.source_path;
      if (!scriptPath) throw new Error("Workflow record does not include a script_path or source_path.");
      source = await fs.readFile(scriptPath, "utf8");
    }
    const saved = await workflowDefinitions.saveWorkflowDefinition({
      name: target,
      source,
      cwd: options.cwd,
      codex_home: options.codex_home,
      scope: options.scope || "project"
    });
    return {
      kind: "workflow_definition",
      saved: true,
      ...saved
    };
  }
  if (action === "update") {
    let source = options.source;
    if (!source && options.source_path) source = await fs.readFile(options.source_path, "utf8");
    const updated = await workflowDefinitions.updateWorkflowDefinition(target, {
      ...common,
      source
    });
    return {
      kind: "workflow_definition",
      saved: true,
      ...updated
    };
  }
  if (action === "delete" || action === "rm") {
    const deleted = await workflowDefinitions.deleteWorkflowDefinition(target, common);
    return {
      kind: "workflow_definition",
      deleted: true,
      ...deleted
    };
  }
  throw new Error(
    `Unknown workflow command: ${action} (expected list|show|save|update|delete). ` +
      `To RUN a saved workflow use \`ultracode @${target || "<name>"}\` or \`--workflow <name>\`.`
  );
}

// Auto-update runs only when asked for (`--auto-update` or
// ULTRACODE_AUTO_UPDATE=1). `--no-auto-update` / ULTRACODE_NO_AUTO_UPDATE=1
// still win, so an existing opt-out keeps working.
function autoUpdateEnabled(options) {
  if (options.no_auto_update === true) return false;
  if (parseBool(process.env.ULTRACODE_NO_AUTO_UPDATE) === true) return false;
  return options.auto_update === true || parseBool(process.env.ULTRACODE_AUTO_UPDATE) === true;
}

function autoUpdateCodexHome(options) {
  // Honor --codex-home; fall back to CODEX_HOME / the default (~/.codex).
  return options.codex_home && String(options.codex_home).trim() ? String(options.codex_home).trim() : null;
}

function autoUpdateStampPath(options) {
  // Stable per-install location (codex home), NOT the per-command cwd.
  const home = autoUpdateCodexHome(options);
  const dir = home ? path.join(home, "ultracode") : path.dirname(engine.stateDir());
  return path.join(dir, "auto-update-check.json");
}

// Best-effort, throttled auto-update. Runs on every command but does real work
// at most once per AUTO_UPDATE_INTERVAL_MS, and NEVER throws — an update only
// refreshes the plugin for future Codex sessions, so a failure (offline,
// marketplace down) must not break the current run. Opt in with
// --auto-update or ULTRACODE_AUTO_UPDATE=1.
async function maybeAutoUpdatePlugin(options) {
  const enabled = autoUpdateEnabled(options);
  delete options.auto_update;
  delete options.no_auto_update;
  if (!enabled) return;
  const stampPath = autoUpdateStampPath(options);
  try {
    const last = Number(JSON.parse(await fs.readFile(stampPath, "utf8")).ts);
    if (Number.isFinite(last) && Date.now() - last < AUTO_UPDATE_INTERVAL_MS) return;
  } catch {
    // no readable stamp -> a check is due
  }
  // Stamp BEFORE attempting so a slow or failing update is not retried on the
  // very next command (avoids hammering a down marketplace).
  try {
    await fs.mkdir(path.dirname(stampPath), { recursive: true });
    await fs.writeFile(stampPath, `${JSON.stringify({ ts: Date.now() })}\n`, "utf8");
  } catch {
    return; // can't even record the attempt -> skip quietly
  }
  // Target the same codex home the stamp uses, and bound the work with a
  // wall-clock timeout so a hung marketplace can't stall the command.
  const codexHome = autoUpdateCodexHome(options);
  try {
    const result = await pluginUpdater.updatePlugin({
      codex_bin: options.codex_bin,
      cwd: options.cwd,
      marketplace: options.marketplace,
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
      timeout_ms: AUTO_UPDATE_TIMEOUT_MS
    });
    process.stderr.write(`[ultracode] auto-update: ${result.message}\n`);
  } catch (error) {
    process.stderr.write(`[ultracode] auto-update skipped: ${error instanceof Error ? error.message : error}\n`);
  }
}

// Resolve a saved workflow definition by name and run it as a script
// (claude_compat), reached via `@NAME` or `--workflow NAME`.
async function runNamed(name, options) {
  const definition = await workflowDefinitions.resolveWorkflowDefinition(name, {
    cwd: options.cwd,
    codex_home: options.codex_home
  });
  const runOptions = {
    ...options,
    path: definition.path,
    name: options.run_name || options.name || definition.name,
    claude_compat: true,
    definition_ref: {
      id: definition.id,
      name: definition.name,
      scope: definition.scope,
      path: definition.path,
      source_hash: definition.source_hash
    }
  };
  delete runOptions._positional;
  delete runOptions._positionals;
  delete runOptions.workflow;
  return runCancellable(scriptRunner.runScript, runOptions);
}

// A steps[]/workers_spec[] JSON value -> the matching engine entrypoint. An
// array whose objects carry `id` is a barrier-free DAG (runPipelineSpec);
// otherwise it is a flat panel of {prompt} specs (runWorkflow via workers_spec).
function runJsonInput(parsed, options) {
  const steps = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.steps)
      ? parsed.steps
      : null;
  if (!steps || steps.length === 0) {
    throw new Error("JSON input must be a non-empty steps[] array (DAG) or a workers_spec[] array of {prompt}.");
  }
  const withId = (s) => s && typeof s === "object" && typeof s.id === "string";
  const hasIds = steps.some(withId);
  if (hasIds && !steps.every(withId)) {
    throw new Error(
      "JSON input mixes a pipeline DAG (every object needs an `id`) with workers_spec entries (no `id`). " +
        "Use one or the other."
    );
  }
  if (hasIds) {
    return runCancellable(engine.runPipelineSpec, { ...options, steps });
  }
  return runCancellable(engine.runWorkflow, { ...options, workers_spec: steps });
}

// Classify a single positional input token and dispatch. Explicit flags always
// win (handled in runExec); this only runs for a bare positional, with STRICT,
// ordered rules so routing is never silent.
async function classifyPositional(input, options) {
  const raw = String(input).trim();
  if (raw.startsWith("@")) {
    return runNamed(raw.slice(1), options);
  }
  if (/\.json$/i.test(raw)) {
    const text = await fs.readFile(path.resolve(options.cwd || process.cwd(), raw), "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${raw} is not valid JSON: ${error.message}`);
    }
    return runJsonInput(parsed, options);
  }
  if (raw.startsWith("[") || raw.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Input looks like JSON but did not parse: ${error.message}`);
    }
    return runJsonInput(parsed, options);
  }
  // A multi-line positional is inline JS source. Check this BEFORE the path
  // rule: a file path is always a single line, so a multi-line token is never a
  // path even when it contains `/` (a `//` comment, a regex, a quoted path).
  if (raw.includes("\n")) {
    return runCancellable(scriptRunner.runScript, { ...options, source: raw });
  }
  if (/\.(mjs|cjs|js)$/i.test(raw) || /[\\/]/.test(raw)) {
    return runCancellable(scriptRunner.runScript, { ...options, path: raw });
  }
  // A single-line phrase is a natural-language task. (Use --source for
  // single-line inline JS.)
  return runCancellable(engine.runWorkflow, { ...options, task: raw });
}

// The single execution command. Exactly one input selects WHAT to run; every
// path funnels into one engine entrypoint and journals the same record shapes
// `status`/`resume`/the dashboard already read.
async function runExec(options) {
  const positional = options._positional;
  delete options._positional;
  delete options._positionals;

  if (typeof options.source === "string" || typeof options.path === "string") {
    return runCancellable(scriptRunner.runScript, options);
  }
  if (options.steps !== undefined) {
    return runCancellable(engine.runPipelineSpec, options);
  }
  if (options.workers_spec !== undefined) {
    return runCancellable(engine.runWorkflow, options);
  }
  if (typeof options.workflow === "string") {
    return runNamed(options.workflow, options);
  }
  if (typeof options.task === "string") {
    return runCancellable(engine.runWorkflow, options);
  }
  if (positional !== undefined) {
    return classifyPositional(positional, options);
  }
  throw new Error(
    "Nothing to run. Provide an input — a task sentence, a script path or --source, a steps JSON or --steps, " +
      "--workers-spec, or @<saved-workflow> — or a lifecycle verb (resume|status|workflow)."
  );
}

// argv[0] is a lifecycle/library verb, or else the whole invocation is the one
// execution command. A synthetic "exec" command lets parseArgs treat argv[0] as
// the input positional / flags exactly as before.
function dispatchParse(argv) {
  if (argv.length > 0 && RESERVED_VERBS.has(argv[0])) {
    return parseArgs(argv);
  }
  const { options } = parseArgs(["exec", ...argv]);
  return { command: "exec", options };
}

async function main() {
  const { command, options } = dispatchParse(process.argv.slice(2));
  coerce(options, command);
  await maybeAutoUpdatePlugin(options);
  let result;
  if (command === "exec") {
    result = await runExec(options);
  } else if (command === "resume") {
    result = await runCancellable(engine.resumeWorkflow, options);
  } else if (command === "status") {
    result = await engine.readWorkflow(options);
  } else if (command === "workflow") {
    result = await workflowCommand(options);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// Only run the CLI when invoked directly. Importing this module (e.g. to
// unit-test the pure helpers) must not run main() — which would trigger the
// live auto-update and shell out to the marketplace.
if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, coerce, dispatchParse, classifyPositional, runJsonInput, autoUpdateEnabled };
