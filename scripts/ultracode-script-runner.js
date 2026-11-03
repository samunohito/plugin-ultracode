#!/usr/bin/env node
"use strict";

// ===========================================================================
// ultracode-script-runner — opt-in imperative JS workflow-script runner
//
// This is the Codex analogue of Claude Code's Workflow tool: it binds the
// engine's existing orchestration primitives (spawnWorker / runParallel /
// runPipeline / loopUntilDry / adversarialVerify) into a small, ergonomic
// "script scope" so an operator can express a multi-agent workflow as plain
// imperative JavaScript instead of a declarative DAG.
//
//   await runScript({ source: `
//     phase("scan");
//     const hits = await parallel(files.map(f => () => agent("inspect " + f)));
//     return hits.filter(Boolean);
//   ` })
//
// ---------------------------------------------------------------------------
// Execution model.
// ---------------------------------------------------------------------------
// runScript() compiles the workflow body with AsyncFunction in the host CLI
// process. The transform is ergonomic: it provides top-level await, captures a
// top-level return value, binds Ultracode primitives, and journals script output
// into the usual run record under CODEX_HOME/ultracode/runs.
// ===========================================================================

const fs = require("fs/promises");
const path = require("path");

const {
  assertClaudeWorkflowSupported,
  cacheKey,
  extractClaudeWorkflowMeta,
  prepareClaudeWorkflowSource,
  sourceHash
} = require("./claude-workflow-compat");
const { transformSource } = require("./script-source-transform");
const { attachWorkflowUi, shouldLaunchUi } = require("./ultracode-ui-launcher");
const workflowDefinitions = require("./workflow-definitions");

// Top-level require of the engine is intentional and safe: the engine must
// NOT top-level require this runner (it uses a lazy require wrapper), so there
// is no require cycle. See ultracode-engine.js runScript re-export.
const engine = require("./ultracode-engine");

// ---------------------------------------------------------------------------
// Local persistence helper. Script ids come from the engine's workflowIdentity()
// helper so every Ultracode surface journals the same readable id/name shape.
// ---------------------------------------------------------------------------

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function scriptSnapshotPathFor(id) {
  return path.join(path.dirname(engine.stateDir()), "scripts", `${id}.workflow.js`);
}

async function readResumeRecord(input) {
  const id = input.resume_from_run_id || input.resumeFromRunId;
  if (!id) return null;
  const record = await engine.readWorkflow({ workflow_id: id });
  if (!record || record.status === "missing") {
    throw new Error(`resume_from_run_id "${id}" was not found.`);
  }
  return record;
}

function cacheableWorkerMap(record) {
  const out = new Map();
  for (const worker of (record && record.workers) || []) {
    if (!worker || worker.status !== "completed" || !worker.cache_key) continue;
    out.set(worker.cache_key, worker);
  }
  return out;
}

function makeScriptPersister(record, ctx) {
  let chain = Promise.resolve();
  return {
    schedule() {
      engine._internal.refreshControllerHeartbeat(record);
      const snapshot = JSON.parse(JSON.stringify(record));
      chain = chain
        .then(() => writeJson(record.state_path, snapshot))
        .catch((error) => {
          engine.log(ctx, `Failed to persist script workflow state: ${error.message}`, { reason: "persist-error" });
          process.stderr.write(`[ultracode] script state persist error: ${error.message}\n`);
        });
      return chain;
    },
    flush() {
      return chain;
    }
  };
}

function scriptPendingWorkerRecord(meta, fallbackIndex) {
  const index = meta && Number.isInteger(meta.index) ? meta.index : fallbackIndex;
  const id = meta && meta.id ? meta.id : `worker-${index + 1}`;
  const label = (meta && meta.label) || id;
  return {
    index,
    id,
    step_id: (meta && meta.step_id) || id,
    title: (meta && meta.title) || label,
    label,
    phase: (meta && meta.phase) || null,
    ...(meta && meta.script_call_id ? { script_call_id: meta.script_call_id } : {}),
    ...(meta && meta.cache_key ? { cache_key: meta.cache_key } : {}),
    status: "pending",
    ...(meta && meta.spec ? { spec: meta.spec } : {})
  };
}

