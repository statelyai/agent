/**
 * Eve tool `resume_workflow` (filename = model-facing name). Reloads the
 * snapshot behind a handle from `start_workflow`, delivers the human's choice,
 * and runs the machine to the next pause or to done.
 *
 * `eventType` is all the model has to pick; the payload field for `text` is
 * derived from the interaction the machine published, never hardcoded here.
 *
 * No hand-rolled legality check: `runAgent` refuses an event the restored state
 * can't take (throws AgentIllegalResumeEventError), so the machine stays the single
 * source of truth for what's allowed.
 */
import { z } from "zod";
import { defineTool } from "../eve-shims.js";
import { resultSchema, resumeDraft } from "../bridge.js";

export default defineTool({
  description:
    "Resume a paused email-drafting workflow. Pass the handle from start_workflow " +
    "and the eventType of the choice the user picked (from the interaction). " +
    "Include `text` when that choice declared an input field.",
  inputSchema: z.object({
    handle: z.string().describe("The handle returned by start_workflow"),
    eventType: z
      .string()
      .describe("The chosen interaction's eventType, e.g. SEND or REQUEST_CHANGES"),
    text: z
      .string()
      .nullable()
      .describe("Free text for choices that declare an input field; otherwise null"),
  }),
  outputSchema: resultSchema,
  async execute({ handle, eventType, text }) {
    return resumeDraft(handle, eventType, text);
  },
});
