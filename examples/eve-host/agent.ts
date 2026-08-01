/**
 * Eve host: the LLM agent that converses with the user and drives the
 * email-draft machine from ../email-drafter through two tools.
 *
 * Folder convention (https://eve.dev/docs/getting-started):
 *   instructions.md        = system prompt (loaded by convention)
 *   agent.ts               = this file: model + runtime config
 *   tools/start_workflow.ts  = bridge: draft from the user's request, return a handle
 *   tools/resume_workflow.ts = bridge: resume the handle with the human's choice
 *
 * Eve auto-discovers `tools/*.ts` by filename, so agent.ts only configures the
 * model. See ./index.ts for the tool bridge exercised without a live Eve runtime.
 *
 * In a real Eve app the import below is `from "eve"`; ./eve-shims.ts is a local
 * stand-in so this example typechecks without Eve installed.
 */
import { defineAgent } from "./eve-shims.js";

export default defineAgent({
  model: "openai/gpt-5.4-mini",
});
