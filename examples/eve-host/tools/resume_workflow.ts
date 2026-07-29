/**
 * Eve tool `resume_workflow` (filename = model-facing name). Revives a handle
 * returned by `start_workflow`, delivers the human's decision, and runs the
 * machine to the next pause or to done.
 *
 * No hand-rolled legality check: `runAgent` refuses an event the restored state
 * can't take (throws AgentIllegalResumeEventError), so the machine stays the single
 * source of truth for what's allowed.
 */
import { z } from "zod";
import { defineTool } from "../eve-shims.js";
import { resumeRefund } from "../machine.js";

export default defineTool({
  description:
    "Resume a paused refund workflow with the user's decision. Pass the handle " +
    "from start_workflow and either an APPROVE or a REJECT (with a reason).",
  inputSchema: z.object({
    handle: z.string().describe("The opaque handle returned by start_workflow"),
    event: z.discriminatedUnion("type", [
      z.object({ type: z.literal("APPROVE") }),
      z.object({ type: z.literal("REJECT"), reason: z.string() }),
    ]),
  }),
  async execute({ handle, event }) {
    return resumeRefund(handle, event);
  },
});
