# Deployment Brief — Agent Harness

**Audience:** you, the assistant who has been asked to deploy this system inside a corporate environment that the original author cannot see.
**Operator:** Josh. He is your gate for every decision marked **STOP**.
**Your mission:** discover what this environment offers, configure the harness to fit it, deploy it, and prove it works — without redesigning anything.

Read this entire brief before doing anything. Then work the phases strictly in order.

---

## Prime directives

These override anything else you conclude along the way.

1. **You are deploying an existing system, not designing one.** Do not modify files under `server/`, `public/`, or `roles/` to make deployment easier. If deployment seems to require a code change, that is a **STOP**: describe the conflict to Josh and wait.
2. **Work in phases with gates.** Each phase ends with a short written report to Josh. Do not start the next phase until he says go, except where a phase explicitly says you may continue.
3. **Discover, don't assume.** This brief deliberately does not tell you which commands to run, because the author doesn't know what platform you're on. When a phase asks a question about the environment, answer it by investigating: read the platform's documentation, inspect how an existing application in this organization is already deployed, examine available CLIs and consoles, or ask Josh. An answer of "I checked X and Y, and found Z" is acceptable. An answer you cannot trace to something you actually observed is not an answer — treat it as unknown.
4. **When uncertain, say so and stop.** A wrong guess in this system wastes money and creates confusing agent behavior. "I could not determine this" is always an acceptable finding.
5. **Never-do list** (no exception without Josh's explicit written approval):
   - Never run more than **one replica** of the harness.
   - Never expose the dashboard or API to a network without the organization's standard authentication in front of it.
   - Never place secrets in the container image, the repository, or a diagram/report.
   - Never grant the GitHub credential broader access than the specific repositories named in Phase 3.
   - Never switch agent sessions to a mode that bypasses permission checks entirely.
   - Never point the agents at a repository that people outside the team can write to.

---

## Phase 0 — Comprehension check

Read `README.md` in full. Then write Josh a summary, in your own words and under 300 words, covering:

- what the single container process does (three jobs),
- why the database is described as "a cache" and what the state repo is for,
- what happens when the platform kills the container mid-session,
- which two things only a human (or branch protection) may ever do.

If you cannot answer all four from the README, re-read it. Do not proceed on a partial understanding — every later phase depends on this mental model.

**Gate:** send the summary. Continue when acknowledged.

---

## Phase 1 — Environment discovery

Produce a findings table answering the questions below. For each: **the answer, how you determined it, and your confidence (high / medium / low)**. Low confidence is fine; invented confidence is not.

The most reliable technique: find one application this team or organization already runs, and study how it is deployed end to end — where its source lives, what builds it, what configures it, where its secrets come from, how it is reached. The harness should travel the same paved road.

**A. Platform shape**
1. What actually runs containers here, and what is the deployment unit (a manifest? a service definition? a pipeline that hides this from you)?
2. Can a service be configured to run **continuously** — not scaled to zero when idle, not request-driven only? How is that expressed here?
3. Can the replica count be **pinned to exactly one**? How?
4. When the platform stops or recycles a container, does the process get a termination signal and a grace period? How long?
5. Does the container's filesystem survive a restart? (Expected answer: no. If some persistent volume option exists, note it — it changes nothing in this design, but Josh will want to know.)

**B. Network**
6. Can a container here reach `api.anthropic.com` (Anthropic's API)? If egress is restricted, what is the process for allowing a destination?
7. Can it reach the organization's GitHub host over HTTPS for clone, push, and API calls?
8. How are internal web UIs normally exposed to employees, and what authentication sits in front of them (SSO proxy, gateway, VPN-only)? The dashboard must sit behind whatever that standard is.

**C. Secrets and identity**
9. Where do deployed applications get secrets at runtime here? (A secrets manager? Platform-managed environment variables? Something else?)
10. Is there an established pattern for **machine/service accounts in GitHub** (a bot user, organization-level tokens, an app)? What is the approval path to get one?
11. How does this organization authenticate to Anthropic — direct API keys, or some gateway/proxy in between? (If a gateway: note its endpoint and auth style; this is a **STOP** finding, because the Claude Code CLI inside the container must be configured to use it, and Josh needs to weigh in.)

**D. Tooling inside the build**
12. Can the image build install: Node 20+, git, the GitHub CLI, and the Claude Code CLI? If package installs from the public internet are blocked at build time, what is the sanctioned alternative (internal registry, artifact proxy)?

**Gate (STOP):** send the findings table. Flag anything answered with low confidence and anything on the never-do list that the environment seems to make difficult. Wait for Josh.

---

## Phase 2 — Decision mapping

Translate findings into a concrete deployment plan. Fill in this table — every row needs a value or an explicit "blocked, because…":

| Decision | Your value | Based on finding # |
|---|---|---|
| Deployment mechanism (what artifact you will produce) | | A1 |
| How "always on, never scale-to-zero" will be expressed | | A2 |
| How "exactly one replica" will be enforced | | A3 |
| Termination grace period setting | | A4 |
| How the dashboard will be exposed + what auth fronts it | | B8 |
| Where each secret will live (`ANTHROPIC_API_KEY` or gateway equivalent, `GH_TOKEN`) | | C9, C11 |
| How the image build gets its packages | | D12 |
| Egress approvals needed, if any | | B6, B7 |

Also list, by name, every environment variable you will set, with its source (see `.env.example` in the repo for the full reference: at minimum `STATE_REPO`, `GH_TOKEN`, the Anthropic credential, `PORT`, plus `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`).

**Gate (STOP):** send the plan. Wait for approval.

---

## Phase 3 — GitHub preparation

1. Obtain the machine identity per the organization's pattern (finding C10). Request access to exactly: the project repository/repositories Josh names, plus one new private repository you will create called something like `agent-harness-state`. Nothing broader.
2. Create that **state repository**: private, empty, with a default branch. Its purpose: the harness commits its database exports, session transcripts, and digests here. Confirm the machine identity can clone and push to it.
3. On every **project repository** the agents will touch, confirm with Josh that branch protection on the main branch requires a pull request and blocks direct pushes, and that merging requires a human approval for now. If protection is absent, request it — do not proceed with agents pointed at an unprotected repository.
4. Confirm the machine identity can: clone each project repository, push a branch to it, and open a pull request. Establish this by observation, not assumption — and if you create any test artifacts in a repository while doing so, clean them up and say what you created and removed in your phase report.

**Gate:** report repository names, the protection status of each, and what you verified the machine identity can do. You may proceed to Phase 4 once everything in this phase is green.

---

## Phase 4 — Build and deploy

1. Build the container image using the repository's `Dockerfile`, adapted **only** as required by finding D12 (e.g., pointing package installation at an internal registry). Any other Dockerfile change is a **STOP**.
2. Deploy per your approved Phase 2 plan: one replica, always on, grace period set, secrets injected from their approved source, dashboard behind the standard auth.
3. Before considering the deployment live, read the container's startup output. You are looking for three statements in order: a persistence line saying the state repo was found (not "DISABLED"), a line saying the dashboard and API are listening, and a line saying the orchestrator loop started. If any is missing or an error appears, diagnose from the logs and the README before touching configuration at random.

**Gate:** report the startup log lines (with anything sensitive redacted) and where the dashboard now lives.

---

## Phase 5 — Prove it works

Do not write test scripts for this phase. Prove the system through its own surfaces, the way an operator would, and capture what you observe:

1. **The dashboard answers.** Open it through the standard auth path. The masthead should show the loop lamp alive within a couple of minutes and the state lamp reading durable. If state reads ephemeral, the state repo configuration is wrong — fix before anything else.
2. **The loop survives doing nothing.** With an empty queue, confirm over ~15 minutes that the heartbeat stays fresh and that the state repository receives periodic checkpoint commits.
3. **A full round trip, on a sandbox.** Have Josh designate a low-stakes sandbox repository. Clone it into the harness's workspace per the README. From the dashboard, seed one deliberately tiny objective (for example: add a short project description to the README of the sandbox repo). Then watch — through the dashboard's queue, runs, live transcript, and the sandbox repo itself — for the chain the README describes: the PM produces a dev task; the dev produces a branch and a pull request; the reviewer leaves a real review. Note where the chain stops, if it stops, and what the transcript of the failing session says.
4. **The restart story holds.** With Josh's go-ahead, restart the harness through the platform's normal mechanism while nothing critical is mid-flight. After it returns: the dashboard should show the same queue and history as before, and the startup log should mention restoring from the state repository. If a task was in flight, it should reappear as queued rather than being stuck.
5. **The brakes work.** Pause from the dashboard; confirm no new session begins. Resume; confirm work picks back up.

**Gate (STOP):** report each of the five observations with evidence (what you saw, where). List anything that did not match this brief's expectations, however small.

---

## Phase 6 — Handover report to Josh

One document containing: the findings table (Phase 1), the final deployment configuration (Phase 2 as-built, secrets referenced by location, never by value), GitHub setup summary (Phase 3), verification evidence (Phase 5), every deviation from this brief with its reason, and a short "operations card": how to reach the dashboard, how to pause, how to restart, where the state repository is, and who to call (Josh) when the *Needs a human* strip lights up.

---

## If you get blocked

At any point, if you have tried two distinct approaches to a problem and both failed, stop. Write down: what you were trying to achieve, what you tried, exactly what you observed (verbatim errors included), and your best single hypothesis. Send that to Josh. Do not improvise around the never-do list, and do not modify harness source code to route around an environmental obstacle — surfacing the obstacle *is* the job.
