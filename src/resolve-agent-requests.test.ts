import { describe, expect, test } from "vitest";
import { z } from "zod";
import { initialTransition, transition, type AnyMachineSnapshot, type EventObject } from "xstate";
import { createAgentSchemas, createTextLogic, setupAgent } from "./index.js";
import {
  executeAgentRequest,
  getAgentEffects,
  initEntry,
  resolveDecision,
  type AgentEffect,
} from "./index.js";
import type {
  AgentDecisionExecutor,
  AgentRequestExecutor,
  AgentRequestExecutors,
} from "./index.js";

// These tests once pinned the `resolveAgentRequests` step-envelope helper. That
// helper is gone from the public surface; the per-frontier dispatch it
// collapsed is now the host's own thin loop over `getAgentEffects`. The driver
// below IS that loop — `text` effects resolve with `executeAgentRequest`,
// `decision` effects with `resolveDecision` (guard-gated by `snapshot.can`) —
// and the same semantics are re-pinned against it.
//
// What moved to host responsibility (and is therefore no longer a src-level
// unit here): concurrent resolution of a step's parallel text requests. The
// old helper ran them with `Promise.all` and applied outputs in request-array
// order; the thin loop resolves one frontier effect per fold (deterministic by
// construction), and a host that wants genuine concurrency writes its own
// `Promise.race`/`Promise.all` over the effect list. See
// `src/effects.test.ts` for the ordering/occurrence guarantees the fold gives.

async function resolveEffect(
  effect: AgentEffect,
  snapshot: AnyMachineSnapshot,
  executors: Partial<AgentRequestExecutors>,
): Promise<EventObject | undefined> {
  if (effect.kind === "execute") {
    effect.exec();
    return undefined;
  }
  if (effect.kind === "text") {
    const output = await executeAgentRequest(
      {
        kind: "text",
        id: effect.requestId,
        src: effect.request.name ?? "",
        input: effect.request,
        tools: effect.request.tools ?? {},
        events: [],
      },
      executors,
    );
    return effect.toDoneEvent(output);
  }
  if (effect.kind === "decision") {
    if (!executors.decide) {
      throw new Error(
        `this frontier's decision request '${effect.request.id}' needs a 'decide' executor but none was provided.`,
      );
    }
    return resolveDecision(effect.request, executors.decide, {
      canTake: (event) => snapshot.can(event as never),
    });
  }
  throw new Error(`unexpected effect kind '${effect.kind}'`);
}

// Drives a machine to completion through the thin loop, returning the final
// snapshot.
async function runViaEffects(
  machine: any,
  input: unknown,
  executors: Partial<AgentRequestExecutors>,
): Promise<AnyMachineSnapshot> {
  const entries: EventObject[] = [initEntry(machine, input).event];
  let [snapshot, actions] = initialTransition(machine, input as never);

  while ((snapshot as AnyMachineSnapshot).status === "active") {
    const effects = getAgentEffects(machine, snapshot as AnyMachineSnapshot, actions, {
      history: entries,
    });
    let next: EventObject | undefined;
    for (const effect of effects) {
      const event = await resolveEffect(effect, snapshot as AnyMachineSnapshot, executors);
      if (event) {
        next = event;
        break;
      }
    }
    if (!next) {
      break;
    }
    entries.push(next);
    [snapshot, actions] = transition(machine, snapshot, next as never);
  }

  return snapshot as AnyMachineSnapshot;
}

