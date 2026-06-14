# Agent Harness

A role-based harness for running a team of Claude Code agents 24/7, with a web dashboard, built for **ephemeral container platforms** — no VM, no SSH, no persistent disk required. Five specialized agents — project manager, developer, code reviewer, QA, and comms — coordinate through a DuckDB task queue and a shared git history. One container, one process, one database file that survives restarts by checkpointing to GitHub.

**The adoption model:** teams don't merge this code into their projects. They deploy the harness (or share a deployment) and *point it at* their repos. A team customizes its agents by adding a `.agents/` folder to their own repo — role prompts, tool allowlists, model choices — the same way `.github/` customizes CI. The harness is the engine; the team's repo owns the agents' personality and rules.

The design follows Anthropic's published guidance on long-running agents, principally *Effective harnesses for long-running agents* (Nov 2025), *Harness design for long-running application development* (Mar 2026), and *Long-running Claude* (Mar 2026). The load-bearing ideas borrowed from those posts:

- Agents work in **discrete sessions with no memory of previous sessions**, so every session must re-orient from artifacts (git log, task payloads) and end by leaving clean artifacts for the next one.
- "Different agents" are **the same harness with different initial prompts**. Specialization lives in prompts and permissions, not separate codebases.
- **Git is the coordination, durability, and observability layer.** Agents commit constantly; the harness checkpoints its own state to git; you monitor by watching commits, PRs, and the dashboard.
- Agents need a **verifiable definition of progress** — acceptance criteria and test suites — or a 24/7 loop drifts.
- Structured state (DuckDB tables, JSON payloads, a strict result contract) is harder for a model to corrupt than freeform notes.

---

## Table of contents

