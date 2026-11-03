# Ultracode CLI & API reference

Lookup material — flags, step fields, primitive signatures. The *decision* guidance (when to reach for
Ultracode, which surface, which pattern) lives in `../SKILL.md`; runnable end-to-end examples live in
`cookbook.md`. Read this when you already know what you're building and need the exact flag or field.

Run as `node scripts/ultracode-cli.js <input> [--flags]` from the plugin checkout, or use the absolute
`scripts/ultracode-cli.js` path inside the installed plugin cache. There is **one** execution command with **no
leading verb** — the input selects what runs (below). The lifecycle/library verbs (`resume`, `status`,
`workflow`) still take a leading verb. Add `--progress` to stream events to stderr.
`--workers-spec`, `--steps`, `--force-steps`, and `--args` take JSON; numeric flags are coerced; engine options
map to kebab-case flags (`--budget-tokens`, `--max-retries`, `--reasoning-effort`, `--transport`, `--executor`, …).

## Commands

### The one execution command

`node scripts/ultracode-cli.js <input> [flags]` runs with no leading verb. Explicit flags win; otherwise the
leading positional is classified by these strict, ordered rules:

| Input | What runs |
| --- | --- |
| `--source <js>` / `--path <file>` / positional `*.js` (or any path with a separator) / a **multi-line** positional | imperative **script** (`runScript`; `kind: "script"` record) |
| `--steps <json>` / positional `*.json` / inline JSON array whose objects carry `id` | barrier-free **DAG** (`runPipelineSpec`; `record.options.pipeline = true`) |
| `--workers-spec <json>` / inline JSON array of `{prompt}` objects **without** `id` | arbitrary one-shot **panel** (`runWorkflow` → `runExplicitWorkflow`; `record.options.explicit = true`) |
| `--task <t>` / a bare **single-line** positional sentence (with `--workers N`, 1-8) | fixed-role **fan-out** (`runWorkflow`; built-in `WORKER_ROLES`) |
| `--workflow <name>` / positional `@name` | run a **saved** `.claude/workflows` definition (`runScript` + `claude_compat` + `definition_ref`; `kind: "script"` record) |

The inputs are detailed in the input sections below. An empty invocation (no input) errors with a usage hint.

### Lifecycle & library verbs

- `resume`: resume a persisted workflow — completed steps are reused from the journal; only missing/failed/
  forced steps re-run.
- `status`: inspect persisted workflow state (journaled, so it reflects mid-flight progress). A deliberately
  cancelled run (first Ctrl-C) is recorded with status `cancelled`, distinct from `failed`/`partial`/`completed`.
- `workflow list|show|save|update|delete <name>`: manage Claude-style saved workflow definitions from
  `.claude/workflows`. Run a saved definition via the one command's `@name` / `--workflow <name>` input.

The unified execution command and `resume` launch the local React dashboard by default (the CLI's
`UI_COMMANDS` is `exec`/`resume`/`workflow`). The dashboard URL is stored on `record.ui.url` and emitted
as a `ui.ready` event. Disable it with `--no-ui` or `ULTRACODE_UI=0`. Optional UI flags: `--ui true|false`,
`--ui-host <host>`, and `--ui-port <port>` (default host `127.0.0.1`, port `0`). The dashboard serves checked-in
assets from the plugin cache and reads the same journal files as `status`; it does not require `npm install`.

### Canonical invocations

```bash
node scripts/ultracode-cli.js "review the auth refactor" --workers 5 --progress
node scripts/ultracode-cli.js --steps '[{"id":"a","prompt":"..."}]' --progress
node scripts/ultracode-cli.js --workers-spec '[{"prompt":"...","label":"sec"}]'
node scripts/ultracode-cli.js --source 'const out = await dag([...]); return out.synth;'
node scripts/ultracode-cli.js review.steps.json
node scripts/ultracode-cli.js @deep-research --args '{"topic":"Codex"}'
```

## Automatic updates

