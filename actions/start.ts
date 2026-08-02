// POST /app/actions/start/convergence-loop — override the generic "start process" action.
// Parse the PR reference and register/refresh the PR aggregate (idempotent on prKey) before
// starting the code-first convergence loop via the workflow client.
import type { ActionHandler } from "@nanobpm/urban";
import { parsePr, submitPr } from "../app/service.ts";

const handler: ActionHandler = async ({ body }, app) => {
  const vars = ((body as { variables?: Record<string, unknown> })?.variables ?? {}) as Record<string, unknown>;
  const raw = String((vars.pr ?? vars.url ?? "") as string).trim();
  const parsed = parsePr(raw);
  if (!parsed) {
    return { status: 400, body: { error: "could not parse PR (use owner/repo#123 or a PR URL)" } };
  }
  return { status: 202, body: await submitPr(app.data, parsed) };
};

export default handler;
