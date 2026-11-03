/**
 * STEP 0 — wrap and record. `runTicket` runs unchanged inside a machine.
 *
 * Gained: every effect call is a transition (`effect.call`, then `effect.done`
 * or `effect.error`), so the run shows up in `inspect`, traces and the event
 * log; `signal` aborts it; `run(ticket, { recorder })` records a golden run.
 * Not gained: the machine has one state for the whole function, so nothing
 * about the workflow's inside can be proven yet.
 */
import { wrapWorkflow } from "@statelyai/agent";
import { runTicket, type Ticket } from "./before.js";
import { createFakeWorld } from "./effects.js";

export const step0 = wrapWorkflow({
  id: "support-step0",
  effects: createFakeWorld().effects,
  run: (ticket: Ticket, effects) => runTicket(ticket, effects),
});
