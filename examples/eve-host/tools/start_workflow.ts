/**
 * Eve tool `start_workflow` (filename = model-facing name). Starts the
 * email-draft machine, delivers the user's request, and runs it to its first
 * human pause. Returns a JSON-safe result the model can reason over: a `handle`
 * to resume later, the draft so far, and the typed interaction to present.
 *
 * The machine owns legality/state; this tool is a thin bridge over `runAgent`.
 * `outputSchema` is the machine's own interaction protocol, so the model gets
 * the full typed union rather than a flattened summary.
 */
import { z } from "zod";
import { defineTool } from "../eve-shims.js";
import { resultSchema, startDraft } from "../bridge.js";

export default defineTool({
  description:
    "Start an email-drafting workflow from the user's request. Returns 'pending' " +
    "with a handle, the current draft, and an interaction describing the choice to " +
    "present, or 'done' with the emails that were sent.",
  inputSchema: z.object({
    prompt: z.string().describe("The user's email request, in their own words"),
  }),
  outputSchema: resultSchema,
  async execute({ prompt }) {
    return startDraft(prompt);
  },
});
