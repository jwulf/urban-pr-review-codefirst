// urban-pr-review-codefirst — the code-first twin of `urban-pr-review`.
//
// Same behaviour, same UI, same durable multi-round convergence loop — but the
// process is authored in code (`workflows/convergence-loop.ts`, ADR 0044/0045)
// instead of a hand-drawn BPMN + manifest. `@nanobpm/workflow` derives the
// executable model, the job types and the message names from `defineFlow`.
//
// This entrypoint brings the code-first twin to full parity with the model-first
// app. It:
//   1. migrates + deploys the derived BPMN and hosts the app-owned record
//      workers in-process (the `w.run` steps persist through `@nanobpm/domain`),
//   2. serves the schema-driven page runtime (ADR 0042) from `pages/home.page.json`,
//      intercepting only the three app-specific actions (start/cancel/answer),
//   3. runs the review-ready poller.
//
// The reviewer agent (`convergence-loop:review-round`) is deliberately NOT hosted
// here — it is an EXTERNAL worker. Point a coding-agent harness at that job type
// (e.g. `c8ctl nano hire`) so the automated review stays decoupled from the
// durable orchestration.
import { externalJobTypes, Worker, WorkflowClient } from "@nanobpm/workflow";
import type { JsonObject } from "@nanobpm/workflow";
import { openDomain } from "@nanobpm/domain";
import { createPagesHandler } from "@nanobpm/app";
import { convergenceLoop } from "./workflows/convergence-loop.ts";

const BASE_URL = (Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");
const PORT = Number(Deno.env.get("PR_REVIEW_PORT") ?? 3000);
const POLL_MS = Number(Deno.env.get("NANO_PR_POLL_MS") ?? 60_000);
const MAX_ROUNDS = Number(Deno.env.get("NANO_PR_MAX_ROUNDS") ?? 10);
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("NANO_PR_WEBHOOK_SECRET") ?? "";

// ── helpers ──────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Run pending `db/migrations/*.sql` through the generated data gateway (records
 * them in the `_nano_migrations` ledger), so `deno task start` comes up against a
 * correct schema without a manual `deno task purge` first. Idempotent. */
async function migrateDb(): Promise<void> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-read", "--allow-write", "--allow-env", "nano-generated/data-cli.ts"],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify({ op: "migrate" })));
  await w.close();
  const { stdout } = await child.output();
  const out = new TextDecoder().decode(stdout).trim();
  try {
    const parsed = JSON.parse(out) as { ok: boolean; applied?: string[]; error?: string };
    if (!parsed.ok) throw new Error(parsed.error ?? "unknown error");
    console.log(`migrated app db (${(parsed.applied ?? []).length} file(s) applied)`);
  } catch (err) {
    console.error(`migrate failed: ${err} — output: ${out}`);
    throw err;
  }
}

/** Cancel a running engine instance via the Camunda v2 REST endpoint. */
async function cancelInstance(processInstanceKey: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/v2/process-instances/${processInstanceKey}/cancellation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    throw new Error(`cancel ${processInstanceKey}: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

/** Parse "owner/repo#123" or a canonical PR URL into its parts. */
function parsePr(input: string): { repo: string; number: number; url: string; prKey: string } | null {
  const s = input.trim();
  let m = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  m = s.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (m) {
    const repo = m[1];
    const number = Number(m[2]);
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, prKey: `${repo}#${number}` };
  }
  return null;
}

// ── boot ───────────────────────────────────────────────────────────────────
// 1) Migrate the app database (idempotent — only pending files apply), then
//    deploy the derived BPMN and host the app-owned `w.run` workers in-process.
await migrateDb();

const wf = new WorkflowClient({ baseUrl: BASE_URL });
await wf.deploy(convergenceLoop);
console.log(`deployed ${convergenceLoop.id}`);

const worker = new Worker({
  baseUrl: BASE_URL,
  workflows: [convergenceLoop],
  onError: (err) => console.error("worker error:", err.message),
});
worker.start();

for (const jt of externalJobTypes(convergenceLoop)) {
  console.log(`external job type (host it yourself, e.g. a coding-agent harness): ${jt}`);
}

// The app's own sqlite datasource as a typed data object — the same store the
// `w.run` handlers persist through, read here for the poller + action overrides.
const db = await openDomain("app");

// The prompt asset is read once at submit time and carried on the instance, so a
// PR keeps the instructions it started with for its whole run.
const REVIEW_PROMPT = await Deno.readTextFile("prompts/review-round.md").catch(() => "");