1. [How it works](#how-it-works)
2. [Surviving an ephemeral platform](#surviving-an-ephemeral-platform)
3. [The five roles](#the-five-roles)
4. [The `.agents/` convention](#the-agents-convention)
5. [The task lifecycle](#the-task-lifecycle)
6. [The dashboard](#the-dashboard)
7. [API reference](#api-reference)
8. [Repository layout](#repository-layout)
9. [The database](#the-database)
10. [The session contract](#the-session-contract)
11. [Setup](#setup)
12. [Deploying on your org's container platform](#deploying-on-your-orgs-container-platform)
13. [Observability](#observability)
14. [Safety model](#safety-model)
15. [Costs and limits](#costs-and-limits)
16. [Design decisions and tradeoffs](#design-decisions-and-tradeoffs)
17. [Roadmap](#roadmap)

---

## How it works

```
        ┌────────────────── one container, one process ──────────────────┐
        │                                                                │
 you ───┼─→ web dashboard ─→ Fastify API ──┐                             │
        │   (public/)        (server/api)  │ seed / pause / retry        │
        │        ▲                         ▼                             │
        │        │ poll/SSE         ┌─────────────┐                      │
        │        └───────────────── │   DuckDB    │ ←──────────┐         │
        │                           │ tasks runs  │            │results  │
        │   tick loop ──claims────→ │   events    │            │         │
        │   (server/orchestrator)   └─────────────┘            │         │
        │        │                        │ checkpoint         │         │
        │        └──spawns──→ claude -p (headless session) ────┘         │
        │                      role prompt + task payload                │
        └──────────────│──────────────────│──────────────────────────────┘
                       │ code commits/PRs │ state exports, logs, digests
                       ▼                  ▼
              GitHub: project repos   GitHub: state repo
                       └───── the durable layer ─────┘
```

A single Node process does three jobs:

1. **Serves the dashboard and API** (Fastify + static files) — always responsive, even mid-session.
2. **Runs the tick loop**: claim the highest-priority runnable task per role, spawn one headless Claude Code session for it, parse the structured result, record the run, create the follow-up tasks the agent declared.
3. **Checkpoints state to git** after every run, on a timer, and on SIGTERM.

The orchestrator is deliberately dumb — routing is a SQL query. All intelligence lives in role prompts; all state lives in DuckDB and git. If you're adding cleverness to the loop, it probably belongs in a role prompt instead.

## Jira as the task input (setup wizard)

Jira is an **input/output surface over the local queue**, not the queue itself. The local DuckDB queue stays the fast, auditable, restart-survivable coordination store; Jira is where your team works. A setup wizard in the dashboard connects them.

**The wizard** (three steps: connection → credentials → scope) captures your Jira Cloud base URL, account email, API token, project key, and an optional issue filter (JQL). It persists everything except the token as plain config; the **token is sealed** (see below). A "Test connection" step calls Jira's `/myself` to confirm it works.

**Write-back mode (runtime toggle in the UI)** — choose how agent progress appears on the board, and change it anytime: *Comment* posts milestone comments and results on the parent issue (clean board); *Sub-task* turns substantive agent tasks (dev/reviewer/qa) into Jira sub-tasks under the parent, with further events commented on the parent to avoid spam.

Each tick the loop pulls matching issues into the queue (deduped by issue key) and reflects progress back per the active mode — all non-fatal, so if Jira is unreachable the agents keep working locally and sync resumes when it returns.

**Adapt to your instance:** the JQL filter, the sub-task issue-type name, and status transitions depend on your project's configuration. Defaults target Jira Cloud REST v3 with email + API-token basic auth; Data Center auth differs, and status transitions need your instance's transition IDs (left as comments rather than guessed). Verify write-back against your instance before relying on it.

## Storing the Jira API token safely

The wizard captures the token, but it is **never written in plaintext**. It's sealed with AES-256-GCM using a key derived from a master secret your environment provides (`HARNESS_SECRET_KEY`, from your secret manager). Only the ciphertext is stored — in the settings table, checkpointed to the git state repo — so the repo never holds a usable credential. This is verified end to end: a fresh boot restores and decrypts the token to make live Jira calls, yet the plaintext appears nowhere in git. **Fail-safe:** if `HARNESS_SECRET_KEY` is unset, the harness refuses to store the token rather than writing it in the clear. The stricter alternative is to supply the token via the `JIRA_API_TOKEN` env var, which is used without ever persisting a copy and takes precedence if both are present.

## Task dependencies as a DAG (with audit + reuse)

A task can depend on many others, not just one. A planner (the PM, or a team's lead — see roadmap) emits tasks with local handles and dependencies; the orchestrator runs a task only when **all** its upstream tasks are done, so independent branches (front-end and back-end work) run in parallel and converge at a shared node (e.g. QA). If you've used Airflow or dbt, it's the same shape — except here an LLM authors the graph, so every graph is validated before anything is queued: **cycles and dangling dependencies are rejected** (surfaced to the human, not silently mangled), and a node whose dependency reached a terminal-failed state is flagged as **deadlocked** on the needs-human surface.

**Every run-DAG is saved as a named, auditable artifact.** Naming convention: `dag-<YYYYMMDD>-<HHMMSS>-<objective-slug>-<shortid>.json`, committed to git under `data/dags/`. The artifact records the objective, every node (role, title, payload, dependencies by local key), the topological execution order, and this run's key→task-id mapping — so you can audit exactly what graph ran and when. Because the graph is captured by local key, a saved DAG can be **replayed as a template** for a new objective (`POST /api/dags/:file/replay`) without re-planning. The dashboard's DAG view shows each node's live status and any deadlocks.

## Commit volume: telemetry sink vs. durable state

Git was doing two jobs — durable state checkpoints (a good fit) and high-frequency forensic flushing every ~45s (which churned the repo). v0.5 splits them:

- **Durable state** (DB parquet export, digests, completed transcripts, DAG artifacts) → **git**, on events only: run completion, settings change, gap recorded, DAG materialized/replayed, SIGTERM, and a slow periodic safety net. Low commit volume.
- **High-frequency telemetry** (the heartbeat/continuity chain and in-flight partial transcripts) → a **telemetry sink** (`TELEMETRY_DIR`), flushed often and cheaply, with no git history.

In production, point `TELEMETRY_DIR` at a **mounted bucket** (GCS via gcsfuse, S3 via CSI/s3fs). The platform handles bucket auth on the mount, so no SDK and no credentials live in the app, and the sink absorbs the frequent writes while git stays quiet. Locally it defaults to a directory under `data/`. If you run in an ephemeral container *without* a configured sink, you keep the live forensic view but lose mid-session transcript granularity on a hard crash — so configure the bucket in production. Verified: with a sink configured, idle beating produces **zero** git commits, versus a commit every 45s before.

## Metadata-driven roles

Roles are discovered, not hardcoded. The harness reads whatever role definitions exist under `roles/` (and a project's `.agents/roles/` overrides at spawn time), and the runnable role order is configurable via `ROLE_ORDER`. Adding a new role — a `sec-reviewer`, a `data-migration` specialist, a `tech-writer` — is a matter of declaring it, not changing harness code. (A richer metadata schema and **teams** — a named group with a purpose and a planning "lead" role that decomposes the team's work into a DAG for its members, while routing stays deterministic — are the next increment; that team model is a deliberate differentiator from swarm/delegation frameworks.)

## Planning for PostgreSQL (not yet implemented)

DuckDB-in-RAM is ideal for the active queue but caps long-term history at container memory. The seam for a future Postgres tier is the data-access layer in `db.js`: task/run/event/dag reads and writes already go through named functions rather than inline SQL scattered across the codebase. The intended evolution is a storage interface (TaskStore/RunStore/EventStore) with two adapters — DuckDB (active, in-memory) and PostgreSQL (durable history, compliance, analytics) — so millions of historical records offload to Postgres without touching orchestration logic. This is **planned, not built**: the abstraction boundary exists; the Postgres adapter is future work, to be added when volume warrants it.

## The dashboard (React + TypeScript)

The dashboard is a Vite + React + TypeScript app under `web/`, built to `public/`, which the server serves as static files. The server is unchanged by this — the API is the only contract between them.

**The enterprise-component seam.** Everything visual routes through one file: `web/src/ui/primitives.tsx` (Panel, Button, Chip, Lamp, Info tooltip, Table, SegmentedControl, TextInput, Dialog, Banner). Feature components import their building blocks only from there — never raw HTML or a specific library. To adopt your internal enterprise React components when you deploy, reimplement those ~10 primitives against your design system, keeping the same prop signatures; the whole dashboard inherits it and no feature code changes. The default look lives in `web/src/theme.css`, which your design tokens largely replace.

Structure: `api/` (typed client + response types, plus a mock mode), `hooks.ts` (polling), `ui/` (the seam), `features/` (Masthead, panels, DagView, Continuity lock-graph, dialogs), `App.tsx` (composition).

**Build step.** The frontend now requires a build (previously it was no-build vanilla JS). Locally: `npm --prefix web install && npm --prefix web run build`. The Dockerfile does this in a dedicated stage and copies the result into `public/`. In a locked-down corp network the build stage needs access to your npm registry (or a vendored/offline install) — the same package-registry access the deployment brief has you confirm.

**Backend-free development.** Append `?mock=1` to the URL to run the entire dashboard against built-in mock data with a scenario switcher (alive / mixed / first-run). This lets the team build against your enterprise components before the server is wired.

## In-memory database

The DuckDB database runs **in memory** by default — no database file on disk. The git state repo (parquet export) is the sole persistence: boot restores RAM from the last export, checkpoints export back. The durability window is one checkpoint (after every run, every `CHECKPOINT_MINUTES`, and on SIGTERM), so a hard crash loses at most one in-flight session's metadata — never committed code, which lives in project repos. Set `HARNESS_DB` to a path only for disk-backed local dev.

## What survives a crash, and seeing the gap (continuity)

A crash has a deliberately narrow blast radius, and the dashboard makes any discontinuity visible.

**What's recoverable:** completed checkpointed runs (rows, summaries, costs, follow-ups, events are in the last checkpoint); code the agent pushed (in the project repo, independent of the harness); and **an interrupted session's transcript** — while a session runs, its growing transcript is committed to the state repo every `ARTIFACT_FLUSH_MS` (default 45s), so a crash mid-session still leaves a readable trail up to the last flush. On reboot, transcripts are restored and the interrupted task is requeued (its WIP commits survive on its branch).

**What's genuinely lost:** the tail of an interrupted session between its last flush and the crash, and at most one run's metadata if the crash lands between a run finishing and its checkpoint. Both requeue and rerun.

**The continuity panel (lock-graph).** An independent heartbeat writes a marker every `CONTINUITY_INTERVAL_MS` (default 30s), independent of the tick loop — so a long session does *not* look like a gap. The chain is committed to the state repo, surviving restarts. The dashboard renders it as a chain: solid green where continuous, a broken link (🔓) where it went silent longer than the threshold. Each gap is listed in a **ledger** with start/end, duration, whether it ended in a restart, and — the forensic payoff — **the sessions mid-flight when it began, each linking to its recovered partial transcript.** That turns "something crashed at some point" into "here's the exact window and the session that fell into it, and here's how far it got."

**The gap threshold is editable in the UI** (default ~4 missed beats), stored in settings and checkpointed. A note on commit volume: flushing transcripts and the continuity chain frequently means frequent state-repo commits during active work; the flush only runs while a session is in flight, which bounds it, but transcript retention (rotation/squashing) is the natural follow-up before long-term running — see the roadmap.

## Surviving an ephemeral platform

Your container's filesystem is disposable. GitHub is not. So GitHub is the system of record for everything:

| What | Where it survives |
|---|---|
| Code the agents produce | Project repos — agents commit and push constantly (WIP included) |
| Harness state (queue, runs, events, settings) | **State repo** — DuckDB exported to parquet and committed on every checkpoint |
| Digests and session transcripts | State repo, alongside the export |
| The DuckDB file itself | Nowhere — it's a cache, rebuilt from the last export on every boot |

The cycle:

- **Boot**: clone the `STATE_REPO`, `IMPORT DATABASE` from the last export into a fresh DuckDB file, run idempotent schema creation, then **sweep stale tasks** — anything stranded `in_progress` by the previous container goes back to `queued`.
- **Runtime**: `checkpoint()` after every completed run, every `CHECKPOINT_MINUTES` (default 15), and on demand from the dashboard. A checkpoint = atomic export swap → commit → push. No changes, no commit.
- **Shutdown**: platforms send SIGTERM before recycling; the handler takes a final checkpoint.

**Blast radius of a surprise restart:** at most one in-flight session. Its task gets requeued by the sweep, and because the dev role commits WIP before stopping, little real work is lost — the retry session resumes from the branch. This is the same shift-handoff logic Anthropic applies between context windows, applied between containers.

If `STATE_REPO` is unset (local dev), everything still runs; state just lives in the `data/` volume.

## The five roles

| Role | Writes code? | Creates tasks for | Key power | Key restriction |
|---|---|---|---|---|
| **pm** | No | dev, comms | Decomposes objectives into small verifiable tasks | Read-only on repos; ≤10 tasks per session |
| **dev** | Yes | reviewer | One task → one branch → one PR | Never merges; never touches main |
| **reviewer** | No | dev (changes), qa (approved) | Approves / requests changes on PRs | Must run tests locally before approving |
| **qa** | No (scratch scaffolding only) | dev (defects) | End-to-end verification as a skeptical user | Files defects, never fixes them |
| **comms** | No | pm (only, relaying humans) | Writes the digest; the only human-facing agent | Summarizes, never decides |

Each role is two files: `CLAUDE.md` (identity, ritual, hard rules — persuasion) and `config.json` (tool allowlist, permission mode, max turns, optional model — enforcement). A dev agent that hallucinates a desire to merge still can't: `gh pr merge` isn't on its allowlist and branch protection wouldn't accept its approval anyway.

## The `.agents/` convention

Default role definitions live in this repo under `roles/`. A team overrides them by committing to **their own project repo**:

```
their-project/
├── .agents/
│   └── roles/
│       ├── dev/
│       │   ├── CLAUDE.md      ← their conventions: "we use pytest, conventional commits, ..."
│       │   └── config.json    ← their allowlist, their model choice
│       └── qa/
│           └── ...            ← override only the roles you care about
├── CLAUDE.md                  ← regular Claude Code project file; loads too (sessions run in the repo)
└── src/ ...
```

Resolution per task: if `workspace/<project>/.agents/roles/<role>/CLAUDE.md` exists, it wins; otherwise the harness default applies. Role definitions ride the team's own version control — reviewed in their PRs, versioned with their code — while the harness engine stays centrally upgradable. This is the mechanism that makes "teams adopt this for their projects" real without forking.

## The task lifecycle

```
human (dashboard): "Add CSV export to the reporting API"   → pm task
   └─ pm session reads the repo, plans
        ├─ dev task: "Add /export/csv endpoint"     each payload carries
        ├─ dev task: "Stream large result sets"     acceptance criteria
        └─ dev task: "Add export button to UI"
              └─ dev session: branch → code → tests → PR
                    └─ reviewer task: "Review PR #41"
                          ├─ request changes → dev task (back to dev)
                          └─ approve → qa task: "Verify CSV export E2E"
                                ├─ pass → event logged, done
                                └─ fail → dev task with exact repro steps
comms: drains events → digest → dashboard event feed + digest file
```

States: `queued → in_progress → done | failed | blocked | cancelled`. A failed run requeues the task until `max_attempts` (default 3) is exhausted, then it parks as `failed` and surfaces in the dashboard's **Needs a human** strip — as do `blocked` tasks. Humans answer by retrying, cancelling, or seeding a new PM objective with their decision.

## The dashboard

Served at `/` by the same process. Phase 1 is deliberately **observe everything, control little**:

- **Masthead lamps** — loop heartbeat (pulsing = alive, amber = paused, red = stale), state durability (durable vs. ephemeral), plus Pause/Resume and Checkpoint-now.
- **Needs a human** — blocked and exhausted-failed tasks, pinned at the top. This is the human-in-the-loop inbox and the screen that matters most.
- **Give the team work** — seed an objective; it always goes to the PM role.
- **Queue** — open tasks with role-colored spines, retry/cancel actions.
- **Recent runs** — result, turns, timing, and a **live transcript viewer** (SSE tail of the session log — the replacement for SSH'ing in to watch an agent think).
- **Event feed** — PRs opened/approved, defects, alerts, digests.
- **Costs by role** — runs, success rate, dollars.

It's a no-build vanilla JS page (no CDN dependencies — corp-network safe), polling every 5s. The API is the contract; swapping in a React front end later touches nothing server-side.

Phase 2/3 (see Roadmap): approval gates as actionable cards, role-config editing with versioned changes — behind corp SSO.

## API reference

| Method | Path | What |
|---|---|---|
| GET | `/api/status` | paused flag, heartbeat, persistence mode, queue summary, costs by role |
| GET | `/api/tasks?status=&limit=` | tasks, newest first (or by priority when filtered to `queued`) |
| POST | `/api/tasks` | seed an objective `{title, project?, role?='pm', payload?}` |
| POST | `/api/tasks/:id/retry` | requeue a failed/blocked task |
| POST | `/api/tasks/:id/cancel` | cancel a queued task |
| GET | `/api/runs?limit=` | recent sessions with summaries, turns, cost |
| GET | `/api/runs/:id/log` | full transcript (plain text) |
| GET | `/api/runs/:id/stream` | **SSE** live tail of a transcript |
| GET | `/api/events?limit=` | event feed |
| GET | `/api/roles` | default role configs + instructions (read-only) |
| POST | `/api/control/pause` · `/resume` | gate the tick loop (running session finishes first) |
| POST | `/api/control/checkpoint` | force a state checkpoint to the state repo |

No auth is built in — see [Safety model](#safety-model).

## Repository layout

```
agent-harness/
├── README.md
├── Dockerfile                 ← node:20 + git + gh + Claude Code CLI, non-root
├── docker-compose.yml         ← local dev runner (prod = your org's platform)
├── .env.example
├── package.json               ← fastify, @fastify/static, @duckdb/node-api
├── server/
│   ├── index.js               ← boot: restore → import → schema → sweep → serve + loop
│   ├── orchestrator.js        ← the tick loop (boring on purpose)
│   ├── spawn.js               ← role resolution (.agents), prompt build, headless sessions
│   ├── api.js                 ← REST + SSE
│   ├── db.js                  ← DuckDB access layer (this process is the only writer)
│   ├── persist.js             ← git state repo: restore on boot, checkpoint on change
│   └── schema.sql             ← tasks / runs / events / heartbeats / settings
├── public/                    ← the dashboard (index.html, app.js, style.css; no build step)
├── roles/                     ← DEFAULT role definitions (teams override via .agents/)
│   ├── pm/  dev/  reviewer/  qa/  comms/        each: CLAUDE.md + config.json
├── scripts/
│   ├── init-db.js  seed-task.js  status.js      CLI equivalents of the UI
│   └── agent-db.js                              narrow read interface agents may call
├── data/                      ← ephemeral: DuckDB cache, logs, digests, state clone
└── workspace/                 ← ephemeral: project repos, re-cloned on boot
```

## The database

One DuckDB file (`data/harness.duckdb`), five tables — **a rebuildable cache** of the state repo's last export:

- **tasks** — the queue. `role`, `title`, JSON `payload`, `status`, `priority`, `blocked_on`, `attempts/max_attempts`, `project`. The payload is the handoff: PM puts acceptance criteria in it, dev puts the PR URL in the reviewer task it creates, QA puts repro steps in defect tasks.
- **runs** — one row per session: timing, exit code, the agent's own summary, turns, cost, transcript path.
- **events** — human-facing notes: `pr_opened`, `pr_approved`, `defect`, `alert`, `digest`, `info`.
- **settings** — runtime knobs (currently `paused`); grows with UI phase 3.
- **heartbeats** — loop liveness for the masthead lamp and external monitoring.

Why DuckDB still, given the ephemerality: zero administration, full SQL for the comms agent / the API / you, native `EXPORT DATABASE`/`IMPORT DATABASE` for the checkpoint cycle, and a single-writer model that matches the architecture exactly — this process is the only writer, so DuckDB's single-writer constraint costs nothing. Agents never open the file; they request writes through their `RESULT_JSON` output, and read through `scripts/agent-db.js`.

## The session contract

Every session, regardless of role:

**Input** — the orchestrator resolves the role definition (`.agents/` override or default), embeds its instructions plus the task payload into the prompt, and runs Claude Code headless with the role's allowlist, permission mode, turn ceiling, and optional model. Sessions run inside the project repo, so the repo's own `CLAUDE.md` (team conventions) loads naturally alongside.

**Output** — the session must end with one line:

```
RESULT_JSON: {"status":"done|failed|blocked","summary":"one paragraph",
  "new_tasks":[{"role":"reviewer","title":"Review PR #41","payload":{"pr":"https://..."}}],
  "events":[{"kind":"pr_opened","message":"PR #41: CSV export","url":"https://..."}]}
```

Declaring `new_tasks` is the only way agents cause each other to act. The orchestrator validates and inserts the rows. Garbage or crashed output → the task requeues, `attempts` ticks toward the cap, exhausted tasks park as `failed` for a human. This contract is the harness's version of Anthropic's `claude-progress.txt`: a structured artifact at every boundary, because the next session remembers nothing.

## Setup

### Prerequisites

- Anywhere Docker runs (locally) or your org's container platform (prod).
- Network egress to `api.anthropic.com` and your GitHub Enterprise host.
- A GitHub **machine user / fine-grained PAT** scoped to: the project repos the agents may touch, plus one private **state repo**.
- Anthropic auth for the container — check current Claude Code docs for the method matching your org (API key vs. enterprise auth): <https://docs.claude.com/en/docs/claude-code>

### Local run

```bash
git clone <this-repo> && cd agent-harness
cp .env.example .env                     # ANTHROPIC_API_KEY, GH_TOKEN, STATE_REPO (optional locally)
git clone <a-target-repo> workspace/<repo-name>
docker compose up -d --build
open http://localhost:8080               # seed an objective from the dashboard
```

### GitHub configuration (do not skip)

The role separation is only real if GitHub enforces it:

- **Branch protection on main** in every agent-touched repo: require PR review, require status checks, no direct pushes. This is what makes "dev never merges" true even when a prompt fails.
- Machine user: `contents:write` + `pull_requests:write` on agent repos and the state repo, **nothing else**.
- Keep **human merge approval** initially; treat the reviewer agent's approval as advisory until trusted.
- Create the state repo empty and private; first checkpoint populates it.

## Deploying on your org's container platform

Five platform requirements, all common asks:

1. **Exactly one replica.** The process is the single DB writer and single task-claimer. Two replicas = duplicated work and corrupted coordination. If your platform insists on an autoscaler, pin min=max=1.
2. **No scale-to-zero.** The tick loop must stay alive between requests. Request always-on / min-instances=1. (The dashboard receiving traffic usually keeps request-scaled platforms warm, but don't rely on it.)
3. **SIGTERM grace period** of 30–60s, so the shutdown checkpoint can push.
4. **Egress** to `api.anthropic.com` and your GitHub host.
5. **Secrets** (`ANTHROPIC_API_KEY`, `GH_TOKEN`) from your org's secret manager, not baked into the image.

CPU/memory: 1–2 vCPU, 2–4 GB is plenty at `MAX_CONCURRENT=1`. The expensive thing is tokens, not compute.

**Workspace bootstrapping note:** repos under `workspace/` are ephemeral too. Cleanest pattern: a small entrypoint addition (or first-boot task) that clones the configured project repos before the loop starts. Until then, the dev role's session ritual (`git fetch`, checkout) handles freshness once a clone exists. See Roadmap.

## Observability

In order of how often you should look:

1. **The dashboard** (ambient) — needs-human strip, queue, runs, live transcripts, costs.
2. **GitHub** (ambient) — commits, PRs, review comments; the system narrates itself through descriptive commit messages, which the dev role is required to write.
3. **The state repo** (occasional) — checkpoint history is a time machine of harness state; transcripts and digests are committed there, so nothing needs SSH.
4. **Liveness for your monitoring stack** — `GET /api/status`; alert if `lastHeartbeat` is stale or the endpoint stops answering.

## Safety model

Layered, because any single layer will eventually fail:

| Layer | Mechanism |
|---|---|
| Prompt | Hard rules per role (no merges, no scope creep, no code edits for non-dev roles) |
| Harness | Per-role tool allowlists, `--max-turns` ceilings, per-session timeout, poison-task attempt caps |
| Process | Single writer, serial execution by default, pause gate honored before every claim |
| Container | Non-root user, resource fences, no secrets in image |
| GitHub | Branch protection, narrowly-scoped machine token, human merge gate |
| **Network** | **The API/dashboard has no built-in auth — keep it behind your org's ingress + SSO.** The pause/seed/retry endpoints are mild today, but phase 3 (config editing) must not ship before SSO is in front. |

Anthropic's guidance is blunt that autonomy compounds errors — sandbox aggressively, add guardrails before scaling. Two specifics for unattended operation: the configs default to `acceptEdits` rather than blanket permission-skipping (Claude Code's newer "auto mode," announced Mar 2026, is positioned as the safer option for this — check current docs and choose deliberately), and **treat everything agents read as untrusted input** — repo content, issues, PR comments can all carry prompt injection. Keep the machine token's blast radius small; don't point agents at repos strangers can write to.

## Costs and limits

Every run records `cost_usd` and `num_turns` when the CLI reports them; the dashboard's cost panel and one SQL query give you the picture. Levers:

- `MAX_CONCURRENT=1` (default) — serial is slower but predictable. Before raising it: git worktrees per session, or two devs in one checkout will degrade each other (Anthropic recommends worktrees for exactly this).
- `maxTurns` per role — comms needs 25, dev needs 80. Tune from real `runs` data.
- `model` per role in `config.json` — cheaper model for comms digests, strongest for dev.
- `POLL_INTERVAL_MS` — an idle harness costs ~nothing; sessions are the spend.
- `CHECKPOINT_MINUTES` — more frequent = smaller restart blast radius, more state-repo commits.

## Design decisions and tradeoffs

**Why git as the durability layer instead of a managed database?** Because it's the one durable, permissioned, audited store every team here already has. State checkpoints get history, diffs, and rollback for free, and the harness needs zero extra infrastructure approvals. The tradeoff — checkpoint granularity (you can lose up to one run's worth of harness metadata, never code) — is acceptable because the expensive artifacts live in project repos, pushed continuously by the agents themselves.

**Why is the DB a cache and not the truth?** On an ephemeral platform something must be rebuildable. Making the *database* the rebuildable thing and *git* the truth inverts the usual arrangement, but matches reality: the platform can kill the container; nobody can kill GitHub without you noticing.

**Why one process for UI + loop?** The single-writer constraint. A separate UI service writing to the harness DB would need a network DB (goodbye DuckDB simplicity) or IPC (complexity). One process, one writer, and the UI is a thin client of the API. If the UI ever needs independent scaling, that's the moment to revisit — not before.

**Why a queue in DuckDB instead of agents messaging each other?** Direct agent-to-agent chatter is unauditable and easy to corrupt. A SQL table is durable, inspectable, and gives the whole system state in one query. The asynchrony also matches the session model: dev finishing at 02:14 doesn't need the reviewer awake at 02:14.

**Why is the orchestrator not an agent?** Determinism where determinism is cheap. Routing is `SELECT ... ORDER BY priority LIMIT 1`; spending tokens on it buys nondeterminism. Anthropic's own harness demos use plain loops as the outer shell.

**Why a no-build dashboard?** Adoption friction and corp networks. No CDN, no node build chain, nothing to approve. The API is the real product; a React front end can replace `public/` without touching the server.

## Roadmap

- [ ] **Workspace bootstrap** — declarative repo list (env or settings) cloned on boot; removes the manual `git clone` into `workspace/`.
- [ ] **Comms scheduling** — daily digest trigger in the tick loop (e.g. seed a comms task when none ran in 24h).
- [ ] **Approval gates** — tasks that pause for explicit human sign-off in the UI before dispatch (the real killer feature for corp adoption).
- [ ] **Phase 3 controls** — role config editing with versioned changes + audit trail, behind corp SSO. Not before SSO.
- [ ] **Per-project dashboards** — filter every panel by `project` once multiple teams share a deployment.
- [ ] **Worktree-based concurrency** — prerequisite for `MAX_CONCURRENT > 1`.
- [ ] **Agent SDK migration** — replace CLI shelling in `spawn.js` with the Claude Agent SDK for a typed interface; also verify current CLI flags (`--output-format`, `--permission-mode`, `--allowedTools`, `--max-turns`, `--model`) against installed version before first run.
- [ ] **Transcript retention policy** — cap/rotate logs committed to the state repo before they bloat it.

---

*Sources worth reading end-to-end: Anthropic Engineering — "Effective harnesses for long-running agents" (Nov 2025), "Harness design for long-running application development" (Mar 2026), "Building agents with the Claude Agent SDK" (Sep 2025), "Building effective agents" (Dec 2024); Anthropic Research — "Long-running Claude" (Mar 2026). Claude Code docs: <https://docs.claude.com/en/docs/claude-code/overview>.*
