// Code-first durable workflows on Nano (ADR 0044/0045). No diagram, no task-type
// wiring, no correlation plumbing: @nanobpm/workflow derives the executable BPMN
// model (with DI), the job types, the message names, and hosts a generic Worker.
//
// This is the whole application: it deploys `convergence-loop` and hosts the
// app-owned workers in-process, then runs forever. Run it standalone
// (`deno task start`) or with the console/IDE "Run" button — same entrypoint.
//
// Note: the reviewer agent (`convergence-loop:review-round`) is deliberately NOT
// hosted here. It is an EXTERNAL worker — point a coding-agent harness at that
// job type (e.g. `c8ctl nano hire`) so the automated review is fully decoupled
// from the durable orchestration.
import { WorkflowClient, Worker, externalJobTypes } from "@nanobpm/workflow";
import { convergenceLoop } from "./workflows/convergence-loop.ts";

const baseUrl = (Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");
const workflows = [convergenceLoop];

// 1) Deploy the derived BPMN for each workflow (idempotent — safe to redeploy).
const client = new WorkflowClient({ baseUrl });
for (const wf of workflows) {
  await client.deploy(wf);
  console.log(`deployed ${wf.id}`);
}

// 2) Host the app-owned workers in-process (the `w.run` steps). The reviewer
//    `w.task` steps are external and intentionally left unhosted.
const worker = new Worker({
  baseUrl,
  workflows,
  onError: (err) => console.error("worker error:", err.message),
});
worker.start();

for (const jt of externalJobTypes(convergenceLoop)) {
  console.log(`external job type (host it yourself, e.g. a coding-agent harness): ${jt}`);
}
console.log(`worker host running against ${baseUrl} — press Ctrl-C to stop`);

// 3) Run forever; stop cleanly on Ctrl-C / SIGTERM so in-flight polls drain.
let shuttingDown = false;
const drainAndExit = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nshutting down…");
  await worker.stop();
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
await new Promise<void>(() => {}); // keep the process alive until a signal fires