function scriptWorkerRecordFromResult(meta, result, fallbackIndex) {
  const base = scriptPendingWorkerRecord(meta, fallbackIndex);
  return engine.workerRecordFromResult(base, result);
}

function emitScriptEvent(ctx, event) {
  if (!ctx) return;
  const stamped = { at: new Date().toISOString(), ...event };
  ctx.events.push(stamped);
  if (ctx.onEvent) {
    try {
      ctx.onEvent(stamped);
    } catch {
      /* progress sink errors must never break a run */
    }
  }
}

// ---------------------------------------------------------------------------
// Source transform.
//
// The script body is compiled with the AsyncFunction constructor whose NAMED
// PARAMETERS are the bound API. This gives us: top-level `await`, a captured
// top-level `return` value (becomes record.result), and host-level try/catch
// journaling of a throwing/syntactically-broken script. Orphan (un-awaited)
// promise rejections — which fire outside that try/catch — are separately
// captured by a scoped process listener and surfaced as record.warnings, so a
// fire-and-forget rejection can never crash a long-lived host. (A genuinely
// stray synchronous throw on a later timer tick — an uncaughtException — is the
// one residual that is NOT contained; that matches normal Node script execution.)
//
// ES module sugar is tolerated so a `.workflow.js` file can be authored with
// editor module support. The transform is lexical, so nested workflow source
// strings keep their own `export default` until the nested runner compiles them:
//   - `export default <expr>` -> `return <expr>`.
//   - leading `export const|let|var|async|function|class` -> the bare decl.
//
// A `"use strict";` prelude is prepended so an undeclared assignment throws
// ("x is not defined") instead of silently leaking a host global.
// ---------------------------------------------------------------------------

// AsyncFunction constructor (function scope, not a fresh global).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The ordered list of bound-scope parameter names. Kept as a single source of
// truth so the function signature and the call arguments never drift apart.
const SCOPE_PARAMS = [
  "agent",
  "spawnWorker",
  "parallel",
  "pipeline",
  "loopUntilDry",
  "adversarialVerify",
  "log",
  "phase",
  "workflow",
  "context",
  "orchestrator",
  "budget",
  "args",
  "ctx",
  "WORKER_SCHEMA",
  "VERDICT_SCHEMA",
  // Appended at the END so existing positional AsyncFunction slots never shift.
  "fanout",
  "dag"
];

// ---------------------------------------------------------------------------
// Bound script scope. ctx is auto-injected into every primitive so the user
// never has to thread it. `currentPhase` is closure-tracked and used as the
// default phase for worker-spawning primitives.
// ---------------------------------------------------------------------------

