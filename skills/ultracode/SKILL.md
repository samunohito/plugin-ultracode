---
name: ultracode
description: Use when the user asks for Ultracode, deep parallel code investigation, multiple Codex worker passes, fan-out/fan-in analysis, subprocess-backed code review, multi-stage pipelines, budgeted/concurrency-capped worker runs, an exhaustive/sign-off audit, adversarial verification or a judge panel of worker agents, loop-until-dry discovery, multi-modal sweeps, or a Claude-style under-the-surface workflow in Codex.
---

# Ultracode

Ultracode gives Codex an orchestration engine that mirrors Claude Code's Workflow tool — `spawnWorker` (agent),
`runParallel` (fan out, wait for all), `runPipeline` (stream each item stage-to-stage), schema-validated
structured output, a shared concurrency cap, token-budget gating, progress events, journaled resume, and
quality helpers — all driven by real `codex exec` subprocesses. **One command runs it all**: hand
`ultracode <input>` a task sentence, a `steps[]` DAG, an imperative script, a `workers_spec[]` panel, or a saved
workflow name, and it routes to the right engine path for you.

**The workflow does the work; you orchestrate it.** The whole point is to *hand the task to a fleet of workers* —
let them sweep the files, run the passes, verify each finding — while you stay in the loop: deciding what to fan
out, reading the evidence that comes back, and integrating the result. The failure mode to avoid is the
opposite: doing the investigation yourself in the parent thread and bolting on a worker or two as a sidecar. If
you catch yourself reading files and reasoning through the whole task *before* (or *instead of*) spawning
workers, you're under-using the engine. Scout only enough to scope the work, then delegate the work itself.
Put as much of the real work into the workflow as possible: design the DAG/script carefully, launch it, and let
the engine run through the investigation, implementation, verification, and synthesis lanes.

This file is the **decision layer** — read it to decide whether and at what scale to use Ultracode, and how to
shape the run. Pull depth from `references/` only when you're actually building:

| When you're… | Read |
| --- | --- |
| choosing a quality/verification/discovery pattern, or inventing one | `references/quality-patterns.md` |
| about to write a `steps[]` DAG or a `script` — get the shape right first | `references/cookbook.md` |
| needing an exact flag, step field, primitive signature, or the `script` API | `references/cli.md` |

Before launching a non-trivial run, open `references/quality-patterns.md` and pick the quality harness first:
adversarial verify, multi-modal sweep, completeness critic, loop-until-dry, judge panel, or a composed variant.
Do this before settling on worker count or writing prompts, so the workflow is shaped around verification and
coverage rather than a thin generic fan-out.

## When to reach for Ultracode

When this skill is in play, **default to orchestrating** — author a workflow and let it run the task. Work solo
only when the task is genuinely tiny and already settled. The parent thread's job is to build the workflow
right, not to conserve agent usage by doing worker-suitable work inline. A fan-out earns its place when one of
three things is true:

- **Be comprehensive.** The task means sweeping many files, modules, or call sites and you want them covered in
  parallel: broad audits, "find every X", understanding a whole subsystem.
- **Be confident.** A conclusion is only worth committing to after independent perspectives and an adversarial
  check: sign-off reviews, risky refactors, "is this actually a bug or a false alarm".
- **Take on scale one pass can't hold.** Migrations, repo-wide sweeps, investigations whose evidence won't fit a
  single thread's attention.

A `codex exec` fan-out has startup overhead, but the engine exists to absorb parallel work. Do not ration agents
or keep chunks of investigation in the parent merely to limit resource usage. The common mistake under *this*
skill is staying solo on work that wanted a fleet. When in doubt, orchestrate.

**You don't need the shape before the task — only before the orchestration step.** The right move is often
*hybrid*: scout inline first (list the files, scope the diff, find the call sites), then hand that work-list to a
`dag` / `fanout` over it. Discovering the work-list is parent work; doing the work on each item is the
fleet's.

**Build the workflow before doing the work.** Spend the parent-thread effort on decomposing the task into
parallel lanes, explicit dependencies, schemas, verification passes, and synthesis stages. Once the workflow is
well-shaped, launch it and let it run. If the task has phases — understand → design → implement → review — put
those phases into the workflow itself where possible, using a script or DAG so results flow forward without the
parent becoming the hidden worker.

