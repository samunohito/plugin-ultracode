upstream( https://github.com/just-every/plugin-ultracode )の実装を私用に調整したものです。 

- このリポジトリの内容を活用するために生じた事項について一切の責任を負いません
- このリポジトリについての確認などの問い合わせをupstreamに行うことは避けてください

---

# Ultracode Plugin for Codex

Part of the [Just Every Codex plugin marketplace](https://github.com/just-every/plugins).

Ultracode helps Codex take on work that is too broad, risky, or multi-step for
one thread to handle alone. It lets Codex break a task into focused parallel
lanes, compare the evidence, verify claims, and bring back a clearer answer or
implementation plan.

Use it when you want Codex to act less like one reviewer skimming a problem and
more like a coordinated team working through it from several angles.

![Codex running an Ultracode PR sweep with the live dashboard open](assets/screenshots/ultracode-pr-sweep-codex.jpg)

## What It Is

Ultracode is a Codex plugin for orchestrating many focused Codex workers on one
larger goal.

Those workers can inspect different parts of a codebase, review the same change
from different perspectives, verify each other's findings, explore multiple
solutions, or produce competing plans that Codex can synthesize into one clear
next step.

The result is not just "more output." The point is better coverage, better
verification, and less hidden single-thread tunnel vision.

## When To Use It

Reach for Ultracode when the task benefits from breadth, independent checks, or
parallel exploration:

- Reviewing a large or risky change.
- Auditing a subsystem for bugs, security issues, or missing tests.
- Finding every place a pattern, API, or behavior appears.
- Comparing multiple implementation strategies before committing to one.
- Investigating a confusing failure with several plausible causes.
- Asking for a final sign-off where false confidence would be expensive.
- Running a research pass that needs planning, gathering, verification, and
  synthesis.

For tiny, obvious edits, normal Codex is enough. Ultracode earns its keep when
you want coverage and confidence, not just a quick answer.

## What It Is Good At

**Parallel investigation.** Different workers can scan different files,
features, call sites, risks, or hypotheses at the same time.

**Independent review.** Workers can approach the same change through separate
lenses such as correctness, security, performance, tests, product behavior, or
maintainability.

**Adversarial verification.** Findings can be checked by skeptical reviewers
before they are treated as real.

**Complex workflows.** Larger tasks can be shaped as stages: plan, gather,
verify, synthesize, implement, then review.

**Visible progress.** Ultracode has a dashboard so you can see the work unfold:
which lanes are running, what they found, what failed, and what survived review.

## How To Ask For It

You do not need to know the internals. Ask Codex for the outcome and mention
Ultracode when the task deserves a wider pass:

```text
Use Ultracode to review this refactor for correctness, security, and missing tests.
```

Good prompts name the goal, the scope, and the kind of confidence you want.
Codex can choose the worker layout and verification pattern from there.

## Pair With Codex Goals

When Ultracode is invoked, Codex should always create a Codex goal whose
objective begins with `Use $ultracode to ...`. That goal is the continuity
mechanism: every continuation re-triggers the Ultracode skill, so the parent
thread keeps integrating worker results, applying or recommending changes, and
running final verification instead of stopping after the first summary.

Keep the goal active until the top-level outcome is genuinely settled:
synthesis is complete, any requested edits are integrated, failures or refuted
findings have been handled, and the final checks have run or been explicitly
reported as blocked. Only then should Codex clear the goal.

## What To Expect

Ultracode work usually has three visible parts:

- Codex shapes the workflow: what to split up, what to verify, and how results
  should come back.
- Workers run in parallel and return evidence-backed findings or plans.
- Codex synthesizes the useful results, applies or recommends changes, and runs
  the final verification.

The dashboard is there for transparency, not because you need to manage it by
hand. Failed or refuted lanes remain visible so Codex can treat them as real
signals instead of quietly smoothing them over.

## Install

Install Ultracode from the Just Every plugin marketplace:

```bash
codex plugin marketplace add just-every/plugins
codex plugin add ultracode@just-every
```

After installation, start a new Codex thread and ask Codex to use Ultracode on a
task that deserves parallel investigation.

## More Detail

Most users can stop here. The deeper docs are for maintainers, advanced
workflow authors, and plugin development:

- [docs/technical-reference.md](docs/technical-reference.md) for operational details, local commands,
  updates, and development notes.
- [skills/ultracode/SKILL.md](skills/ultracode/SKILL.md) for the Codex-facing orchestration guidance.
- [skills/ultracode/references/quality-patterns.md](skills/ultracode/references/quality-patterns.md) for verification patterns.
- [skills/ultracode/references/cookbook.md](skills/ultracode/references/cookbook.md) for workflow recipes.
- [skills/ultracode/references/cli.md](skills/ultracode/references/cli.md) for the complete technical reference.

## Workflow state storage

Run journals default to `<workflow cwd>/.codex/ultracode/runs/`; script source
snapshots live beside them in `scripts/`, and dashboard metadata in `ui/`.
Add `/.codex/ultracode/` to your project's `.gitignore` to exclude generated state.
Set the engine `state_dir` option, CLI `--state-dir`, or `ULTRACODE_STATE_DIR`
to select another root (precedence: explicit option > environment > cwd default).
Relative roots resolve against the workflow's cwd. Records persist an absolute
`state_dir`; status, resume, nested scripts, and the dashboard share that root.

`codex_home` / `--codex-home` and `CODEX_HOME` still select worker authentication
and configuration. State storage never changes a worker's `CODEX_HOME`. Saved
named workflow definitions may remain in `$CODEX_HOME/ultracode/workflows/`;
these reusable definitions are separate from per-run script snapshots. Plugin
update stamps also remain in Codex home.

Old journals are not automatically migrated. Read or resume them by selecting
their old root, for example:

```sh
node scripts/ultracode-cli.js status --state-dir "$HOME/.codex/ultracode"
node scripts/ultracode-cli.js resume --state-dir "$HOME/.codex/ultracode" --workflow-id RUN_ID
node scripts/ultracode-cli.js status --state-path /absolute/path/to/runs/RUN_ID.json
```

An explicit `--state-path` works from another cwd and binds writes and dashboard
lookup to the opened journal's root, including legacy or copied journals.

## Launcher initialization and dashboard recovery

For an installed plugin, resolve `../../scripts/ultracode-cli.js` relative to the
directory containing its `skills/ultracode/SKILL.md`, then invoke the absolute path
with `node`. An `ultracode` command on PATH is not required.

If worker stderr pairs `failed to open memories db at .../memories_1.sqlite` with
`failed to initialize in-process app-server client: Read-only file system (os error 30)`,
the parent sandbox may be blocking Codex initialization. If needed and allowed,
use host-approved escalation (`require_escalated`) for the Ultracode launcher,
while keeping worker `--sandbox read-only` (or its explicitly requested sandbox).
The diagnostic preserves original stderr and does not change permissions,
configuration, or authentication, or automatically retry escalation. Never copy
auth to tmp or overwrite `CODEX_HOME`. Arbitrary read-only project writes,
authentication errors, and general permission errors require their own diagnosis.

If the dashboard server stops, reopen the existing journal without executing workers:

```sh
node /absolute/plugin/root/scripts/ultracode-cli.js status --ui --state-path /absolute/path/to/runs/RUN_ID.json
```

This starts or reuses the dashboard; `resume` can execute workers and is unnecessary
for UI recovery. Use the returned `record.ui.url`. Check `record.ui.server_url + "/api/health"` from
the launcher host for server health, then check access in the intended browser.
A stored URL, `ui.ready`, or host health check alone does not prove browser
reachability. Do not infer why an old server stopped without evidence.