/** Register a PR row (if new) and start the convergence process. Idempotent on prKey. */
async function submitPr(repo: string, number: number, url: string, prKey: string) {
  const existing = await db.pull_requests.get(prKey);
  if (existing && !["converged", "abandoned"].includes(existing.status)) {
    return { prKey, alreadyRunning: true };
  }
  const ts = now();
  if (existing) {
    // Re-open a previously converged/abandoned PR for a fresh convergence run.
    await db.pull_requests.update(prKey, {
      status: "converging", current_round: 1, url,
      waiting_since: null, last_review_id: null, outcome: null, converged_at: null,
      updated_at: ts,
    });
  } else {
    await db.pull_requests.insert({
      pr_key: prKey, repo, number, url, status: "converging", current_round: 1,
      created_at: ts, updated_at: ts,
    });
  }
  // `client.start` seeds a declarative flow's instance variables directly, and
  // derives the message correlation from the `prKey` variable.
  const { processInstanceKey } = await wf.start(convergenceLoop, {
    repo, prNumber: number, prUrl: url, prKey, round: 1, maxRounds: MAX_ROUNDS, prompt: REVIEW_PROMPT,
  });
  if (processInstanceKey != null) {
    await db.pull_requests.update(prKey, { process_key: String(processInstanceKey) });
  }
  return { prKey, processKey: processInstanceKey };
}

/** Answer an open escalation → record it and resume the process at `wait-answer`. */
async function answerEscalation(prKey: string, answer: string) {
  const open = (await db.escalations.find({ pr_key: prKey, status: "open" }))
    .sort((a, b) => b.id - a.id)[0];
  if (!open) return { ok: false, reason: "no open escalation" };
  const escalationId = open.id;
  const ts = now();
  await db.escalations.update(escalationId, { answer, status: "answered", answered_at: ts });
  await db.pull_requests.update(prKey, {
    status: "converging", updated_at: ts,
    open_escalation_id: null, open_escalation_question: null,
  });
  // Correlate the `wait-answer` signal (derived message `convergence-loop:wait-answer`)
  // to the parked instance by its `prKey`.
  await wf.signal(convergenceLoop, "wait-answer", prKey, { answer, escalationId });
  return { ok: true, escalationId };
}

/** Cancel a PR's running convergence instance and mark it abandoned. Terminating
 * the engine instance emits no completion event (no worker runs), so the app-tier
 * flips the PR's status here. */
async function cancelRun(processInstanceKey: string) {
  const [pr] = await db.pull_requests.find({ process_key: processInstanceKey });
  try {
    await cancelInstance(processInstanceKey);
  } catch (err) {
    // The instance may already be gone (converged/cancelled) — still reconcile
    // the app row so a stale "converging" PR can't linger in the UI.
    console.warn(`[cancel] engine cancel for ${processInstanceKey}: ${err}`);
  }
  if (pr) {
    await db.pull_requests.update(String(pr.pr_key), {
      status: "abandoned", updated_at: now(),
      open_escalation_id: null, open_escalation_question: null,
    });
    return { ok: true, prKey: pr.pr_key };
  }
  return { ok: false, reason: "no PR for that instance" };
}