**Scale up by default.** Match workflow depth to the task's real shape, then let the engine handle the
parallelism. Treat small worker counts as a narrow-task optimization, not a resource-saving habit:

- "Take a quick look" → still delegate the scan: 2-3 focused lanes plus a light verifier when claims matter.
- "Review this change" → multi-lens finders, per-finding adversarial verification, and a synthesis stage.
- "Thoroughly audit / be exhaustive / sign off on this" → broad multi-modal sweeps, loop-until-dry or
  completeness-critic rounds, distinct-lens verification, and a final sign-off synthesis.

The smell test for *this* skill: if you spawned one worker and did the rest yourself, you **under**-orchestrated —
the common miss here. A complex, detailed workflow is usually better than a small sidecar fan-out. The main
thing to avoid is not "too many agents"; it is a poorly-shaped workflow with unnecessary barriers, missing
schemas, or no verification.

## Operating rules

- **Resolve the installed launcher.** From this skill's directory (`skills/ultracode/`), resolve
  `../../scripts/ultracode-cli.js` and invoke its absolute path with `node`; do not assume an `ultracode`
  command is on PATH or that the user's cwd is the plugin checkout. Examples below use `ultracode` as shorthand.
- **Separate launcher permissions from worker sandboxing.** For the paired memories-db/read-only
  app-server initialization failure, use host-approved launcher escalation (`require_escalated`) if necessary
  and available; keep the worker sandbox (`read-only` by default). Never copy auth to tmp or overwrite
  `CODEX_HOME`. Do not automatically retry escalation. See `references/cli.md` for diagnosis and UI recovery.
- **Choose model and reasoning by task complexity.** When a run does not require a custom model mix, set the
  worker `model` and `reasoning_effort` deliberately instead of leaving complexity implicit. Unset workers
  inherit the user's Codex config:
  `gpt-5.6-luna` + `low` for high-volume, latency-sensitive work; `gpt-5.6-terra` + `medium` for standard
  research and coding; `gpt-5.6-sol` + `high` for complex work; and `gpt-5.6-sol` + `xhigh` or `max` only when
  evaluation shows a quality gain. In Codex CLI, GPT-5.6 supports `none`, `low`, `medium`, `high`, `xhigh`,
  `max`, and `ultra`; use `ultra` only when evaluation shows a clear benefit. Use the explicit `gpt-5.6-sol`,
  `gpt-5.6-terra`, or `gpt-5.6-luna` IDs: the API alias `gpt-5.6` is not available to ChatGPT-authenticated
  Codex. For mixed workflows, keep narrow lanes on Luna or Terra and escalate only the stages that need broader
  reasoning. Do not use `max` or `ultra` as a blanket default.
- **Do not hoard the work in the parent thread.** If a task can be expressed as a worker lane, stage, verifier,
  critic, judge, writer, or synthesizer, put it in the workflow. Parent work should mostly be: choose the
  decomposition, set schemas and edges, launch, monitor failures, integrate returned evidence/diffs, and run the
  final checks. Avoid saving "just the important part" for yourself after launching agents.
- **Delegate the work — including the implementation; you integrate, you don't re-author.** Hand investigation,
  analysis, verification, *and the edits themselves* to the workers — and the **larger the change, the more it
  should be the fleet's, not yours**. A migration, a repo-wide rename, a codemod across many files is the *most*
  valuable thing to fan out, not a reason to fall back to doing it solo. You do **not** keep work visible by
  re-typing it in the parent: the run dashboard streams every worker's activity and output live, and worktree
  writers' diffs come back on the record. So for a change that fans out, give the writers `isolation: "worktree"`
  (it upgrades read-only workers to `workspace-write` and collects each diff back), then your job is to **review
  and apply those diffs**, not redo the work by hand. Author edits directly in the parent only for the small,
  local change you wouldn't have spun up a workflow for. Always: scope the fan-out, read every result (failures
  and low-confidence notes included), merge duplicates, prefer concrete file/line evidence, integrate, then
  verify — never redo in the parent what you just delegated.
- **Verify before you trust.** Default to an adversarial pass over your own findings before you act on or
  report them; skip verification only when the finding is trivial or already independently verified. The bar is
  to skip it, not to perform it.
- Keep workers **read-only** (`sandbox: read-only`, the default) unless the user explicitly wants writable child
  runs. For parallel writers you **must** use `isolation: "worktree"`, or their diffs collide in one cwd.