function buildScope(ctx, input, hooks = {}) {
  let currentPhase = null;
  let currentAutoPhase = null;
  let scriptCallIndex = 0;
  let controlCallIndex = 0;

  // Defaults shared by every spawn: where the codex bin/home live and the cwd.
  // These come from the runScript input so a script never has to repeat them.
  const spawnDefaults = {};
  if (typeof input.codex_bin === "string" && input.codex_bin.trim()) {
    spawnDefaults.codex_bin = input.codex_bin.trim();
  }
  if (typeof input.codex_home === "string" && input.codex_home.trim()) {
    spawnDefaults.codex_home = input.codex_home.trim();
  }
  if (input.cwd) spawnDefaults.cwd = input.cwd;

  // spawnWorker(prompt, opts?) -> FULL engine record {status,value,usage,...}.
  // ctx + phase defaults are injected; never throws (engine resolves a failure
  // to a {status:'failed'} record).
  // Claude Workflow scripts (saved `.claude/workflows` definitions, or any run
  // with `claude_compat`) expect agent() without a `schema` to return the
  // worker's final text, not the WORKER_SCHEMA object.
  const claudeCompat = Boolean(input.claude_compat || input.claudeCompat);

  function normalizeWorkerOpts(opts = {}) {
    const normalized = { ...(opts || {}) };
    if (normalized.agentType && !normalized.label) normalized.label = String(normalized.agentType);
    if (normalized.name && !normalized.label) normalized.label = String(normalized.name);
    // `effort` is the Claude Workflow spelling of reasoning_effort.
    if (normalized.effort !== undefined) {
      if (normalized.reasoning_effort === undefined && normalized.reasoningEffort === undefined) {
        normalized.reasoning_effort = normalized.effort;
      }
      delete normalized.effort;
    }
    if (claudeCompat && normalized.schema === undefined) normalized.schema = null;
    return normalized;
  }

  function spawnWorker(prompt, opts = {}) {
    const callId = `call-${scriptCallIndex + 1}`;
    scriptCallIndex += 1;
    const normalizedOpts = normalizeWorkerOpts(opts);
    const callOpts = {
      ...spawnDefaults,
      phase: currentPhase || currentAutoPhase,
      ...normalizedOpts
    };
    const key = cacheKey({ kind: "spawnWorker", prompt, opts: callOpts });
    const cached = typeof hooks.lookupCachedWorker === "function" ? hooks.lookupCachedWorker(key) : null;
    if (cached && typeof hooks.recordCachedWorker === "function") {
      return hooks.recordCachedWorker(cached, {
        callId,
        cacheKey: key,
        prompt,
        opts: callOpts
      });
    }
    return engine.spawnWorker(prompt, {
      ...callOpts,
      ctx,
      script_call_id: callId,
      cache_key: key
    });
  }

  // agent(prompt, opts?) -> worker.value on completion, else null (the engine
  // already logged the failure). The ergonomic happy-path primitive.
  async function agent(prompt, opts = {}) {
    const record = await spawnWorker(prompt, opts);
    return record && record.status === "completed" ? record.value : null;
  }

  agent.create = function createAgent(defaults = {}) {
    const agentDefaults = normalizeWorkerOpts(defaults);
    return {
      run(prompt, opts = {}) {
        const finalPrompt = prompt || agentDefaults.prompt;
        if (typeof finalPrompt !== "string" || !finalPrompt.trim()) {
          throw new Error("agent.create(...).run(prompt) requires a prompt.");
        }
        const merged = normalizeWorkerOpts({ ...agentDefaults, ...opts });
        delete merged.prompt;
        return agent(finalPrompt, merged);
      },
      spawn(prompt, opts = {}) {
        const finalPrompt = prompt || agentDefaults.prompt;
        if (typeof finalPrompt !== "string" || !finalPrompt.trim()) {
          throw new Error("agent.create(...).spawn(prompt) requires a prompt.");
        }
        const merged = normalizeWorkerOpts({ ...agentDefaults, ...opts });
        delete merged.prompt;
        return spawnWorker(finalPrompt, merged);
      }
    };
  };

  // parallel(thunks) -> barrier gather; a throwing thunk degrades to null.
  function parallel(thunks) {
    return engine.runParallel(thunks, { ctx });
  }

  // pipeline(items, ...stages) -> VARIADIC. engine.runPipeline takes stages as
  // an ARRAY; collecting the rest params here is MANDATORY. Passing stages
  // positionally would silently null every item (opts lands on a stage fn so
  // ctx becomes null and even the drop-log is a no-op). Each stage receives
  // (prev, item, index, ctx).
  async function pipeline(items, ...stages) {
    const pipelineIndex = controlCallIndex + 1;
    const callId = `pipeline-${pipelineIndex}`;
    const label = `Pipeline ${pipelineIndex}`;
    controlCallIndex += 1;
    const itemCount = Array.isArray(items) ? items.length : null;
    const stageCount = stages.length;
    const startedAt = Date.now();
    const itemLabel = itemCount === null ? "items" : `${itemCount} ${itemCount === 1 ? "item" : "items"}`;
    emitScriptEvent(ctx, {
      type: "script.wait.started",
      id: callId,
      label,
      status: "running",
      message: `Script is waiting for ${itemLabel} to finish ${stageCount} pipeline ${stageCount === 1 ? "stage" : "stages"} before it can schedule the next statement.`,
      data: {
        kind: "pipeline",
        item_count: itemCount,
        stage_count: stageCount,
        phase: currentPhase
      }
    });
    const previousAutoPhase = currentAutoPhase;
    if (!currentPhase && !currentAutoPhase) currentAutoPhase = label;
    try {
      const result = await engine.runPipeline(items, stages, { ctx });
      const completed = Array.isArray(result) ? result.filter((item) => item !== null).length : null;
      const dropped = Array.isArray(result) ? result.length - completed : null;
      emitScriptEvent(ctx, {
        type: "script.wait.completed",
        id: callId,
        label,
        status: "completed",
        message: `Pipeline barrier released; the script can schedule the next statement.`,
        data: {
          kind: "pipeline",
          item_count: itemCount,
          stage_count: stageCount,
          completed_count: completed,
          dropped_count: dropped,
          duration_ms: Date.now() - startedAt,
          phase: currentPhase
        }
      });
      return result;
    } catch (error) {
      emitScriptEvent(ctx, {
        type: "script.wait.failed",
        id: callId,
        label,
        status: "failed",
        message: `Pipeline barrier failed: ${error.message}`,
        data: {
          kind: "pipeline",
          item_count: itemCount,
          stage_count: stageCount,
          duration_ms: Date.now() - startedAt,
          phase: currentPhase,
          error: error.message
        }
      });
      throw error;
    } finally {
      currentAutoPhase = previousAutoPhase;
    }
  }

  function loopUntilDry(makePrompt, opts = {}) {
    return engine.loopUntilDry(makePrompt, { ...spawnDefaults, phase: currentPhase, ...opts, ctx });
  }

  function adversarialVerify(findings, opts = {}) {
    return engine.adversarialVerify(findings, { ...spawnDefaults, phase: currentPhase, ...opts, ctx });
  }

  // fanout(taskOrSpecs, opts?) -> ONE bounded barrier of workers (the old `run`
  // surface, in-scope). A string task expands to the built-in fixed reviewer
  // roles (1-8); an array of {prompt,...} specs runs an arbitrary panel. Returns
  // an array of worker values (null for failures), exactly like parallel().
  async function fanout(taskOrSpecs, opts = {}) {
    if (Array.isArray(taskOrSpecs)) {
      return parallel(
        taskOrSpecs.map((spec) => () => {
          if (!spec || typeof spec.prompt !== "string" || !spec.prompt.trim()) {
            throw new Error("fanout(specs): each spec needs a non-empty `prompt`.");
          }
          return agent(spec.prompt, {
            label: spec.label,
            sandbox: spec.sandbox,
            model: spec.model,
            reasoningEffort: spec.reasoning_effort || spec.reasoningEffort,
            timeoutMs: spec.timeout_ms || spec.timeoutMs,
            isolation: spec.isolation,
            phase: spec.phase || currentPhase,
            schema: "schema" in spec ? spec.schema : engine.WORKER_SCHEMA
          });
        })
      );
    }
    const task = String(taskOrSpecs || "").trim();
    if (!task) {
      throw new Error("fanout(task): pass a non-empty task string or an array of {prompt} specs.");
    }
    const count = Math.min(Math.max(1, Math.floor(Number(opts.workers) || 3)), engine.MAX_WORKERS);
    const sandbox = opts.sandbox || "read-only";
    const pseudoWorkflow = { id: "script", cwd: input.cwd || process.cwd() };
    return parallel(
      engine.selectRoles(count).map((role) => () =>
        agent(engine.workerPrompt({ task, workflow: pseudoWorkflow, worker: role, sandbox }), {
          label: role.title,
          schema: engine.WORKER_SCHEMA,
          sandbox,
          model: opts.model,
          reasoningEffort: opts.reasoning_effort || opts.reasoningEffort,
          phase: opts.phase || currentPhase
        })
      )
    );
  }

  // dag(steps) -> run a declarative depends_on graph (the old `pipeline`
  // surface, in-scope) on the live ctx via the SAME scheduler runPipelineSpec
  // uses. Returns an { [stepId]: output } map; its workers journal into the
  // script record through the same ctx hooks as agent()/parallel().
  async function dag(steps) {
    const defaults = {
      cwd: input.cwd ? path.resolve(input.cwd) : process.cwd(),
      sandbox: input.sandbox || "read-only",
      timeout_ms:
        input.timeout_ms === undefined || input.timeout_ms === null
          ? undefined
          : Math.max(1000, Math.floor(Number(input.timeout_ms))),
      executor: "cold"
    };
    if (typeof input.model === "string" && input.model.trim()) defaults.model = input.model.trim();
    if (input.reasoning_effort || input.reasoningEffort) {
      defaults.reasoning_effort = input.reasoning_effort || input.reasoningEffort;
    }
    const { compiled } = engine._internal.compileSteps(steps, defaults);
    const retry = engine._internal.resolveRetryInput(input);
    const results = await engine.runDagOnCtx(compiled, ctx, {
      codexBin: spawnDefaults.codex_bin,
      codexHomeValue: spawnDefaults.codex_home,
      retryWorker: retry.worker,
      transport: input.transport,
      transportStrict: input.transport_strict || input.transportStrict
    });
    const out = {};
    for (const step of compiled) {
      out[step.id] = results.has(step.id) ? results.get(step.id).output : undefined;
    }
    return out;
  }

  // log(message, data?) routes through the engine's narrator so script lines
  // land in ctx.events alongside primitive logs.
  function log(message, data) {
    return engine.log(ctx, message, data);
  }

  // phase(title) sets the closure-tracked currentPhase used as the default
  // phase for subsequent agent()/spawnWorker() calls.
  function phase(title) {
    currentPhase = typeof title === "string" && title.trim() ? title.trim() : null;
    engine.log(ctx, `phase: ${currentPhase || "(none)"}`, { phase: currentPhase });
    return currentPhase;
  }

  // workflow(pathOrSource, args?) -> one-level nested runScript, guarded by
  // ULTRACODE_DEPTH. Refuses (and logs) beyond depth 1 with a clear, explicit
  // throw rather than silently no-op'ing. The nested run inherits concurrency/
  // budget/cap knobs but creates its own ctx at depth+1 (the engine pattern).
  async function workflow(pathOrSource, workflowArgs) {
    const depth = Number(process.env.ULTRACODE_DEPTH || 0);
    if (depth >= 1) {
      engine.log(ctx, "nested script workflow refused: depth limit reached", {
        reason: "maxDepth",
        depth
      });
      throw new Error("nested script workflows beyond depth 1 are not supported");
    }
    // A bare string with no newline and an existing-looking path is treated as
    // a path; anything containing a newline is inline source. Callers can be
    // explicit by passing { path } / { source }.
    const nested = {
      args: workflowArgs,
      cwd: input.cwd,
      concurrency: input.concurrency,
      budget_tokens: input.budget_tokens,
      max_agents: input.max_agents,
      launch_stagger_ms: input.launch_stagger_ms,
      max_retries: input.max_retries,
      base_delay_ms: input.base_delay_ms,
      max_delay_ms: input.max_delay_ms,
      retry_jitter: input.retry_jitter,
      signal: ctx.signal,
      on_event: ctx.onEvent || undefined,
      codex_bin: spawnDefaults.codex_bin,
      codex_home: spawnDefaults.codex_home
    };
    if (pathOrSource && typeof pathOrSource === "object") {
      Object.assign(nested, pathOrSource);
    } else if (typeof pathOrSource === "string" && pathOrSource.includes("\n")) {
      nested.source = pathOrSource;
    } else {
      const raw = String(pathOrSource || "").trim();
      const isExplicitPath = /[\\/]/.test(raw) || /\.js$/i.test(raw);
      if (isExplicitPath) {
        nested.path = path.isAbsolute(raw) ? raw : path.resolve(input.cwd || process.cwd(), raw);
      } else {
        const definition = await workflowDefinitions.resolveWorkflowDefinition(raw, {
          cwd: input.cwd,
          codex_home: spawnDefaults.codex_home
        });
        nested.path = definition.path;
        nested.name = definition.name;
        nested.claude_compat = true;
        nested.definition_ref = {
          id: definition.id,
          name: definition.name,
          scope: definition.scope,
          path: definition.path,
          source_hash: definition.source_hash
        };
      }
    }
    return runScript(nested);
  }

  const context = Object.freeze({
    args: input.args,
    cwd: input.cwd,
    workflow,
    phase,
    log,
    budget: ctx.budget
  });

  const orchestrator = Object.freeze({
    agent,
    spawnWorker,
    parallel,
    pipeline,
    fanout,
    dag,
    loopUntilDry,
    adversarialVerify,
    phase,
    log,
    workflow,
    budget: ctx.budget
  });

  return {
    agent,
    spawnWorker,
    parallel,
    pipeline,
    loopUntilDry,
    adversarialVerify,
    log,
    phase,
    workflow,
    context,
    orchestrator,
    budget: ctx.budget,
    args: input.args,
    ctx,
    WORKER_SCHEMA: engine.WORKER_SCHEMA,
    VERDICT_SCHEMA: engine.VERDICT_SCHEMA,
    fanout,
    dag
  };
}

