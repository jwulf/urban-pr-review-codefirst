// urban-pr-review-codefirst — the code-first twin of `urban-pr-review`, now on
// the published `@nanobpm/urban` runtime surfaces and authored/hosted on Node
// (Deno is used only as the cross-compiler; see `deno task compile`).
//
// Same behaviour, same UI, same durable multi-round convergence loop — but the
// process is authored in code (`workflows/convergence-loop.ts`, ADR 0044/0045):
// `@nanobpm/workflow` derives the executable model, the job types and the message
// names from `defineFlow`. This entrypoint:
//   1. lets Urban host the datasource + schema-driven pages (ADR 0042) + the
//      app-specific action overrides (start/cancel/answer + webhook) — deploy,
//      workers and triggers are handled by the code-first surface below;
//   2. deploys the derived BPMN and hosts the app-owned `w.run` record workers
//      in-process via `@nanobpm/workflow`'s Worker, writing through the Urban
//      data layer injected into the flow;
//   3. runs the review-ready poller.
//
// The reviewer agent (job type `senior:pr-review`) is deliberately NOT hosted
// here — it is an EXTERNAL worker. Point a coding-agent harness at that job type.
import { externalJobTypes, runFromEnv, selectHost, Worker } from "@nanobpm/urban";
import { convergenceLoop, setPersistData } from "./workflows/convergence-loop.ts";
import { pollOnce } from "./app/service.ts";
import { BASE_URL, workflow } from "./app/engine.ts";

const PORT = Number(process.env.PR_REVIEW_PORT ?? 3000);
const POLL_MS = Number(process.env.NANO_PR_POLL_MS ?? 60_000);

// 1) Urban hosts data + pages + actions on Node. Deploy/workers/triggers are off:
//    the code-first surface owns process deployment and in-process worker hosting.
const host = selectHost();
const app = await runFromEnv({
  host,
  restAddress: `${BASE_URL}/v2`,
  port: PORT,
  handleSignals: false,
  mount: { deploy: false, workers: false, triggers: false },
});
if (!app.data) throw new Error("Urban data layer was not provisioned");

// Wire the provisioned data layer into the in-process persist handlers.
setPersistData(app.data);

// 2) Deploy the derived BPMN and host the app-owned `w.run` workers in-process.
const wf = workflow();
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

// 3) Review-ready poller (idles when GITHUB_TOKEN is unset; webhook/manual still work).
const pollTimer = setInterval(() => void pollOnce(app.data!), POLL_MS);

console.log(
  `urban-pr-review-codefirst serving on :${PORT} against ${BASE_URL} (poll ${POLL_MS}ms)`,
);

// ── graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
async function drainAndExit(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nshutting down…");
  clearInterval(pollTimer);
  try {
    await worker.stop();
  } catch { /* worker never fully started */ }
  try {
    await app.stop();
  } catch { /* already stopped */ }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void drainAndExit());
}
