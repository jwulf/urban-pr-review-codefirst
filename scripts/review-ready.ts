// Signal that a fresh review has landed, resuming a PR parked at `wait-review`.
// A poller (watching GitHub review events) would normally publish this; here it
// is a manual nudge so you can drive the loop by hand.
//
//   npm run review-ready -- owner/repo#42
import { WorkflowClient } from "@nanobpm/urban";
import { convergenceLoop } from "../workflows/convergence-loop.ts";

const baseUrl = (process.env.NANOBPMN_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const prKey = process.argv[2] ?? "owner/repo#1";

const client = new WorkflowClient({ baseUrl });
// `correlationKey` is the instance's `prKey`; the message name is derived as
// `convergence-loop:wait-review`.
await client.signal(convergenceLoop, "wait-review", prKey, {
  reviewId: Number(process.argv[3] ?? 0),
  reviewState: process.argv[4] ?? "COMMENTED",
  submittedAt: new Date().toISOString(),
});
console.log(`review-ready → ${convergenceLoop.id} (prKey=${prKey})`);
