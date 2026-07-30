// Signal that a fresh review has landed, resuming a PR parked at `wait-review`.
// A poller (watching GitHub review events) would normally publish this; here it
// is a manual nudge so you can drive the loop by hand.
//
//   deno task review-ready owner/repo#42
import { WorkflowClient } from "@nanobpm/workflow";
import { convergenceLoop } from "../workflows/convergence-loop.ts";

const baseUrl = (Deno.env.get("NANOBPMN_BASE_URL") ?? "http://localhost:8080").replace(/\/+$/, "");
const prKey = Deno.args[0] ?? "Magikcraft/nano-bpm#1";

const client = new WorkflowClient({ baseUrl });
// `correlationKey` is the instance's `prKey`; the message name is derived as
// `convergence-loop:wait-review`.
await client.signal(convergenceLoop, "wait-review", prKey, {
  reviewId: Number(Deno.args[1] ?? 0),
  reviewState: Deno.args[2] ?? "COMMENTED",
  submittedAt: new Date().toISOString(),
});
console.log(`review-ready → ${convergenceLoop.id} (prKey=${prKey})`);
