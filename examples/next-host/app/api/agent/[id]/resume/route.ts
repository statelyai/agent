/**
 * Next.js App Router route handler: POST /api/agent/[id]/resume — the resume
 * half of the human-in-the-loop flow. Loads the snapshot the initial POST
 * persisted (see ../../route.ts) and delivers the human's APPROVE / REJECT
 * event, running the machine to `done`.
 *
 * The request body comes off the wire, so it goes through `parseAgentEvent`
 * first: that checks it is an object with a string `type` and that its fields
 * satisfy the machine's own event schemas. A bad payload is a 400 and nothing
 * runs, so no hand-rolled validation pass lives here.
 *
 * Whether the paused state HANDLES the event is a different question, and not
 * an error: a state machine ignores an event it has no transition for. The run
 * settles normally and `result.ignored` names the event, which this route
 * reports as a 409.
 *
 * Note `params` is a PROMISE and must be awaited — dynamic route params went
 * async in the App Router as of Next 15. This example is typed against the real
 * `next` package, so that is enforced rather than assumed.
 */
import { parseAgentEvent, runAgent } from "@statelyai/agent";
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

  let event;
  try {
    event = parseAgentEvent(announceMachine, body.event);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  const result = await runAgent(announceMachine, {
    snapshot,
    event,
    executors: resolveExecutors(),
    inspect: await maybeCreateRunInspection(),
  });

  if (result.ignored) {
    return NextResponse.json(
      { error: `'${result.ignored.type}' does not apply right now` },
      { status: 409 },
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
