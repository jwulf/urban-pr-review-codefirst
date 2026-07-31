# urban-pr-review-codefirst

The **code-first** expression of [urban-pr-review](../urban-pr-review): a durable,
multi-round loop that drives a GitHub PR to convergence against an automated
reviewer, escalating to a human when the reviewer is stuck or a round cap is hit.

The model-first app draws this loop in `convergence-loop.bpmn`. Here the same loop
is written with the `@nanobpm/workflow` declarative surface (`defineFlow`, ADR
0044/0045). The SDK derives the executable BPMN (with DI), the job types, and the
message names — no diagram, no task-type wiring, no correlation plumbing.

**Feature parity with the model-first app.** This app persists to the same SQLite
schema and serves the same schema-driven web frontend as
[urban-pr-review](../urban-pr-review) — the two run identically. The only
difference is *how* the loop and its record steps are expressed: model-first draws
them (`convergence-loop.bpmn` + `workers/*/worker.ts`), code-first writes them
(`workflows/convergence-loop.ts`, with the record steps hosted in-process). See
[Persistence](#persistence) and [Frontend](#frontend) below.

## HOWTO: run agents that converge PRs for you, all day

### The problem this solves

Driving a PR to convergence is mostly *waiting*: open a review, wait 5–15 min for
the reviewer, address the comments, re-request, wait again — often ten rounds
deep, escalating to a human only when the reviewer is stuck. If a single agent
babysits one PR, it spends almost all of its time **idle-polling** a review that
hasn't landed yet. That is wasted wall-clock and a wasted worker slot.

This app inverts that. **The BPMN process the SDK derives owns the durable wait**
between rounds (a real `w.signal` message-catch event), so no agent is ever parked
holding a job slot while a review is pending. Instead you **hire a couple of agent
workers once**, and they pull `senior:pr-review` jobs from *whatever PR is ready
right now* — alternating across all in-flight reviews. Two agents can keep a dozen
PRs converging in parallel, and they only run when there is actual work to do.

Because the `review-round` task overrides its job type to **`senior:pr-review`**
(via `w.task("review-round", { jobType: "senior:pr-review" })`), the *same* hired
reviewer services both this code-first app and the model-first
[urban-pr-review](../urban-pr-review). Set it up by: **(1)** running this app,
**(2)** submitting PRs, and **(3)** hiring agent workers with
[`c8ctl nano`](https://github.com/jwulf/c8ctl-plugin-nano).

### 0. Prerequisites

- A running **Nano gateway/engine** (default `http://localhost:8080`). This is
  what the app deploys to and what agents pull jobs from.
- **[Deno](https://deno.land/)** (to run this app) and the **c8ctl CLI with the
  `nano` plugin** installed (to hire/run agents).
- On each machine that will *host an agent*: the **GitHub CLI** logged in
  (`gh auth login`) or a `GITHUB_TOKEN`/`GH_TOKEN` in the environment, and the
  agent harness itself — e.g. the **[Copilot CLI](https://github.com/github/copilot-cli)**
  (`copilot`).

### 1. Install the app into your Nano IDE

Open the Nano console and **Projects → Import by reference**, pointing at this
app's folder (ADR 0041), or drop a `*.project-ref.json` next to your other
projects. `nano-ide.ext.json` marks it as an example. You can also just run it
standalone (next step) — the IDE import is only needed to launch/manage it from
the console.

### 2. Start the app

```sh
deno task start        # → http://localhost:3000
```

That applies the DB migrations, deploys the derived flow, hosts the in-process
`w.run` record steps, serves the web UI at **<http://localhost:3000>**, and runs
the review-ready poller (which needs `GITHUB_TOKEN` to watch GitHub — without it,
re-reviews come only from the UI/CLI). Point it at a non-default gateway with
`NANOBPMN_BASE_URL`; change the port with `PR_REVIEW_PORT`.

### 3. Submit a PR

From the web UI, or from the CLI:

```sh
deno task submit https://github.com/owner/repo/pull/42 5   # 5 = maxRounds
```

Each submitted PR starts one durable `convergence-loop` instance that parks until
an agent services its `senior:pr-review` round.

### 4. Hire an agent worker

An agent is a CLI harness (Copilot CLI here) turned into a Nano job worker. Hire a
profile whose **rank + capability** produce the `senior:pr-review` token this
flow's task emits:

```sh
c8ctl nano hire \
  --name reviewer \
  --rank senior \
  --capabilities pr-review \
  --command 'copilot -p - --allow-all-tools' \
  --model <your-model>
```

- `--rank senior` + `--capabilities pr-review` makes the worker subscribe to the
  `senior:pr-review` job type — exactly the token this flow's `review-round` task
  emits (thanks to the SDK job-type override), so **one profile serves both apps.**
- `--command 'copilot -p - --allow-all-tools'` starts the Copilot CLI reading its
  prompt from **stdin** (`-p -`). The harness pipes the whole job JSON (prompt +
  `job.variables`: `prUrl`, `repo`, `prNumber`, `round`, `answer?`) to stdin; the
  review-round instructions tell the agent how to read it and where to write its
  result.
- **`--allow-all-tools` is the crucial flag.** Without it, Copilot pauses to ask
  permission before each tool call — and an unattended worker has no human to
  answer, so the job stalls. `--allow-all-tools` lets it run the whole round
  non-interactively. (Pair with `--deny-tool` to blocklist specific tools.)

  > ⚠️ **Only enable `--allow-all-tools` for code and hosts you trust.** It grants
  > the agent unattended, broad permissions (shell, file writes, network). Each
  > job runs in a throwaway per-job workspace (see below), but the worker still
  > runs as your user on the host — don't point it at untrusted PRs on a shared
  > machine. Use `--deny-tool` to narrow it, or a container sandbox for stronger
  > isolation.

> If you'd rather not override the job type in the flow, you can instead leave the
> derived `convergence-loop:review-round` type and point a worker at it explicitly
> with `c8ctl nano work reviewer --job-type convergence-loop:review-round`. This
> app ships with the `senior:pr-review` override so it shares a reviewer with the
> model-first app out of the box.

### 5. Put the agent to work

```sh
c8ctl nano work reviewer      # polls for senior:pr-review jobs until Ctrl-C
```

Now every PR you submit gets picked up automatically. Start a **second** worker
(same command, another terminal or another machine) and the two alternate across
whichever PRs are ready — that is the idle-time you reclaim. Run more than one job
at once per worker with `--max-parallel 2`.

### Isolation — each job gets its own clean workspace

In the default **host mode** (`--sandbox none`), the worker provisions a
**throwaway, per-job workspace**: a fresh clone under `<state>/agent-runs/run-*`
checked out on the PR's head branch, exposed to the agent as `AGENT_WORKSPACE` /
`REPO_URL` / `REPO_BRANCH` / `REPO_REF`, and **reaped after the job**. So multiple
agents on one host don't step on each other. Host workers inherit *your*
`gh`/`GITHUB_TOKEN` login, so no extra auth is needed. Docker/podman sandboxes
exist (`--sandbox docker --image …`) for stronger isolation, but container-side
git provisioning is a later increment — container jobs don't clone yet, and don't
inherit your host login (pass credentials via `--secret-resolver host` /
`secretRefs`). For the review loop, **host mode is the recommended setup.**

### Run it across spare hardware (incl. a Raspberry Pi)

Nano ships ARM binaries (arm64/armv7/armv6), so the whole thing scales down nicely:

- **All-in-one:** run the gateway, this app, and one or two workers on your laptop.
- **Distributed:** run the **Nano gateway on a Raspberry Pi** (always-on, low
  power), run this app anywhere, and put **agent workers on spare machines** — each
  worker just needs the c8ctl CLI, the Copilot CLI logged in, and
  `NANOBPMN_BASE_URL` pointed at the Pi. Add or remove workers at will; the BPMN
  process holds all durable state, so workers are stateless and disposable.

The payoff: instead of one agent burning wall-clock polling a single PR, a small
pool of always-available workers keeps every open review converging — and idles to
zero cost when there's nothing to do.

## The flow

`workflows/convergence-loop.ts`:

```
loop:
  review-round            (EXTERNAL agent — a coding-agent harness)
  switch status:
    converged  -> persist-converged; break
    addressed  -> if round >= maxRounds:
                     persist-escalation-maxrounds        (fall through)
                  else:
                     persist-round (round+1); wait-review; continue
    default    -> persist-escalation                     (fall through)
  wait-answer             (both escalation paths park here for a human)
```

- **`review-round`** is a `w.task` — an **external** worker. Point a coding-agent
  harness at the job type `senior:pr-review` (e.g. a `c8ctl nano hire`d rank
  `senior` + capability `pr-review` profile — the same one that services the
  model-first app). The app never hosts or names it; it only owns the durable
  orchestration around it.
- **`persist-*`** and **`persist-converged`** are `w.run` — app-hosted handlers.
  `persist-round` returns `{ round: round + 1 }`; that return value (not an
  ioMapping) is the loop's only state mutation.
- **`wait-review`** / **`wait-answer`** are `w.signal` — real, engine-visible catch
  events correlated on `prKey`. Both resume at the loop head (`review-round`):
  `wait-review` via an explicit `continue`, `wait-answer` via the loop's natural
  repeat. The two escalation branches converge on the single trailing
  `wait-answer` (step names must be unique, so the signal is not repeated). This
  durable wait is the surface a Temporal-style code-first API cannot draw.

Because every step declares a typed `envelope()` contract, this flow can be
**ejected to model-first** without losing its I/O shapes — they are lifted into
the generated BPMN as `nano:shape` + `io.nanobpm.dataEnvelope` properties.

## Derived names

| Step | Derived job type / message |
| --- | --- |
| `review-round` (external) | `senior:pr-review` (overridden via `w.task("review-round", { jobType: "senior:pr-review" })`) |
| `persist-round` | `convergence-loop:persist-round` |
| `persist-escalation` | `convergence-loop:persist-escalation` |
| `persist-escalation-maxrounds` | `convergence-loop:persist-escalation-maxrounds` |
| `persist-converged` | `convergence-loop:persist-converged` |
| `wait-review` (signal) | `convergence-loop:wait-review` |
| `wait-answer` (signal) | `convergence-loop:wait-answer` |

## Run it

Requires a running Nano gateway (default `http://localhost:8080`; override with
`NANOBPMN_BASE_URL`).

```sh
# The one service: applies DB migrations, deploys the flow, hosts the app-owned
# w.run record steps, AND serves the web frontend + review-ready poller.
deno task start        # → http://localhost:3000
```

`deno task start` now does everything: it applies the `db/migrations/` on boot
(creating `app.db`), deploys the flow, hosts the `persist-*` handlers, serves the
schema-driven page runtime at `http://localhost:3000`, and runs the review-ready
poller. Submit and answer PRs directly from the web UI, or drive the same actions
from the CLI:

```sh
# submit a PR (parks after review-round at wait-review or wait-answer)
deno task submit https://github.com/owner/repo/pull/42 5   # 5 = maxRounds

# nudge a re-review (resumes an instance parked at wait-review)
deno task review-ready owner/repo#42

# answer an escalation (resumes an instance parked at wait-answer)
deno task answer owner/repo#42 "merge as-is"

# wipe all persisted PRs/rounds/escalations (drops + re-migrates app.db)
deno task purge
```

The reviewer itself is not started by `deno task start` — it is the external
`senior:pr-review` job. Host it with a coding-agent harness so the automated
review is fully decoupled from the durable orchestration.

Environment overrides: `PR_REVIEW_PORT` (default `3000`), `NANOBPMN_BASE_URL`
(gateway), `NANO_APP_DB_URL` (default `file:./app.db`), `NANO_PR_POLL_MS`
(poller interval, default `60000`), `NANO_PR_MAX_ROUNDS` (default `10`),
`GITHUB_TOKEN` (enables the poller — without it the poller idles and re-reviews
come only from the CLI/UI).

## Persistence

Parity with the model-first app: the same three-table SQLite schema
(`pull_requests`, `rounds`, `escalations`), the same `db/migrations/*.sql`, and
the same generated typed data facade (`nano-generated/domain.ts`, exposing
`db.pull_requests` / `db.rounds` / `db.escalations`). The `nano.app.json` manifest
declares the `app` sqlite datasource (`${NANO_APP_DB_URL:-file:./app.db}`) and the
migrations directory.

The record steps that write these rows are the code-first counterpart of the
model-first `workers/{persist-round,persist-escalation,finalize}` — but instead of
standalone `defineWorker`s, they are the `w.run` handlers in
`workflows/convergence-loop.ts`, hosted **in-process** by the `@nanobpm/workflow`
`Worker` that `deno task start` runs. The datasource is opened lazily and memoised
on first persist, so the thin CLI scripts (`submit`/`answer`/`review-ready`) can
import the flow to start/signal instances without ever opening the DB — only the
worker host does.

## Frontend

The same schema-driven page runtime as the model-first app (`pages/home.page.json`
+ the `nano-generated/app-pages.ts` engine), served by `main.ts` at
`http://localhost:3000`. It lists active + historical PRs, submits new ones, and
answers or cancels runs inline. Because both apps commit the identical page schema
and generated runtime, the UI is byte-for-byte the same; `main.ts` supplies the
code-first action bindings (`start` → `wf.start`, escalation `message` →
`wf.signal wait-answer`, `cancel` → gateway cancellation) behind it.

## Link it into your Nano projects

This is a standalone Deno project. Import it by reference (ADR 0041) so the
console reads it live from this directory:

- In the console **Projects → Import by reference**, point at this folder, or
- drop a `urban-pr-review-codefirst.project-ref.json` in your projects root.