- Treat worker failures as **real failures**. A failed, timed-out, or refuted worker resolves to `null` / a
  `{status:"failed"}` record — filter it out; never substitute guessed output for it. A timed-out worker (default
  20 min) is **not** retried — transient-error retries are opt-in via `max_retries` (default `0`) and never cover
  a timeout — so don't set a tight `timeout_ms` for deep work, and read a thin result set as evidence of failures,
  not of a clean codebase.
- **Always use a Codex goal when Ultracode is invoked**, prefixing the objective with `Use $ultracode to ...` so
  every continuation re-triggers this skill. This goal is the mechanism that keeps multi-turn Ultracode work on
  track: it guards against ending after the worker summary but before synthesis, edits, integration, and final
  verification are genuinely settled. Clear it only once the top-level outcome is done. (Procedure: README "Pair
  with Codex goals".)
- **Surface the dashboard.** Leave the run UI on; the moment `ui.ready` fires (or from the final `record.ui.url`)
  open the URL in the Codex in-app browser, else print it as a plain clickable link so the user can watch the run
  live. A URL alone does not prove browser reachability: check server health and browser access separately.
  If the server stops, recover with `status --ui --state-path <journal>` without executing workers; do not
  infer why it stopped without evidence. (Mechanics and flags: `references/cli.md`.)

## Write the workflow

There is **one command and one surface**. Hand `ultracode <input>` the work and it routes by what you give it:

- a **task sentence** (`ultracode "review the auth refactor" --workers 5`) → a fixed-role fan-out: each of 1-8
  built-in reviewer roles works the one shared task (one terminal barrier);
- a **`steps[]` DAG** (`ultracode --steps '[…]'`, or a positional `.json` file) → a **barrier-free**
  `depends_on` graph with `worker`/`parallel`/`verify`/`loop` steps and `{{steps.<id>.output}}` edges;
- a **`workers_spec[]`** array of `{prompt}` (`ultracode --workers-spec '[…]'`) → an arbitrary one-shot panel;
- an **imperative script** (`ultracode --source '…'`, or a `.js` path) → plain async JS with the primitives
  bound into scope (`agent`, `parallel`, `pipeline`, `fanout`, `dag`, `loopUntilDry`, `adversarialVerify`,
  `budget`, …);
- a **saved workflow** (`ultracode @deep-research --args '…'`) → a `.claude/workflows` definition.

**The script is the superset — reach for it the moment your orchestration is dynamic** (loops, `map`/`filter`,
reductions, budget-driven branching). Two in-scope helpers cover the common shapes without ceremony:
**`fanout(specs | task, {workers})`** (a single bounded barrier — the panel or fixed-role fan-out) and
**`dag(steps)`** (a barrier-free `depends_on` graph). Save and re-run any input by name with
`ultracode workflow save <name> …`, then `ultracode @<name>`. (Lifecycle stays its own verbs: `status` inspects
a run's journal, `resume` re-runs from it.)

**Barrier vs barrier-free.** Prefer barrier-free staging (a `dag`, or the script `pipeline()`), where each item
streams through every stage independently. *Why it's the default:* a barrier-free pipeline's wall-clock is the
slowest single-item chain (find→verify for one item), **not** the sum of stages and not "slowest finder, then
slowest verifier." A barrier makes every lane wait for the slowest before any advances — if 5 finders run and
the slowest takes 3× the fastest, a barrier idles the 4 fast lanes for two-thirds of their time. So a barrier —
a `fanout()`, or a script `parallel()` whose results you collect before the next stage — is justified **only**
when a stage genuinely needs *all* prior-stage results at once: dedup/merge across the full set before expensive
downstream work, a zero-count early-exit ("0 findings → skip verification entirely"), or a stage whose prompt
compares one finding against all the others. It is NOT justified by "I need to flatten/filter the results first"
— a per-item transform needs only that item's own output, so it stays a barrier-free stage. (The
`parallel → transform → parallel` mistake and its one-pipeline rewrite is worked in `references/cookbook.md` §5.)
When in doubt, stay barrier-free.

**One composed run, inline.** A review that fans out, verifies each branch the instant its finder resolves, and
synthesizes the survivors — you launch it, then read back the report:

```bash
node scripts/ultracode-cli.js --progress --steps '[
  { "id": "sec",  "prompt": "Find security bugs in the changed files. Cite file:line; put them in `findings`." },
  { "id": "perf", "prompt": "Find performance bugs in the changed files. Cite file:line; put them in `findings`." },

  { "id": "sec_v",  "kind": "verify", "depends_on": ["sec"],  "findings_from": "sec",
    "skeptics": 3, "lenses": ["correctness", "security"],        "prompt": "verify" },
  { "id": "perf_v", "kind": "verify", "depends_on": ["perf"], "findings_from": "perf",
    "skeptics": 3, "lenses": ["correctness", "reproducibility"], "prompt": "verify" },

  { "id": "synth", "depends_on": ["sec_v", "perf_v"], "schema": null,
    "prompt": "Merge these verified findings into one report.\nSecurity:\n{{steps.sec_v.output}}\nPerf:\n{{steps.perf_v.output}}" }
]'
```

`sec_v` starts the moment `sec` resolves, while `perf` is still finding; only `synth` waits for both — the
barrier-free win, inline. The annotated version with its gotchas (a `verify` step's `findings_from` must also be
in its `depends_on`; its `output` is the surviving-findings array) and the `script` equivalent
(find → dedup-vs-seen → verify → synthesize) are in `references/cookbook.md` §1–2.

## Write worker prompts that return evidence

Workers are separate `codex exec` subprocesses that share no memory with you or each other. Two consequences
shape every prompt:

- **A worker's output IS its return value, not a message to a human.** Tell it to return raw data that
  satisfies the schema. By default a worker returns the `WORKER_SCHEMA` shape (`summary`, `findings[]`,
  `recommended_actions[]`, `risks[]`, `verification[]`, `confidence`); pass a custom `schema` to force a shape
  tuned to your task (worked example: `references/cookbook.md` §4), or `schema: null` for raw text.
- **Cross-stage context must be passed explicitly** — via `{{steps.<id>.output}}` tokens in a `dag`, or via
  the prompt string you build in a `script`. A worker knows only what its prompt contains.

Demand concrete evidence — "cite `file:line`", "name the failing command", "quote the offending code" — over
generic recommendations. For verification workers, prompt each skeptic to **refute, not confirm**: "Try hard to
refute this finding; if you cannot clearly confirm it is real and correct, set `refuted=true`."

## Quality patterns

These are building blocks, **not a closed menu** — invent novel harnesses (tournament bracket, self-repair
loop, staged escalation) when a task doesn't fit. Depth and caveats: `references/quality-patterns.md`. Runnable,
code-verified versions: `references/cookbook.md`.

- **Adversarial verify** — a finding must survive N skeptics prompted to refute it before you act or report; a
  strict majority of the *valid* refute votes kills it (an even split survives, and a finding whose skeptics all
  fail returns no valid verdict and is dropped — so a thin survivor set is suspect: check `events[]` for skeptic
  failures). The default verification pass. It costs skeptics × findings workers (3 × 40 = 120), so dedup and
  triage *before* you verify — verify findings, not raw noise. → cookbook §1–2
- **Perspective-diverse verify** — give each skeptic a distinct `lens` (correctness/security/reproducibility),
  not N identical reviewers.
- **Judge panel** — N attempts from different framings → blind parallel judges → synthesize from the winner,
  grafting the best ideas from the runners-up. Unlike adversarial verify there's no built-in judge primitive —
  run the judges as blind workers and pick the winner yourself in the parent.
- **Loop-until-dry** — keep spawning finders until K consecutive dry rounds. For no-repeat sweeps, use
  `loopUntilDry(..., { dedupeFindings: true })`; the prompt builder receives `(round, ctx, state)` with
  `state.seenList`, and repeat-only rounds count as dry. → cookbook §2–3
- **Multi-modal sweep** — parallel finders, each searching a different way (by-module/symbol/test/recent), blind
  to each other.
- **Completeness critic** — a final "what's missing?" worker whose output becomes the next round of work.
- **Loop-until-budget** — gate depth on `budget.remaining()`, wrapping the loop condition in `budget.total && …`:
  `remaining()` is `Infinity` when `--budget-tokens` is unset (and `budget.total` is then `null`), so an
  unguarded loop runs straight to the lifetime agent cap.

**Two traps:** dedup against everything *seen*, not against what *survived* (or a find→verify loop never
converges); and **no silent caps** — log/surface every drop, cap, and truncation (`--progress` / `status`).
