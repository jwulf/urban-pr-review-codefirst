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
  harness at the job type `convergence-loop:review-round` (e.g. `c8ctl nano hire`).
  The app never hosts or names it; it only owns the durable orchestration around it.
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
| `review-round` (external) | `convergence-loop:review-round` |
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
`convergence-loop:review-round` job. Host it with a coding-agent harness so the
automated review is fully decoupled from the durable orchestration.

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