Auto-update is **opt-in**: it reinstalls the plugin into the user's Codex home, so it never runs unless asked
for. When enabled, before any command it runs
`codex plugin marketplace upgrade <marketplace>` then `codex plugin add <plugin>@<marketplace>`, but **at most
once per 24h** (tracked by a stamp file in the codex home) and **best-effort** — a failure (offline, marketplace
down) never breaks the command; it only logs `[ultracode] auto-update skipped: …`. The refresh updates the
installed cache for *future* Codex sessions; the current thread keeps the version it already loaded, so it never
mutates the running command.

- Opt in with `--auto-update` on any command, or `ULTRACODE_AUTO_UPDATE=1`. `--no-auto-update` /
  `ULTRACODE_NO_AUTO_UPDATE=1` always win.
- `marketplace`: marketplace name, default `just-every` (or `ULTRACODE_MARKETPLACE`).
- `plugin`: plugin name, default from `.codex-plugin/plugin.json`.
- `codex_bin`: Codex binary path (else `ULTRACODE_UPDATE_CODEX_BIN`, `CODEX_CLI_PATH`, or `codex`).

## Fixed-role fan-out (task input)

Reached via the one command — a `--task <t>` flag or a bare single-line positional sentence (no leading verb).
Fans out the built-in fixed reviewer roles in parallel and returns structured findings (one terminal barrier).

- `task`: natural-language objective (required unless `workers_spec` is given).
- `cwd`: repository or workspace path. Use the current working directory when possible.
- `workers`: 1-8. Use 3 for normal deep work, 5-6 for broad audits.
- `model`: optional Codex model for child workers. Unset means no `-m` override: workers use the model from the
  user's Codex config (`~/.codex/config.toml`). GPT-5.6 Codex workers use
  `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`. Use Luna for efficient high-volume lanes, Terra for
  balanced work, and Sol for complex coding and reasoning. Do not use the API alias `gpt-5.6` with a
  ChatGPT-authenticated Codex CLI. Prefer per-`workers_spec`/step overrides when a workflow mixes cheap scout
  lanes with deeper verifier/writer lanes.
- `reasoning_effort`: optional string passed to Codex as `model_reasoning_effort`; unset inherits the Codex
  config. Accepted values depend on the model (GPT-5.6: `none`, `low`, `medium`, `high`, `xhigh`, `max`,
  `ultra`; gpt-6.1-sol: `low`, `medium`, `high`, `xhigh`, `max`) and are not checked here —
  an unsupported value fails the worker with Codex's 400 listing the accepted ones. Use `low` for latency-sensitive lanes, `medium` as the balanced starting point,
  `high` or `xhigh` when evaluation shows a quality gain, and reserve `max` or `ultra` for the hardest
  quality-first workloads.
- `sandbox`: default `read-only`. Use `workspace-write` or `danger-full-access` only when the user explicitly
  wants child workers to modify files.
- `timeout_ms`: per-worker timeout (default 1,200,000 = 20 min; min 1000). The kill ladder is SIGTERM then
  SIGKILL after 5s.
- `codex_bin`: optional Codex binary path (else `CODEX_CLI_PATH`, else app-bundle candidates / bare `codex`).
- `codex_home`: optional `CODEX_HOME` for child workers (else inherited; defaults to `~/.codex`). The run's
  journaled state (`ultracode/runs/`, `ultracode/scripts/`) lives in the same home, so pass it to `status` /
  `resume` too.

Orchestration controls (all optional, all backward-compatible):

- `concurrency`: max simultaneous Codex subprocesses. Defaults to `min(16, cores-2)`.
- `launch_stagger_ms`: tiny per-workflow delay between simultaneous subprocess starts. Default `25`, override with
  `ULTRACODE_LAUNCH_STAGGER_MS`, or set `0` to disable.
- `budget_tokens`: best-effort total token budget — a pre-spawn gate checked when a worker is admitted, with
  usage accounted after each worker completes. New workers are skipped (and the cap logged) once exceeded, but
  with concurrency N up to N in-flight workers may still finish past the budget. A soft cap, not a hard
  per-token kill switch. Default `null` (unbounded); shared across all spawns in the run. Native runs meter
  total tokens; Claude-compatible scripts meter output tokens and `agent()` throws once the budget is spent.
- `max_agents`: lifetime cap on spawned workers for the run (default 1000).