// ---------------------------------------------------------------------------
// runScript(input) -> Promise<workflowRecord>
// ---------------------------------------------------------------------------

async function runScript(input = {}) {
  // XOR-validate source|path: exactly one is required.
  const hasSource = typeof input.source === "string" && input.source.length > 0;
  const hasPath = typeof input.path === "string" && input.path.trim().length > 0;
  if (hasSource && hasPath) {
    throw new Error("runScript: provide exactly one of `source` or `path`, not both.");
  }
  if (!hasSource && !hasPath) {
    throw new Error("runScript: one of `source` or `path` is required.");
  }

  const cwd = path.resolve(input.cwd || process.cwd());
  // Read the file by its contents only (dirname-independent): the script body
  // does not depend on where the file lives on disk.
  const sourcePath = hasSource ? null : path.resolve(cwd, input.path);
  const source = hasSource ? input.source : await fs.readFile(sourcePath, "utf8");
  const claudeCompat = Boolean(input.claude_compat || input.claudeCompat);
  if (claudeCompat) assertClaudeWorkflowSupported(source);
  const executionSource = claudeCompat ? prepareClaudeWorkflowSource(source) : source;
  const meta = extractClaudeWorkflowMeta(source);
  const hash = sourceHash(source);
  const resumeRecord = await readResumeRecord(input);
  const resumeCache = cacheableWorkerMap(resumeRecord);

  const identity = engine.workflowIdentity({ ...input, name: input.name || (meta && meta.name) }, "Script Run");
  const id = identity.id;
  const scriptPath = scriptSnapshotPathFor(id);
  let record = null;
  let persister = null;
  let ctx = null;
  const workersById = new Map();
  const schedulePersist = () => {
    if (!record || !persister || !ctx) return;
    record.events = ctx.events;
    record.aggregate_usage = ctx.usageTotals;
    persister.schedule();
  };
  ctx = engine.createContext({
    workflowId: id,
    concurrency: input.concurrency,
    budgetTokens: input.budget_tokens,
    maxAgents: input.max_agents,
    launchStaggerMs: input.launch_stagger_ms,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent:
      typeof input.on_event === "function"
        ? (event) => {
            try {
              input.on_event(event);
            } finally {
              schedulePersist();
            }
          }
        : () => schedulePersist(),
    onWorkerPending: (meta) => {
      if (!record || !meta) return;
      const pending = scriptPendingWorkerRecord(meta, record.workers.length);
      workersById.set(pending.id, pending.index);
      record.workers[pending.index] = pending;
      schedulePersist();
    },
    onWorkerRecord: (result, meta) => {
      if (!record) return;
      const index =
        meta && meta.id && workersById.has(meta.id) ? workersById.get(meta.id) : record.workers.length;
      const updated = scriptWorkerRecordFromResult(meta, result, index);
      workersById.set(updated.id, index);
      record.workers[index] = updated;
      schedulePersist();
    },
    signal: input.signal
  });

  const startedAt = new Date().toISOString();
  const statePath = engine.statePathFor(id);

  record = {
    id,
    name: identity.name,
    slug: identity.slug,
    kind: "script",
    status: "running",
    started_at: startedAt,
    completed_at: null,
    duration_ms: 0,
    controller: engine._internal.controllerSnapshot(startedAt),
    cwd,
    options: {
      concurrency: ctx.concurrency,
      budget_tokens: ctx.budget.total,
      max_agents: ctx.maxAgents,
      launch_stagger_ms: ctx.launchStaggerMs,
      ui: shouldLaunchUi(input),
      max_retries: input.max_retries === undefined ? null : input.max_retries,
      base_delay_ms: input.base_delay_ms === undefined ? null : input.base_delay_ms,
      max_delay_ms: input.max_delay_ms === undefined ? null : input.max_delay_ms,
      retry_jitter: input.retry_jitter === undefined ? null : input.retry_jitter
    },
    state_path: statePath,
    source_path: sourcePath,
    script_path: scriptPath,
    source_hash: hash,
    meta: meta || null,
    definition_ref: input.definition_ref || input.definitionRef || null,
    resume_from_run_id: resumeRecord ? resumeRecord.id : null,
    // Script records are not step-resumable, but they do journal the dynamic
    // workers they spawned so status can show live progress and post-run details.
    workers: [],
    result: null,
    events: ctx.events,
    aggregate_usage: ctx.usageTotals
  };

  // Persist a "running" snapshot up-front so an interrupted run still leaves a
  // readable record (mirrors runWorkflow).
  await writeText(scriptPath, source);
  await writeJson(statePath, record);
  persister = makeScriptPersister(record, ctx);
  await attachWorkflowUi(record, ctx, input);
  if (record.ui) schedulePersist();

  const scope = buildScope(ctx, { ...input, cwd }, {
    lookupCachedWorker(key) {
      return resumeCache.get(key) || null;
    },
    recordCachedWorker(cached, metaForCache) {
      const index = record.workers.length;
      const idForWorker = `worker-${index + 1}`;
      const cachedRecord = {
        index,
        id: idForWorker,
        step_id: idForWorker,
        title: cached.title || cached.label || idForWorker,
        label: cached.label || cached.title || idForWorker,
        phase: cached.phase || null,
        status: "completed",
        result: cached.result,
        value: cached.value,
        usage: null,
        duration_ms: 0,
        thread_id: cached.thread_id || null,
        cached: true,
        cached_from_run_id: resumeRecord.id,
        script_call_id: metaForCache.callId,
        cache_key: metaForCache.cacheKey,
        spec: {
          ...(cached.spec || {}),
          prompt: metaForCache.prompt,
          cache_opts_hash: cacheKey({ opts: metaForCache.opts })
        }
      };
      record.workers.push(cachedRecord);
      engine.log(ctx, `script cache hit for ${metaForCache.callId}`, {
        reason: "script-cache-hit",
        cached_from_run_id: resumeRecord.id
      });
      schedulePersist();
      return Promise.resolve({
        status: "completed",
        value: cachedRecord.value,
        result: cachedRecord.value,
        usage: null,
        thread_id: cachedRecord.thread_id,
        duration_ms: 0,
        label: cachedRecord.label,
        phase: cachedRecord.phase,
        cached: true
      });
    }
  });

  // Capture orphan (un-awaited) promise rejections from the script. A
  // fire-and-forget rejection (e.g. `Promise.reject(x)` with no await) fires on
  // a later tick — outside the try/await below — and would otherwise become a
  // process-level 'unhandledRejection' that crashes the host process. A scoped
  // listener installed only for the run both suppresses
  // Node's default crash and surfaces the rejection as a record warning.
  // (Under rare concurrent runs every listener sees every rejection; that
  // over-reports but never crashes.)
  const orphanRejections = [];
  const onUnhandledRejection = (reason) => {
    orphanRejections.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", onUnhandledRejection);

  // Build the async body. A SyntaxError here is caught below and journaled as
  // status:'failed' so a broken script never crashes the host.
  let result = null;
  let error = null;
  try {
    let fn;
    try {
      fn = new AsyncFunction(...SCOPE_PARAMS, transformSource(executionSource));
    } catch (compileError) {
      // SyntaxError from the AsyncFunction constructor.
      throw compileError;
    }
    const callArgs = SCOPE_PARAMS.map((name) => scope[name]);
    result = await fn(...callArgs);
  } catch (runError) {
    error = runError;
  } finally {
    // Yield one macrotask so any orphan rejection scheduled during the run is
    // delivered while the listener is still installed, then stop listening.
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }

  const completedAt = new Date().toISOString();
  record.completed_at = completedAt;
  record.duration_ms = Date.parse(completedAt) - Date.parse(startedAt);
  // aggregate_usage is the same object ctx mutated during the run; snapshot it
  // into the record explicitly to match the engine's finalized shape.
  record.aggregate_usage = ctx.usageTotals;
  record.events = ctx.events;
  if (error) {
    record.status = "failed";
    record.result = null;
    record.error = error instanceof Error ? error.message : String(error);
  } else {
    // agent() turns a failed worker into `null`, so a script can return
    // normally while some of its workers died. Surface that as 'partial'
    // instead of reporting a clean 'completed'.
    const failedWorkers = record.workers.filter((worker) => worker && (worker.status === "failed" || worker.status === "cancelled")).length;
    record.status = failedWorkers > 0 ? "partial" : "completed";
    if (failedWorkers > 0) record.failed_workers = failedWorkers;
    record.result = result === undefined ? null : result;
  }

  // A script that returned a value but also leaked an un-awaited rejection is
  // still 'completed' (its result is valid), but the leak is surfaced loudly as
  // a warning + a log event rather than silently swallowed.
  if (orphanRejections.length > 0) {
    record.warnings = orphanRejections.map((message) => `unhandled promise rejection: ${message}`);
    for (const message of orphanRejections) {
      engine.log(ctx, `script emitted an unhandled promise rejection: ${message}`, { reason: "unhandled-rejection" });
    }
    record.events = ctx.events;
  }

  // Final write. Wrapped so a serialization failure (e.g. a non-JSON-able
  // script return value) still journals a useful failure instead of throwing
  // out of runScript.
  try {
    persister.schedule();
    await persister.flush();
  } catch (writeError) {
    record.status = "failed";
    record.result = null;
    record.error = `result could not be journaled: ${writeError.message}`;
    // Best-effort second write of the now-sanitized record.
    try {
      await writeJson(statePath, record);
    } catch {
      /* nothing more we can do; return the in-memory record */
    }
  }

  return record;
}

module.exports = { runScript, transformSource };