// Minimal two-request agent: first a decision (pick GO or STOP), then — on GO
// — a text request that produces a summary. Exercises both effect kinds
// through the single thin loop above.
function createTinyAgent() {
  const agent = setupAgent({
    schemas: createAgentSchemas({
      context: z.object({ note: z.string().nullable() }),
      output: z.object({ outcome: z.string(), note: z.string() }),
      events: {
        GO: z.object({}),
        STOP: z.object({}),
      },
    }),
    actors: {
      summarize: createTextLogic({
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.object({ summary: z.string() }),
        },
        model: "quick",
        prompt: ({ input }) => `Summarize ${input.topic}`,
      }),
    },
  });

  const machine = agent.createMachine({
    context: () => ({ note: null }),
    initial: "deciding",
    states: {
      deciding: {
        invoke: {
          id: "decide",
          src: "agent.decide",
          input: () => ({ model: "quick", allowedEvents: ["GO", "STOP"] as const }),
        },
        on: {
          GO: { target: "summarizing" },
          STOP: { target: "stopped" },
        },
      },
      summarizing: {
        invoke: {
          id: "summarize",
          src: "summarize",
          input: () => ({ topic: "the run" }),
          onDone: ({ output }) => ({
            target: "done",
            context: { note: output.summary },
          }),
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({ outcome: "done", note: context.note ?? "" }),
      },
      stopped: {
        type: "final",
        output: () => ({ outcome: "stopped", note: "no run" }),
      },
    },
  });

  return machine;
}

function mockExecutors(opts: { move: "GO" | "STOP"; summary?: string }): {
  executors: AgentRequestExecutors;
  calls: string[];
} {
  const calls: string[] = [];

  const decide: AgentDecisionExecutor = async (request) => {
    calls.push("decide");
    const chosen = request.events.find((event) => event.type === opts.move);
    if (!chosen) {
      throw new Error(`mock decide: '${opts.move}' is not legal here.`);
    }
    return { event: { type: opts.move } };
  };

  const generateText: AgentRequestExecutor = async () => {
    calls.push("summarize");
    return { output: { summary: opts.summary ?? "It went well." } };
  };

  return { executors: { generateText, decide }, calls };
}

describe("thin loop: decision + text effects", () => {
  test("drives decision → text to done with correct outputs", async () => {
    const machine = createTinyAgent();
    const { executors, calls } = mockExecutors({ move: "GO", summary: "A fine run." });

    const snapshot = await runViaEffects(machine, undefined, executors);

    expect(snapshot.output).toEqual({ outcome: "done", note: "A fine run." });
    // Decision resolved first, then the text request, in order.
    expect(calls).toEqual(["decide", "summarize"]);
  });

  test("decision event routes the machine (STOP skips the text request)", async () => {
    const machine = createTinyAgent();
    const { executors, calls } = mockExecutors({ move: "STOP" });

    const snapshot = await runViaEffects(machine, undefined, executors);

    expect(snapshot.output).toEqual({ outcome: "stopped", note: "no run" });
    expect(calls).toEqual(["decide"]);
  });

  test("throws a clear error when the decide executor is missing", async () => {
    const machine = createTinyAgent();
    const { executors } = mockExecutors({ move: "GO" });

    await expect(
      runViaEffects(machine, undefined, { generateText: executors.generateText }),
    ).rejects.toThrow(
      /this frontier's decision request '.+' needs a 'decide' executor but none was provided\./,
    );
  });

  test("throws a clear error when the generateText executor is missing", async () => {
    const machine = createTinyAgent();
    const { executors } = mockExecutors({ move: "GO" });

    // Drive past the decision to reach the text effect, then drop generateText:
    // executeAgentRequest surfaces the missing-executor error per kind.
    await expect(runViaEffects(machine, undefined, { decide: executors.decide })).rejects.toThrow(
      /text request '.*' needs a 'generateText' executor but none was provided\./,
    );
  });

  // NOTE: the `mode: 'stream'` vs `'generate'` distinction is NOT carried on a
  // `text` AgentEffect (it drops down to a bare AgentTextRequest), so the old
  // "missing streamText executor" src-level assertion no longer applies — which
  // executor a text effect needs is host-side knowledge now. `executeAgentRequest`
  // defaults to `generateText`; a streaming host branches on its own request
  // metadata before calling the resolver. See the report for details.

  test("a decide-only executor set drives a decision-only run to done", async () => {
    const machine = createTinyAgent();
    const snapshot = await runViaEffects(machine, undefined, {
      decide: async () => ({ event: { type: "STOP" } }),
    });
    expect(snapshot.output).toEqual({ outcome: "stopped", note: "no run" });
  });
});