Transient-retry knobs (retries fire **only** on classified transient errors — HTTP 429/5xx, rate-limit,
network errno, or transient auth-refresh races — never on login-required/bad-credential/bad-flag/schema/timeout/unknown failures):

- `max_retries`: per-worker transient retries. Default `0` (byte-identical to the pre-retry engine).
- `base_delay_ms`: base backoff delay. Default `500`.
- `max_delay_ms`: backoff cap. Default `30000`.
- `retry_jitter`: full-jitter in `[0, min(max, base*2^attempt)]`. Default `true`.
- Transient auth-refresh races get one implicit restart even when `max_retries` is `0`.

Schema-mismatch retries are a separate counter (default `1` when a schema is set, else `0`) and never consume
the transient-retry budget.

Transport (opt-in; also settable via `ULTRACODE_TRANSPORT`):

- `transport`: `exec` (default — shells `codex exec --json`), `app-server` (versioned JSON-RPC, **auto-falls
  back to exec** on any failure), or `exec-server` (reserved — throws not-yet-implemented). Unknown values
  coerce to `exec`.
- `transport_strict`: when `true`, an `app-server` failure errors instead of falling back. Default `false`.

### One-shot panel (`--workers-spec` input)

Arbitrary per-worker fan-out (the `agent()` parity path) — reached via the one command with `--workers-spec
<json>` or an inline JSON array of `{prompt}` objects **without** `id`. An array of worker specs that replaces
the fixed roles (`runWorkflow` → `runExplicitWorkflow`; `record.options.explicit = true`). Each spec:

- `prompt` (required): the worker's full instructions.
- `label`: display label used in progress and aggregation.
- `schema`: a JSON Schema object for this worker's output. Omit for the default `WORKER_SCHEMA`; pass `null`
  for raw free-text. (A worked custom schema is in `cookbook.md`.) Codex enforces output schemas in strict
  mode, so the engine sends a strict rewrite: every object gets `additionalProperties: false` (unless set) and
  lists all properties as `required`, with originally-optional ones made nullable. Those `null`s are stripped
  from the returned value, so you get the shape your own schema describes — no need to hand-write strict
  schemas.
- `sandbox`, `model`, `reasoning_effort`, `phase`, `timeout_ms`, `cwd`: per-worker overrides.
- `isolation: "worktree"`: run a writable worker in an isolated git worktree (its diff is collected back).

## DAG input (`--steps` / `steps[]` JSON)

