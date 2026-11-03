# Ultracode Technical Reference

This document keeps operational details out of the user-facing README. It is
for maintainers, advanced workflow authors, and anyone running Ultracode
directly from the plugin checkout.

For the complete flag and API surface, see
[skills/ultracode/references/cli.md](../skills/ultracode/references/cli.md).

## Local Execution

From this checkout, the local entrypoint is:

```bash
node scripts/ultracode-cli.js <input> [flags]
```

The execution command has no leading verb. The input shape selects the run type:

| Input | Use it for | Example |
| --- | --- | --- |
| Task sentence | Fixed-role fan-out | `node scripts/ultracode-cli.js "review the auth refactor" --workers 5` |
| `steps[]` JSON | Barrier-free staged workflows | `node scripts/ultracode-cli.js --steps '[{"id":"scan","prompt":"Find bugs. Cite file:line."}]'` |
| `workers_spec[]` JSON | Custom one-shot worker panels | `node scripts/ultracode-cli.js --workers-spec '[{"label":"sec","prompt":"Review security risks."}]'` |
| Workflow script | Dynamic loops, reductions, branching | `node scripts/ultracode-cli.js examples/deep-research.workflow.js --args '{"topic":"budgeting","mode":"code"}'` |
| `@name` | Saved `.claude/workflows` definitions | `node scripts/ultracode-cli.js @deep-research --args '{"topic":"Codex"}'` |

Lifecycle commands do use verbs:

```bash
node scripts/ultracode-cli.js status --workflow-id ultra-...
node scripts/ultracode-cli.js resume --workflow-id ultra-...
node scripts/ultracode-cli.js workflow list
node scripts/ultracode-cli.js workflow show deep-research
```

## Common Local Runs

Fixed-role review:

```bash
node scripts/ultracode-cli.js "review the pending diff for bugs and missing tests" --workers 4 --progress
```

Minimal `steps[]` workflow:

```bash
node scripts/ultracode-cli.js --steps '[
  {
    "id": "scan",
    "prompt": "Find correctness risks in this repo. Cite file:line and return findings."
  },
  {
    "id": "verify",
    "kind": "verify",
    "depends_on": ["scan"],
    "findings_from": "scan",
    "skeptics": 3,
    "prompt": "verify"
  }
]' --progress
```

Workflow script:

```bash
node scripts/ultracode-cli.js examples/deep-research.workflow.js --progress \
  --args '{"topic":"How does Ultracode resume work?","mode":"code"}'
```

## Updates

Plugin installs are snapshot-based. When opted in, Ultracode refreshes the
marketplace snapshot before commands, at most once every 24 hours, then
reinstalls the plugin for future Codex sessions. It is off by default because it
modifies the user's Codex home.

The current Codex thread keeps the version it already loaded. Start a new thread
after an update if you need the refreshed plugin code immediately.

Opt in to the automatic refresh with either:

```bash
ULTRACODE_AUTO_UPDATE=1 node scripts/ultracode-cli.js "review this change"
node scripts/ultracode-cli.js "review this change" --auto-update
```

## Dashboard

Execution runs and `resume` start a local dashboard automatically. With
`--progress`, the URL appears as a `ui.ready` event:

```bash
[ultracode] ui.ready UI ready at http://127.0.0.1:<port>/workflow/ultra-...
```

The dashboard reads the same journal files as `status`. It shows run state,
worker outputs, prompts, errors, phases, dependency lines, and run-level plus
worker-level model and reasoning settings.

Disable it when you only want JSON:

```bash
ULTRACODE_UI=0 node scripts/ultracode-cli.js "review this change"
node scripts/ultracode-cli.js "review this change" --no-ui
```

## Model Guidance

Choose worker model and reasoning by task complexity:

| Work type | Model | Reasoning |
| --- | --- | --- |
| High-volume or latency-sensitive | `gpt-5.6-luna` | `low` |
| Standard research or coding | `gpt-5.6-terra` | `medium` |
| Complex coding or reasoning | `gpt-5.6-sol` | `high` |
| Hard quality-first problem solving | `gpt-5.6-sol` | `xhigh`, `max`, or `ultra` |

For ChatGPT-authenticated Codex CLI, use `gpt-5.6-sol`, `gpt-5.6-terra`, or
`gpt-5.6-luna`; the API alias `gpt-5.6` is not available. GPT-5.6 accepts
`none`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` reasoning effort;
other models accept other values. Ultracode passes the value through and Codex
rejects an unsupported one with an error listing the accepted values.
Ultracode has no built-in model or reasoning default: unset workers inherit
`model` / `model_reasoning_effort` from the user's Codex config. Set them for a
whole run with `--model` and `--reasoning-effort` (for scripts, that is every
worker's default), or override individual workers and steps in
`workers_spec[]`, `steps[]`, or workflow scripts.

## Important Runtime Rules

Workers are independent Codex subprocesses. They do not share parent-thread
memory or each other's memory, so prompts must include the context and evidence
requirements they need.

Default workers are read-only. For parallel edits, use isolated worktrees so
each worker's diff is collected separately and can be reviewed before
integration.

Failed, timed-out, or refuted workers are real failures. Do not replace them
with guessed output; inspect the run record and fix the prompt, schema, inputs,
or workflow shape.

## Repository Map

| Path | What lives there |
| --- | --- |
| [scripts/ultracode-cli.js](../scripts/ultracode-cli.js) | CLI routing, lifecycle commands, auto-update, dashboard launch wiring |
| [scripts/ultracode-engine.js](../scripts/ultracode-engine.js) | Worker spawning, schemas, concurrency, budgets, journaled state, resume |
| [scripts/ultracode-script-runner.js](../scripts/ultracode-script-runner.js) | Imperative Workflow-script runtime |
| [scripts/app-server-client.js](../scripts/app-server-client.js) | Optional `codex app-server` transport client |
| [scripts/workflow-definitions.js](../scripts/workflow-definitions.js) | Saved workflow discovery and library operations |
| [skills/ultracode/SKILL.md](../skills/ultracode/SKILL.md) | Codex-facing guidance for when and how to use Ultracode |
| [skills/ultracode/references/quality-patterns.md](../skills/ultracode/references/quality-patterns.md) | Verification and discovery patterns |
| [skills/ultracode/references/cookbook.md](../skills/ultracode/references/cookbook.md) | Runnable workflow skeletons |
| [skills/ultracode/references/cli.md](../skills/ultracode/references/cli.md) | Full CLI and API reference |
| [examples/](../examples/) | Workflow scripts you can run or adapt |
| [test/](../test/) | Offline Node tests and mock Codex fixtures |

## Development

The test suite is offline and must use the mock Codex binary, not the real paid
CLI:

```bash
npm test
node --test test/plugin-updater.test.js
```

Run examples against the mock when you want to check orchestration without
spawning real workers:

```bash
CODEX_HOME=$(mktemp -d) \
ULTRACODE_STATE_DIR=$(mktemp -d) \
CODEX_CLI_PATH=test/fixtures/mock-codex.js \
ULTRACODE_UI=0 \
node scripts/ultracode-cli.js examples/parallel-reduce.workflow.js \
  --args '{"files":["a.js","b.js","c.js"]}'
```

Generated run state defaults to `<workflow cwd>/.codex/ultracode/runs/`.
Set `--state-dir` or `ULTRACODE_STATE_DIR` to choose the root containing
`runs/`, `scripts/`, and `ui/`; relative roots resolve against workflow cwd.
`CODEX_HOME` / `--codex-home` still selects worker authentication and configuration.
To read old journals, use `--state-dir <old codex home>/ultracode`.
Temporary
schemas, last-message files, and isolated worktrees are created under the OS
temp directory and should not become tracked files.
