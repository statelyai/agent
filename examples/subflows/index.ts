/**
 * Subflows — a parent agent invokes a whole child agent machine as one actor,
 * with typed input/output mapping across the boundary.
 *
 * Shows:
 *   - a child agent machine (`researchChild`) with its own request + I/O
 *     schemas: `{ topic } -> { research }`.
 *   - a parent that registers the child under `actors.child` and invokes
 *     it by name, mapping its own `{ topic }` in and the child's
 *     `{ research }` out.
 *   - the child's request inheriting runAgent's `generateText` automatically —
 *     runAgent rebinds every unbound request in an invoked child machine (at
 *     any depth) with the same host executors it gives the parent's own
 *     requests. No nested `.provide` ceremony; bind explicitly only to override.
 *
 * Dual-mode: `runSubflowsExample(options?)` takes an injectable `generateText`
 * executor (the test passes a mock — keyless CI); the direct run below uses a
 * real model via `createAiSdkExecutors` + `openai('gpt-5.4-mini')`.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/subflows/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { type InspectionEvent } from "xstate";
import {
  inspectTransitions,
  runAgent,
  setupAgent,
  type AgentRequestExecutor,
} from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

export const models = defineModels({
  researcher: openai("gpt-5.4-mini"),
});

// ─── Child agent: research one topic ───
const childAgentSetup = setupAgent({
  models,
  context: z.object({ topic: z.string(), research: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ research: z.string() }),
  requests: {
    researchTopic: {
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.string(),
      },
      model: "researcher",
      system: "You are a research assistant. Summarize the topic in 2-3 sentences.",
      prompt: ({ input }) => `Research: ${input.topic}`,
    },
  },
});

export const childMachine = childAgentSetup.createMachine({
  id: "subflows-child",
  context: ({ input }) => ({ topic: input.topic, research: null }),
  output: ({ context }) => ({ research: context.research ?? "" }),
  initial: "researching",
  states: {
    researching: {
      invoke: {
        id: "researchTopic",
        src: "researchTopic",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: "done",
          context: { research: output },
        }),
      },
    },
    done: { type: "final" },
  },
});

// ─── Parent agent: delegate to the child, map I/O across the boundary ───
const parentAgentSetup = setupAgent({
  context: z.object({ topic: z.string(), research: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ research: z.string() }),
  actors: { child: childMachine },
});

export const subflowsMachine = parentAgentSetup.createMachine({
  id: "subflows-parent",
  context: ({ input }) => ({ topic: input.topic, research: null }),
  output: ({ context }) => ({ research: context.research ?? "" }),
  initial: "delegating",
  states: {
    delegating: {
      invoke: {
        id: "child",
        src: "child",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: "done",
          context: { research: output.research },
        }),
      },
    },
    done: { type: "final" },
  },
});

export const subflowsSchemas = parentAgentSetup.schemas;

export async function runSubflowsExample(options?: {
  input?: { topic: string };
  generateText?: AgentRequestExecutor;
  /** Root-machine transitions (parent only). */
  onTransition?: (snapshot: { value: unknown }) => void;
  /** Raw system-wide inspection passthrough (parent AND invoked child). */
  inspect?: (event: InspectionEvent) => void;
}) {
  const result = await runAgent(subflowsMachine, {
    input: options?.input ?? { topic: "state machines for AI agents" },
    // The child is registered as the `child` actor source in the parent setup;
    // runAgent rebinds its unbound `researchTopic` request with THESE executors
    // automatically — no nested `.provide` needed. A direct run builds the real
    // AI SDK executors; a test forwards its injected `generateText` mock.
    ...(options?.generateText
      ? { executors: { generateText: options.generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    // onTransition sees ONLY the root (parent) machine's transitions.
    ...(options?.onTransition ? { onTransition: options.onTransition } : {}),
    // inspect is the system-wide passthrough: it fires for every actor in the
    // root system, including the invoked child machine, each attributable via
    // `event.actorRef.id`. This is what `onTransition` alone cannot give.
    ...(options?.inspect ? { inspect: options.inspect } : {}),
  });

  if (result.status !== "done") {
    throw new Error(`Subflows example did not complete: ${result.status}`);
  }
  return result.output;
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    // Contrast the two observation channels:
    //   - onTransition: root machine only (`subflows-parent`).
    //   - inspect: the WHOLE actor system, so the invoked child machine
    //     (`subflows-child`) shows up too, attributed by actor id.
    const output = await runSubflowsExample({
      onTransition: ({ value }) => console.log(`[onTransition] parent: ${JSON.stringify(value)}`),
      // inspectTransitions filters the raw inspection stream to transitions and
      // hands over the typed snapshot + actorRef — no manual @xstate.transition
      // check or casts.
      inspect: inspectTransitions((snapshot, actorRef) => {
        if (snapshot.value === undefined) return;
        console.log(`[inspect] [${actorRef.id}] ${JSON.stringify(snapshot.value)}`);
      }),
    });
    console.log(`\n${output.research}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