Reached via the one command — `--steps <json>`, a positional `*.json` file, or an inline JSON array whose objects
carry `id` (`runPipelineSpec`; `record.options.pipeline = true`). A declarative directed-acyclic graph of stages.
Scheduling is **barrier-free** (see _Pick a surface_ in `../SKILL.md` for why that's the default); the whole DAG
is validated **before any spawn** — duplicate id, unknown/self dependency, and cycles all throw, with zero side
effects.

Top-level args mirror the fan-out orchestration controls — `cwd`, `sandbox`, `model`, `reasoning_effort`,
`timeout_ms`, `codex_bin`, `codex_home`, `concurrency`, `launch_stagger_ms`, `budget_tokens`, `max_agents`, the retry knobs,
`transport`, `transport_strict`, and an optional descriptive `task` — plus:

- `steps` (required): array of step objects (at least one).
- `executor`: default warm executor for every step — `cold` (default), `resume`, or `fork` (degrades to cold).

Each step:

- `id` (required): unique, `[A-Za-z0-9_-]+`; referenced by other steps' `depends_on` and `{{steps.<id>...}}`.
- `kind`: `worker` (default), `parallel`, `verify`, or `loop`.
- `prompt` (**required for every kind**): the prompt template. Cross-stage data flows by rendering tokens
  (resolved just before spawn; an unresolved token throws rather than emitting a blank): `{{steps.<id>.output}}`,
  `{{steps.<id>.output.<path>}}` (drill-in), `{{steps.<id>.summary}}`, `{{round}}`, `{{seen}}`,
  `{{seen_json}}`, `{{consecutive_dry}}` (inside a `loop`), and `{{item.<key>}}` (inside a `parallel`). **A step may only render tokens for ids in its own `depends_on`** (the
  compiler throws otherwise). Note `verify`/`loop` still *require* a `prompt` even though they don't use it as
  worker text (see below) — pass a token-free placeholder.
- `schema`: per-step JSON Schema (omit for `WORKER_SCHEMA`; `null` for raw text).
- `depends_on`: array of upstream step ids.
- `label`, `phase`, `sandbox`, `model`, `reasoning_effort`, `timeout_ms`, `cwd`, `isolation: "worktree"`,
  `executor`: per-step overrides.
- `verify`-only (`kind: "verify"`, wraps `adversarialVerify`): `findings_from` (upstream step id whose findings
  to vote on — **must also appear in `depends_on`** or the compiler throws), `findings_path` (dot-path into that
  output, default `findings`), `skeptics` (default 3), `lenses`, `context`. The step's own `prompt` is not used
  as worker text; its `output` is the surviving-findings array.
- `loop`-only (`kind: "loop"`, wraps `loopUntilDry`): `dry_rounds` (default 2), `max_rounds` (default 10),
  `dedupe_findings: true` to treat repeat-only `findings` rounds as dry and expose the running memory through
  `{{seen}}` / `{{seen_json}}`.
- `parallel`-only (`kind: "parallel"`): `fanout` (int, default 1) **or** `items` (array, each exposed via
  `{{item.<key>}}`).

Pipeline records include a top-level `steps[]` array and keep `workers[]` as the same step records for existing
`status` and `resume` readers. Completed worker/step records expose both `result` and `value` aliases. Pipeline
resume is **partial**: re-running an upstream step does not re-render or cascade to downstream dependents.

## `resume` / `status` arguments

- `resume`: `workflow_id` (or `state_path`) — the run to resume; `force_steps` — array of step ids / role ids /
  indices to re-run even if already completed.
- `status`: `workflow_id` or `state_path` (omit for the latest run).

## Engine primitives (scripted orchestration)

`scripts/ultracode-engine.js` exports composable primitives for callers driving Ultracode from Node. All share
one `ctx` (concurrency limiter, usage accumulator, `budget`, lifetime cap, progress sink) from
`createContext(opts)`. Inside a Workflow `script` these are pre-bound (ctx auto-injected) — see below.

- `spawnWorker(prompt, opts)` → one `codex exec` worker; returns `{status, value, result, usage, ...}`. With
  `opts.schema` it validates and retries once on mismatch; with `schema: null` it returns raw text. Never throws.
  `effort` is accepted as an alias of `reasoning_effort` (the Claude Workflow spelling); an explicit
  `reasoning_effort` wins.
- `spawnWarmWorker(prompt, opts)` → like `spawnWorker` but returns a handle whose `.turn(prompt)` resumes the
  **same** warm Codex session (`executor: "resume"`); any resume the CLI cannot honor falls back to cold exec.
- `runParallel(thunks, {ctx})` → barrier gather; a throwing thunk degrades to `null` (logged).
- `runPipeline(items, stages, {ctx})` → barrier-free multi-stage streaming; each item flows through all stages
  independently; a throwing stage drops that item to `null`.
- `loopUntilDry(makePrompt, {schema, dryRounds, maxRounds, ctx})` → keep spawning finders until K dry rounds /
  budget / lifetime cap. `makePrompt` receives only `(round, ctx)` — it sees no prior-round findings.
- `adversarialVerify(findings, {skeptics, lenses, ctx})` → keep only findings that survive a majority refute
  vote from N skeptic workers (optionally with distinct lenses).
- `validateAgainstSchema`, `createLimiter`, `sumUsageFromWorkers`, `log` are also exported.

## Workflow scripts (`*.js` / `--path` / `--source`) — API surface

Plain async JavaScript with the engine primitives pre-bound into scope, so a multi-agent workflow reads like
ordinary code with `await`, `map`/`filter`/`sort`, and arbitrary host-side reductions between agent calls. Drive
it via `node scripts/ultracode-cli.js <path> --args '<json>'` (positional path, or `--path` / `--source`).

Run-level `--model` / `--reasoning-effort` are the default for every worker the script spawns (`agent`,
`spawnWorker`, `fanout`, `dag`, `loopUntilDry`, `adversarialVerify`, nested `workflow()`); a per-call `model`
or `reasoning_effort` / `effort` wins, and with neither the worker inherits the Codex config.

Bound scope (ctx is auto-injected — never pass it):

- `agent(prompt, opts?)` → the worker `value` on completion, else `null` (failure already logged). The
  ergonomic happy-path primitive.
- `spawnWorker(prompt, opts?)` → the full `{status, value, result, usage, ...}` record (advanced).
- `parallel(thunks)` → barrier gather; throwing thunk → `null`.
- `pipeline(items, ...stages)` → **variadic**; each stage receives `(prev, item, index, ctx)`; barrier-free
  per-item streaming over a list.
- `fanout(taskOrSpecs, opts?)` → one bounded barrier; returns an array of worker values (`null` for failures),
  exactly like `parallel()`. A string task expands to the built-in 1-8 fixed reviewer roles (`opts.workers`); an
  array of `{prompt, label?, schema?, sandbox?, model?, …}` specs runs an arbitrary panel.
- `dag(steps)` → run a declarative `depends_on` graph (`worker`/`parallel`/`verify`/`loop` kinds,
  `{{steps.<id>.output}}` edges) on the live script `ctx`; returns an `{ [stepId]: output }` map and journals its
  workers into the script record. **Distinct from `pipeline(items, ...stages)`** (per-item streaming over a list).
- `loopUntilDry(makePrompt, opts?)`, `adversarialVerify(findings, opts?)` → as above; both inherit the current
  `phase()` by default inside scripts. `makePrompt` receives `(round, ctx, state)`; with
  `dedupeFindings: true`, `state.seenList` is the running finding/source memory and repeat-only rounds count as
  dry.
- `log(message, data?)`, `phase(title)`, `workflow(pathOrSource, args?)` (one-level nested run).
- `context` (`{ args, cwd, workflow, phase, log, budget }`) and `orchestrator` (namespace alias for the
  primitives) for Claude-compatible saved workflows.
- `budget` (`{ total, spent(), remaining() }`), `args`, `ctx`, `WORKER_SCHEMA`, `VERDICT_SCHEMA`.

Top-level `await` and a top-level `return` (or top-level `export default <expr>`) become `record.result`.
A script that returns normally is `status: "completed"`, or `status: "partial"` with `failed_workers: <n>`
when any of its workers failed or was cancelled (those calls resolved to `null` inside the script).
The journaled `kind: "script"` record is readable by `status`, updates while the script is running, and includes
the dynamic worker records spawned by `agent`, `spawnWorker`, `loopUntilDry`, and `adversarialVerify`. See
`examples/parallel-reduce.workflow.js`, `examples/budget-loop.workflow.js`,
`examples/research-loop.workflow.js` (a stateful loop-until-dry research template), and
`examples/deep-research.workflow.js` (a plan → gather → verify → synthesize research harness), and
`cookbook.md` for the composed patterns.

Script records also include a source snapshot:

- `script_path`: the saved source copy under `$CODEX_HOME/ultracode/scripts/`.
- `source_path`: the original path when run from a file.
- `source_hash`: SHA-256 of the script source.
- `meta`: parsed Claude-style `export const meta = { name, description, phases }` when present. Keep each
  `meta.phases[].title` identical to the string passed to the matching `phase(...)` call: the live dashboard
  groups workers by their runtime `phase()` title, while `meta.phases` (and its `detail`) is what the
  saved-workflow library previews — mismatched titles leave a declared phase with no workers under it.
- `definition_ref`: saved-workflow identity when run through the one command's `@name` / `--workflow <name>`
  input.

`resume_from_run_id` / `resumeFromRunId` replays the **unchanged prefix** of `agent()` / `spawnWorker()` calls
(Claude Workflow semantics). Each call is matched on its deterministic prompt+options cache key; the first call
with no match — a new or edited call — ends the prefix, and it plus every call started after it runs live, even
if an identical call exists in the prior journal (its inputs may have changed upstream). N identical calls
replay N distinct journaled results. A `cache prefix ended at call-N` log event marks where live work began.

Native scripts run as a plain (un-sandboxed) `AsyncFunction`, so `Date.now()`, `Math.random()`, and
`new Date()` work — but any volatile value baked into a worker's *prompt* changes its cache key and ends the
resume prefix there. Keep volatile values out of prompts — or pass them through `args`. Claude-compatible
scripts are stricter (below).

## Saved workflow definitions (`workflow list|show|save|update|delete`)

The `workflow` verb is the saved-definition **library** — `list`, `show`, `save`, `update`, `delete`. Run a
saved definition through the one command's `@name` / `--workflow <name>` input.
Saved definitions are JavaScript workflows discovered in this order:

- `<cwd>/.claude/workflows/*.js`
- `~/.claude/workflows/*.js`
- `$CODEX_HOME/ultracode/workflows/*.js`

Project definitions win when names collide.

```bash
node scripts/ultracode-cli.js workflow list
node scripts/ultracode-cli.js workflow show deep-research
node scripts/ultracode-cli.js workflow save deep-research --workflow-id ultra-...
node scripts/ultracode-cli.js workflow save deep-research --source 'export const meta = { name: "Deep Research" }; return {};'
node scripts/ultracode-cli.js workflow update deep-research --source-path .claude/workflows/deep-research.js
node scripts/ultracode-cli.js workflow delete deep-research
# Run a saved definition by name:
node scripts/ultracode-cli.js @deep-research --args '{"topic":"Codex"}'
```

Running a saved definition (via `@name` / `--workflow <name>`), or any script with `--claude-compat`, turns on
strict Claude-compat diagnostics and adapters before execution, matching Claude's Workflow tool:

- `agent()` without a `schema` returns the worker's final text instead of a `WORKER_SCHEMA` object.
- The script runs in a fresh `node:vm` context with only ECMAScript built-ins and the bound primitives — no
  `process`, `require`, timers, or `Buffer`. `Date.now()`, `Date()`, argless `new Date()`, and `Math.random()`
  throw (they would break resume); `new Date(value)`, `Date.parse`, and `Date.UTC` work. The return value is
  cloned out of the sandbox and must be structured-cloneable.
- `budget` meters output tokens, and `agent()` throws once it is spent.
- Claude-only options are reported in `record.warnings` (and a `claude-compat` log event): `agentType` has no
  Codex equivalent and runs a default worker; a Claude `model` (`haiku`, `sonnet`, `opus`, `fable`,
  `claude-*`) is dropped so the worker uses the Codex config's model. Codex model ids pass through.
- An inline nested `workflow()` inherits compat mode.

Allowed workflow primitive imports are rewritten to the bound runtime,
`export async function run(context)` is invoked automatically, and direct workflow-side filesystem/shell/host
access fails explicitly before workers spawn. The dashboard server also exposes definition
list/show/save/update/delete/run endpoints, and the React UI shows the workflow library with source editing and
JSON-args run support.

## Warm-context executor & transport (opt-in)

`--executor cold|resume|fork` (top-level or per step) keeps a Codex session warm across turns; `cold` is the
default and `fork` degrades to cold (`codex fork` is TUI-only). `--transport exec|app-server` selects the worker
transport; `app-server` auto-falls-back to `exec` on any failure unless `--transport-strict`. Both are pure
optimizations that never change a run's correctness. Full semantics and fallback guarantees: _Warm-context
workers_ and _Worker transport_ in `README.md`.

## Cancellation

For the one execution command and `resume`, the first Ctrl-C aborts the in-flight run and prints the
partially-completed persisted workflow (status `cancelled`, resumable from its journal); a second Ctrl-C
hard-exits 130. Opt out with `--no-cancel-on-sigint` or `ULTRACODE_NO_SIGINT`. (`status` and the `workflow`
library verbs never intercept Ctrl-C.)

## Limits

Ultracode subprocesses do not render as native Codex app/TUI sub-agents — the CLI result is the visible bridge
back into the parent thread. Token-budget gating depends on Codex reporting `turn.completed.usage`; worktree
isolation requires a git repository. See `README.md` for the full Claude-Workflow parity matrix.
