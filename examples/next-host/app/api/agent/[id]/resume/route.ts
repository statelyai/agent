/**
 * Next.js App Router route handler: POST /api/agent/[id]/resume — the resume
 * half of the human-in-the-loop flow. Loads the snapshot the initial POST
 * persisted (see ../../route.ts) and delivers the human's APPROVE / REJECT
 * event, running the machine to `done`.
 *
 * The request body is untrusted, so it is handed to `runAgent` as
 * `resumeEvent` rather than as the typed `event`: `runAgent` restores the
 * paused state, checks the type against what that state currently accepts and
 * the payload against the machine's own event schemas, and settles
 * `{ status: 'error', cause: 'invalid-event' }` when it does not fit. That is
 * a 400, not a 500, and no snapshot or log is touched — so no hand-rolled
 * validation pass lives here.
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

  const body = (await request.json().catch(() => ({}))) as { event?: unknown };

  const result = await runAgent(announceMachine, {
    snapshot,
    resumeEvent: body.event,
    executors: resolveExecutors(),
    inspect: await maybeCreateRunInspection(),
  });

  if (result.status === "error" && result.cause === "invalid-event") {
    return NextResponse.json(
      { error: result.error instanceof Error ? result.error.message : String(result.error) },
      { status: 400 },
    );
  }

  if (result.status === "done") {
    snapshots.delete(id);
    return NextResponse.json({ status: "done", output: result.output });
  }
  if (result.status === "idle") {
    // A REJECT loops back through `drafting` and settles at `reviewing` again,
    // so the stored snapshot has to be replaced or the next resume would run
    // against the pre-rejection draft.
    snapshots.set(id, result.persist());
    return NextResponse.json(
      { status: "idle", id, draft: result.snapshot.context.draft },
      { status: 202 },
    );
  }
  return NextResponse.json({ status: result.status }, { status: 500 });
}
