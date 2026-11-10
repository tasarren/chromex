# Chromex Agent Guide
Follow the instructions of this file. Do not omit anything. Load every skill and companion mentioned.

Use memory-wiki's skill list, suggestion, search and load tools, including
companions. Use the local vault fallback when unavailable. Load local CCC and
TTT skills; FFF is supplied as MCP tools (no local skill was found).

- Do not ever read inside `node_modules/` or `dist/` folders to lookup for code.
- Directory `.orchestrator/` is for development purposes, like `.orchestrator/tmp` etc. It should not be referenced in
  project documentations or code.
- Use `skills/chrome-browser/SKILL.md` for browser interaction requests.
- Use `skills/chromex-development/SKILL.md` for repository changes, builds, installation, releases, and troubleshooting.
- Keep the codebase small. Test code stays hard limited below 15% of all code (a ceiling, not a target; lower is better) (the density report's "test share"). Test public
  contracts and bugs that actually happened, one test per behavior; never one test per invariant, and plans do
  not list invariants for tests. Before and after a task, run `pnpm check:code:density` and report the source and
  test lines it added. Follow the memory-wiki coding skills, not arbitrary per-task line limits. Prefer
  deleting code, standard infrastructure and existing dependencies over custom protocols.
- Never run inline scripts: no heredocs (`<<EOF`), `node -e`, `python -c`, `bash -c` or chained
  `&&`/`||`/`;` commands. Write the script to `.orchestrator/scripts/<topic>/<lang>/` (for example
  `.orchestrator/scripts/analysis/node/messages.mjs`), then run it; reuse an existing script first.
- Temporary files go in `.orchestrator/tmp/<topic>/`, never `/tmp`. This covers agent work and test
  suites. CI also run, so we should create
  `function getTmpDir() { return process.env.CI ? tmpdir() : PATH_TO_ORCHESTRATOR_FOLDER }` keep disposable fixtures in
  `mkdtemp(join(getTmpDir(), ...))`.
- Use the chrome-bridge-plugin for UI and playback verification, at 390, 1440 and 1920 px. Check only the behavior the change
  touches, in one round; put edge cases in offline tests. HTTP user-agent comparisons are diagnostics, not evidence of a
  real browser run.
- Keep current version `0.1.3` unless the owner explicitly requests a bump.
- Commit completed, verified checkpoints during authorized work. Review the staged diff, use descriptive commit
  messages, and record the relevant verification. This is the owner's standing workflow preference.
- Leave excluded recordings, research, and unrelated files untouched. Do not add ignore rules for those materials.

Read `docs/index.md` for the documentation map. Run `pnpm verify` from this directory before handing off code changes.

## Skills to load on start and reload after compaction

Read this file before editing after every compaction. Load the actual skill
content and the companions below, not only a router or search excerpt. User and
repository instructions override skill stack defaults (TDT uses node:test,
erasable ESM, pnpm, and version 0.1.3). Clarity outranks arbitrary file-size rules.

Load every skill with `wiki_skills { action: "load", slug, file? }`. Omit `file`
for `SKILL.md`; load each companion listed below by its `file`. If memory-wiki is
unavailable, read the same skill from `~/.agents/skills` (the vault is under `vault/`).
An unknown slug is not proof that a skill is missing: use the reply's near match.

Baseline for every code task:

| Slug                        | Companion files                                                                                                                                                                                                                                                                                            |
|-----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `memory-wiki`               | —                                                                                                                                                                                                                                                                                                          |
| `code-clarity`              | —                                                                                                                                                                                                                                                                                                          |
| `project-structure`         | —                                                                                                                                                                                                                                                                                                          |
| `workspace-config-patterns` | `SKILL.md`, `config-resolvers.md`, `dispatch-maps.md`, `narrow-exports.md`, `no-env-threading.md`                                                                                                                                                                                                          |
| `engineering-principles`    | `simplicity-first.md`, `type-safety.md`, `scope-discipline.md`, `anti-overengineering.md`, `anti-patterns.md`, `architecture/async-and-reliability.md`, `architecture/integration-patterns.md`, `architecture/pragmatic-layering.md`                                                                       |
| `coding`                    | `common/error-handling.md`, `common/safe-refactor.md`, `common/style.md`                                                                                                                                                                                                                                   |
| `typescript`                | `agent-loading.md`, `baseline-2026.md`, `style.md`, `typing.md`, `classes.md`, `modules-runtime.md`, `tsconfig.md`, `runtime-boundaries.md`, `api-design.md`, `errors.md`, `async.md`, `packages.md`, `tooling.md`, `security.md`, `testing.md`, `migration.md`, `anti-patterns.md`, `review-checklist.md` |
| `testing`                   | -                                                                                                                                                                                                                                                                                                          |
| `dry-refactoring`           | — (run the installed jscpd with `pnpm exec jscpd`, never npx)                                                                                                                                                                                                                                              |
| `how-to-communicate`        | -                                                                                                                                                                                                                                                                                                          |

Load by task:

| Task                  | Slug and companion files                                                                                                                                                                                                                                                |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Server, databases     | `backend`: `api-contracts.md`, `data-modeling.md`, `service-boundaries.md`                                                                                                                                                                                              |
| Web and UI            | `frontend`: `component-boundaries.md`, `forms-and-inputs.md`, `state-and-api-orchestration.md`, `ux-principles.md`, `ux-upgrade.md`, `frontend-agent.md`; `vue`: `component-patterns.md`, `composables-and-store.md`, `variant-owned-stores.md`; `typescript`: `vue.md` |
| Documentation         | `write-docs`: `structure.md`, `human-docs.md`, `llm-docs.md`, `code-comments.md`                                                                                                                                                                                        |
| Planning              | `productivity`, `brainstorming`.                                                                                                                                                                                                                                        |
| Docker                | `docker-compose`: `bootstrap.md`, `modularity.md`, `networking.md`, `volumes.md`, `secrets.md`, `validation.md`.                                                                                                                                                        |
| Code search and index | `ccc`: `references/management.md`, `references/settings.md`, `fff`                                                                                                                                                                                                      |
| Teammate messaging    | `ttt`                                                                                                                                                                                                                                                                   |

- FFF and CCC is an MCP toolset and CLI commands, not a skill: read its tool descriptions. Search short
  identifiers for content and short file names for discovery, then read the results.
- Verify UI with browser/viewport checks; verify storage, SSE and playback lifecycle with deterministic tests. |

Keep ccc current after significant source changes. Its index is scoped to package source, scripts, docs and root
configuration;
research assets remain untouched. Do not claim a fresh index without completion
evidence. FFF and rg remain available for direct source navigation.

## Engineering and communication

Discover current skill names through memory-wiki. If a returned reference cannot load, use its available vault companion
or local source and record that fallback.

Keep each operation followable. Split unrelated ownership, not files that are merely long.
Define each concept once, derive related types, validate external input at its boundary, and hold
dependencies in their owner instead of passing them unchanged through several functions.
Use native tools and existing dependencies before custom infrastructure. Remove superseded code
and empty scaffolding after checking consumers. Write direct instructions and distinguish observed
results from plans.

Record reusable findings, including web research and new tool behavior, in `.orchestrator/findings/`.
Include source paths or URLs, observed results and limits; mirror useful conclusions to memory-wiki.

Use the shared Harness ESLint rules configured here. Relative TypeScript source imports use `.ts`;
published package exports and emitted JavaScript retain their actual paths.

Run local commands directly with `pnpm`. The Dockerfile pins the reproducible verification tools;
do not route ordinary commands through `.orchestrator/scripts` toolchain wrappers.

Do not run inline scripts (`python -c`, `node -e`, or shell heredoc programs). Put reusable agent
scripts in `.orchestrator/scripts/<topic>/<lang>/` and invoke the saved file. Reuse or update an
existing script for the same check. Ordinary tool and CLI commands can run directly.

## Team work

- PLANNER owns scope, assignments, findings integration and owner communication. Delegate code
  implementation to CODER with exact paths, checks and a stop condition; do not implement it as PLANNER.
- Keep `ttt` traffic minimal. During an assigned CODER task, use one kickoff message with scope,
  paths, checks, and stop condition, then one completion handoff with evidence and review needs.
- ADVISOR supports owner-authorized design, planning, and review. PLANNER assigns bounded questions
  and integrates the findings. An ADVISOR review does not authorize implementation or publication.
- Send an intermediate message only for a blocker, a decision that changes scope, a file conflict,
  or a material finding that changes the task. Batch questions and corrections in the task thread.
- Do not send routine progress, receipt-only replies, duplicate handoffs, or status broadcasts.
  Follow required `ttt` read/ACK handling. An ACK is mailbox state, not another reply.
- Keep task state and evidence in local planning files. Do not poll teammates or use repeated
  screen captures as a progress feed. Wait for the assigned handoff when work depends on it.
- A prepared prompt does not start an agent or authorize work. Start CODER only when the owner
  authorizes execution and the coordinator assigns a task. Keep one writer per path.
- When HELPER is assigned, CODER and HELPER coordinate directly in one task thread. Agree exact
  file ownership, share concrete findings, and hand off completed changes. CODER owns combined
  verification; avoid PLANNER relay loops and overlapping installs, builds, or formatting runs.
- If CODER2 is available, it can parallelize work with CODER

Keep reviewed `.orchestrator/` plans, findings, and reusable scripts in local checkpoint commits for
now. Keep scratch, transcripts, credentials, and generated state excluded. History cleanup (Q10) is
deferred; decide planning visibility before any push. Planning and agent scripts stay outside product
packages and container contexts. Preserve owner edits and staged state during cleanup. Push and
publication require owner go.

Roadmaps are AI execution plans. Express effort only in agent turns, AI execution time, and token
usage; never human hours, days, or developer-time estimates. Label forecasts versus measurements,
cite their basis, and mark unavailable figures unmeasured. Record external waits and command
timeouts separately from effort. Do not invent conversions from human-time estimates.
