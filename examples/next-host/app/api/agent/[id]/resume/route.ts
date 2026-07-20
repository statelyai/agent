/**
 * Next.js App Router route handler: POST /api/agent/[id]/resume — the resume
 * half of the human-in-the-loop flow. Loads the snapshot the initial POST
 * persisted (see ../../route.ts) and delivers the human's APPROVE / REJECT
 * event, running the machine to `done`.
 *
 * Same standalone-typecheck caveat as ../../route.ts: `RouteRequest`/`json`
 * are local shims; delete them in a real Next app.
 */
import { runAgent } from "@statelyai/agent";
import { json, type RouteRequest, type RouteResponse } from "../../../../../next-shims.js";
import { announceMachine, executors, snapshots } from "../../route.js";

export async function POST(
  request: RouteRequest,
  ctx: { params: { id: string } },
): Promise<RouteResponse> {
  const { id } = ctx.params;
  const snapshot = snapshots.get(id);
  if (!snapshot) return json({ error: "unknown run id" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    event?: { type: "APPROVE" } | { type: "REJECT"; reason: string };
  };
  const result = await runAgent(announceMachine, { snapshot, event: body.event, executors });

  if (result.status === "done") {
    snapshots.delete(id);
    return json({ status: "done", output: result.output });
  }
  if (result.status === "idle") {
    return json({ status: "idle", draft: result.snapshot.context.draft }, { status: 202 });
  }
  return json({ status: result.status }, { status: 500 });
}
