/**
 * A long-lived application-owned XState actor.
 *
 * This reuses the same machine as `portable-xstate-loop`. Stately Agent binds
 * model executors; the application owns actor lifetime, subscriptions, and
 * external events through ordinary XState APIs.
 *
 * Run: npx tsx examples/long-lived-actor/index.ts
 */
import { createActor, waitFor } from "xstate";
import { provideExecutors, type AgentRequestExecutors } from "@statelyai/agent";
import { portableLoopMachine } from "../portable-xstate-loop/index.js";

export async function runLongLivedActor(
  topic: string,
  executors: AgentRequestExecutors,
): Promise<{ draft: string; states: string[] }> {
  const states: string[] = [];
  const actor = createActor(provideExecutors(portableLoopMachine, executors), {
    input: { topic },
  });
  actor.subscribe((snapshot) => states.push(String(snapshot.value)));
  actor.start();

  await waitFor(actor, (snapshot) => snapshot.matches("reviewing"));
  actor.send({ type: "APPROVE" });
  const done = await waitFor(actor, (snapshot) => snapshot.status === "done");
  actor.stop();

  if (!done.output) {
    throw new Error("The completed actor did not produce an output.");
  }

  return { draft: done.output.draft, states };
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  const result = await runLongLivedActor("application-owned actors", {
    generateText: async () => ({ output: "The application owns this actor." }),
  });
  console.log(result);
}
