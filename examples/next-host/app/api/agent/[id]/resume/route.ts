/**
 * Next.js App Router route handler: POST /api/agent/[id]/resume — the resume
 * half of the human-in-the-loop flow. Loads the snapshot the initial POST
 * persisted (see ../../route.ts) and delivers the human's APPROVE / REJECT
 * event, running the machine to `done`.
 *
 * Note `params` is a PROMISE and must be awaited — dynamic route params went
 * async in the App Router as of Next 15. This example is typed against the real
 * `next` package, so that is enforced rather than assumed.
 */
import { runAgent } from "@statelyai/agent";
import { NextResponse, type NextRequest } from "next/server";
import { announceMachine, snapshots } from "../../route";
import { resolveExecutors, maybeCreateRunInspection } from "../../../../../agent-runtime";

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const snapshot = snapshots.get(id);
  if (!snapshot) return NextResponse.json({ error: "unknown run id" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    event?: { type: "APPROVE" } | { type: "REJECT"; reason: string };
  };
  const result = await runAgent(announceMachine, {
    snapshot,
    event: body.event,
    executors: resolveExecutors(),
    inspect: await maybeCreateRunInspection(),
  });

  if (result.status === "done") {
    snapshots.delete(id);
    return NextResponse.json({ status: "done", output: result.output });
  }
  if (result.status === "idle") {
    // A REJECT loops back through `drafting` and settles at `reviewing` again,
    // so the stored snapshot has to be replaced or the next resume would run
    // against the pre-rejection draft.
    snapshots.set(id, result.persistedSnapshot);
    return NextResponse.json(
      { status: "idle", id, draft: result.snapshot.context.draft },
      { status: 202 },
    );
  }
  return NextResponse.json({ status: result.status }, { status: 500 });
}
