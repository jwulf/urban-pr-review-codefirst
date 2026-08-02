// Shared code-first engine seam. The convergence process is authored in code
// (`workflows/convergence-loop.ts`) and driven through `@nanobpm/workflow`'s
// `WorkflowClient` (re-exported from `@nanobpm/urban`), which derives the
// executable model, job types and message names from the flow. Both the action
// handlers and the poller reach the engine through this one client.
import { WorkflowClient } from "@nanobpm/urban";
import { convergenceLoop } from "../workflows/convergence-loop.ts";

/** Engine REST base (no trailing slash, no `/v2`). */
export const BASE_URL = (process.env.NANOBPMN_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");

/** Round cap carried onto each instance at submit time. */
export const MAX_ROUNDS = Number(process.env.NANO_PR_MAX_ROUNDS ?? 10);

let _wf: WorkflowClient | null = null;

/** The shared workflow client, lazily constructed against `BASE_URL`. */
export function workflow(): WorkflowClient {
  return (_wf ??= new WorkflowClient({ baseUrl: BASE_URL }));
}

export { convergenceLoop };
