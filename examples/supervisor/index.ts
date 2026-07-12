/**
 * Supervisor pattern — a router model dispatches one user ask to one of
 * several typed specialist workers, and the parent composes the result.
 *
 * Shows:
 *   - `routeRequest`: a structured-output request whose model picks a
 *     `specialist` ('researcher' | 'coder' | 'writer').
 *   - a `choice` state dispatching to the chosen specialist request, each
 *     with its own model ref and distinct system prompt.
 *   - the parent composing `{ specialist, answer }` as its output.
 *
 * Dual-mode: `runSupervisorExample(options?)` takes injectable executors
 * (the test passes mocks — keyless CI); the direct run below uses real
 * models via `createAiSdkExecutors` + `openai('gpt-5.4-mini')`.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/supervisor/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { runAgent, setupAgent, type RunAgentOptions } from "../../src/index.js";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { resolveExecutors, runExampleMain } from "../helpers/main.js";

const specialistSchema = z.enum(["researcher", "coder", "writer"]);

const routeSchema = z.object({
  specialist: specialistSchema,
  reason: z.string(),
});

export const models = defineModels({
  supervisor: openai("gpt-5.4-mini"),
  researcher: openai("gpt-5.4-mini"),
  coder: openai("gpt-5.4-mini"),
  writer: openai("gpt-5.4-mini"),
});

const agentSetup = setupAgent({
  models,
  context: z.object({
    request: z.string(),
    specialist: specialistSchema.nullable(),
    reason: z.string().nullable(),
    answer: z.string().nullable(),
  }),
  input: z.object({ request: z.string() }),
  output: z.object({
    specialist: specialistSchema,
    reason: z.string(),
    answer: z.string(),
  }),
  requests: {
    routeRequest: {
      schemas: {
        input: z.object({ request: z.string() }),
        output: routeSchema,
      },
      model: "supervisor",
      system:
        "You are a supervisor. Route the user request to exactly one specialist: " +
        '"researcher" (facts, comparisons, background), "coder" (code, APIs, ' +
        'debugging), or "writer" (prose, summaries, messaging).',
      prompt: ({ input }) => input.request,
    },
    // One typed specialist per route, each a distinct model ref + system prompt.
    researcher: {
      schemas: {
        input: z.object({ request: z.string() }),
        output: z.string(),
      },
      model: "researcher",
      system: "You are a research specialist. Answer with concise, factual findings.",
      prompt: ({ input }) => input.request,
    },
    coder: {
      schemas: {
        input: z.object({ request: z.string() }),
        output: z.string(),
      },
      model: "coder",
      system:
        "You are a coding specialist. Answer with correct, minimal code and a short explanation.",
      prompt: ({ input }) => input.request,
    },
    writer: {
      schemas: {
        input: z.object({ request: z.string() }),
        output: z.string(),
      },
      model: "writer",
      system: "You are a writing specialist. Answer with clear, well-structured prose.",
      prompt: ({ input }) => input.request,
    },
  },
});

export const supervisorSchemas = agentSetup.schemas;

export const supervisorMachine = agentSetup.createMachine({
  id: "supervisor",
  context: ({ input }) => ({
    request: input.request,
    specialist: null,
    reason: null,
    answer: null,
  }),
  output: ({ context }) => ({
    specialist: context.specialist ?? "researcher",
    reason: context.reason ?? "",
    answer: context.answer ?? "",
  }),
  initial: "routing",
  states: {
    routing: {
      invoke: {
        id: "routeRequest",
        src: "routeRequest",
        input: ({ context }) => ({ request: context.request }),
        onDone: ({ output }) => ({
          target: "dispatch",
          context: { specialist: output.specialist, reason: output.reason },
        }),
      },
    },
    dispatch: {
      type: "choice",
      choice: ({ context }) => ({ target: context.specialist ?? "researcher" }),
    },
    researcher: {
      invoke: {
        id: "researcher",
        src: "researcher",
        input: ({ context }) => ({ request: context.request }),
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output },
        }),
      },
    },
    coder: {
      invoke: {
        id: "coder",
        src: "coder",
        input: ({ context }) => ({ request: context.request }),
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output },
        }),
      },
    },
    writer: {
      invoke: {
        id: "writer",
        src: "writer",
        input: ({ context }) => ({ request: context.request }),
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output },
        }),
      },
    },
    done: { type: "final" },
  },
});

export async function runSupervisorExample(options?: RunAgentOptions<typeof supervisorMachine>) {
  const result = await runAgent(supervisorMachine, {
    input: {
      request: "Write a friendly release announcement for our new SDK.",
    },
    ...resolveExecutors(models, options),
  });
  if (result.status !== "done") {
    throw new Error(`Supervisor example did not complete: ${result.status}`);
  }
  return result.output;
}

// The specialist state names the router can dispatch to — used to narrate which
// branch each request actually flows through.
const SPECIALIST_STATES = ["researcher", "coder", "writer"] as const;

runExampleMain(import.meta.url, async () => {
  const executors = createAiSdkExecutors({ models });

  // Three requests that clearly belong to three different specialists — the
  // point is to see the router genuinely dispatch to researcher, coder, AND
  // writer, not collapse everything into one branch.
  const requests = [
    "What year was the TCP protocol first standardized, and by whom?",
    "Write a TypeScript function that debounces an async function.",
    "Draft a warm two-sentence thank-you note to a conference organizer.",
  ];

  for (const request of requests) {
    // Record which specialist state this request transitions through.
    const specialistsHit: string[] = [];
    const result = await runAgent(supervisorMachine, {
      input: { request },
      ...executors,
      onTransition: ({ value }) => {
        const state = String(value);
        if ((SPECIALIST_STATES as readonly string[]).includes(state)) {
          specialistsHit.push(state);
        }
        console.log(`  [state] ${state}`);
      },
    });
    if (result.status !== "done") {
      throw new Error(`Supervisor example did not complete: ${result.status}`);
    }
    const { specialist, reason, answer } = result.output;
    console.log(`Request: ${request}`);
    console.log(`Routed through: ${specialistsHit.join(" → ") || "(none)"}`);
    console.log(`Route decision: ${specialist} (${reason})`);
    console.log(`Answer: ${answer}\n`);
  }
});