// ── review-ready poller ───────────────────────────────────────────────────────
async function pollOnce() {
  if (!GITHUB_TOKEN) return; // no token → poller idles (webhook/manual still work)
  const waiting = await db.pull_requests.find({ status: "waiting_review" });
  for (const pr of waiting) {
    const { repo, number, pr_key: prKey } = pr;
    const lastId = pr.last_review_id ?? 0;
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/reviews?per_page=100`, {
        headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
      });
      if (!r.ok) continue;
      const reviews = (await r.json()) as Array<{ id: number; state: string; submitted_at?: string }>;
      const fresh = reviews
        .filter((rv) => rv.id > lastId && rv.submitted_at && (!pr.waiting_since || rv.submitted_at >= pr.waiting_since))
        .sort((a, b) => a.id - b.id)
        .pop();
      if (!fresh) continue;
      await db.pull_requests.update(prKey, {
        last_review_id: fresh.id, status: "converging", updated_at: now(),
      });
      // Resume the instance parked at `wait-review` (derived message
      // `convergence-loop:wait-review`), then it loops back to review-round.
      await wf.signal(convergenceLoop, "wait-review", prKey, {
        reviewId: fresh.id, reviewState: fresh.state, submittedAt: fresh.submitted_at ?? null,
      });
      console.log(`[poller] review ${fresh.id} (${fresh.state}) → ${prKey}`);
    } catch (err) {
      console.error(`[poller] ${prKey}: ${err}`);
    }
  }
}
const pollTimer = setInterval(() => void pollOnce(), POLL_MS);

// ── HTTP: schema-driven page runtime (ADR 0042) + app-specific action overrides ──
// The screen is authored declaratively in `pages/home.page.json` and served by the
// generic Urban page runtime — no hand-written SPA or list/detail API. Only the
// three actions that carry *app-specific* business logic are intercepted here; the
// runtime handles rendering, data, filtering and the rest.
//
// The injected engine adapter bridges the generic runtime to the code-first
// surface: cancel/publish hit the gateway's Camunda v2 REST endpoints directly,
// and createProcessInstance delegates to the workflow client. In practice all
// three page actions are overridden below, so the adapter only backstops any
// non-overridden action the runtime might serve.
const pagesHandler = createPagesHandler({
  db: db.raw,
  nano: {
    createProcessInstance: async (input) => {
      // Runtime contract boundary: the generic page runtime hands us loosely-typed
      // variables (Record<string, unknown>); the workflow client wants a JsonObject.
      const vars = (input.variables ?? {}) as JsonObject;
      const { processInstanceKey } = await wf.start(convergenceLoop, vars);
      return { processInstanceKey };
    },
    cancelProcessInstance: (input) => cancelInstance(String(input.processInstanceKey)),
    publishMessage: async (input) => {
      const res = await fetch(`${BASE_URL}/v2/messages/publication`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          correlationKey: input.correlationKey,
          variables: input.variables ?? {},
        }),
      });
      if (!res.ok) throw new Error(`publishMessage ${input.name}: ${res.status}`);
      return res.json().catch(() => ({}));
    },
  },
  pagesDir: "pages",
  homePage: "home",
  sourceName: "app",
});

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const { pathname } = url;

  // Override: start the convergence loop for a PR. Parse the PR reference and
  // create the aggregate before starting the instance.
  if (req.method === "POST" && pathname === "/app/actions/start/convergence-loop") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const vars = (body.variables ?? {}) as Record<string, unknown>;
    const raw = String((vars.pr ?? vars.url ?? "") as string).trim();
    const parsed = parsePr(raw);
    if (!parsed) return json({ error: "could not parse PR (use owner/repo#123 or a PR URL)" }, 400);
    return json(await submitPr(parsed.repo, parsed.number, parsed.url, parsed.prKey), 202);
  }

  // Override: cancel a run. Terminating the instance emits no completion event, so
  // reconcile the app row (status='abandoned', clear open escalation) here.
  if (req.method === "POST" && pathname === "/app/actions/cancel") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const key = body.processInstanceKey;
    if (key == null || String(key) === "") return json({ error: "processInstanceKey is required" }, 400);
    const r = await cancelRun(String(key));
    return json(r, r.ok ? 200 : 404);
  }

  // Override: answer an escalation (signal `wait-answer`). Runs the app's answer
  // flow (record the answer, clear the open escalation) instead of a bare publish.
  if (req.method === "POST" && pathname === "/app/actions/message") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    if (String(body.name ?? "") === "escalation-answered") {
      const prKey = String(body.correlationKey ?? "");
      const vars = (body.variables ?? {}) as Record<string, unknown>;
      const answer = String((vars.answer ?? "") as string).trim();
      if (!prKey) return json({ error: "correlationKey is required" }, 400);
      if (!answer) return json({ error: "answer is required" }, 400);
      const r = await answerEscalation(prKey, answer);
      return json(r, r.ok ? 200 : 404);
    }
    // Fall through to the generic runtime for any other message.
  }

  // Webhook: submit (shared-secret auth via X-Hook-Secret). Not part of the page UI.
  if (req.method === "POST" && pathname === "/hooks/submit") {
    if (WEBHOOK_SECRET && req.headers.get("x-hook-secret") !== WEBHOOK_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const parsed = parsePr(String((body.url ?? body.pr ?? "") as string));
    if (!parsed) return json({ error: "could not parse PR url" }, 400);
    return json(await submitPr(parsed.repo, parsed.number, parsed.url, parsed.prKey), 202);
  }

  // Everything else — the screen, its data, filtering, and the non-overridden
  // actions — is served by the generic page runtime.
  return pagesHandler(req);
});

console.log(
  `urban-pr-review-codefirst serving on :${PORT} against ${BASE_URL} (poll ${POLL_MS}ms, maxRounds ${MAX_ROUNDS})`,
);

// ── graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
const drainAndExit = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nshutting down…");
  clearInterval(pollTimer);
  await worker.stop();
  db.close();
  Deno.exit(0);
};
const shutdown = (): void => {
  void drainAndExit();
};
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(sig, shutdown);
  } catch {
    // Signal not supported on this OS (e.g. SIGTERM on Windows) — skip it.
  }
}
