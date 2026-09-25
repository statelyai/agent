import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, toPromise } from "xstate";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { runAgent, setupAgent } from "../index.js";
import { createSystemOneLogic } from "./index.js";

type SentBody = { state: unknown; questions: Record<string, { type: string }>; model: string };

/**
 * A real `TypeSafeClient` over a scripted `fetch`: the SDK builds, sends, and
 * parses for real; only the HTTP round trip is canned.
 */
function fakeJev(answers: Record<string, unknown>) {
  const sent: SentBody[] = [];
  const client = new TypeSafeClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as SentBody;
      sent.push(body);
      return Response.json({
        model: body.model,
        answers,
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    },
  });
  return { client, sent };
}

const ticketAnswers = {
  category: {
    type: "choice",
    choice: "billing",
    confidence: 0.9,
    probabilities: { billing: 0.9, other: 0.1 },
  },
  urgent: { type: "noul", noul: 0.8 },
  severity: {
    type: "score",
    score: 2,
    confidence: 0.7,
    legend: { "0": "cosmetic", "1": "degraded", "2": "blocked" },
    probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 },
  },
};

function createJudge(options: { client?: TypeSafeClient; model?: string } = {}) {
  return createSystemOneLogic({
    ...options,
    state: (input: { ticket: string; plan: string }) => ({
      ticket: input.ticket,
      plan: input.plan,
    }),
    questions: (input) => ({
      category: choice(`Which team owns \`ticket\` for a ${input.plan} customer?`, {
        billing: "Charges, refunds, invoices.",
        other: "Anything else.",
      }),
      urgent: noul("Does `ticket` describe something blocking the customer now?"),
      severity: score("How severe is the problem in `ticket`?", [
        "cosmetic",
        "degraded",
        "blocked",
      ]),
    }),
  });
}

/** A one-step machine that invokes `judge` and records its answers or error. */
function createTriageMachine() {
  const agent = setupAgent({
    context: z.object({
      ticket: z.string(),
      category: z.string().nullable(),
      urgent: z.number().nullable(),
      severity: z.number().nullable(),
      model: z.string().nullable(),
      error: z.string().nullable(),
    }),
    input: z.object({ ticket: z.string() }),
    output: z.object({
      category: z.string().nullable(),
      urgent: z.number().nullable(),
      severity: z.number().nullable(),
      model: z.string().nullable(),
      error: z.string().nullable(),
    }),
    // The registered default: no client, so one is built lazily on first invoke.
    actors: { judge: createJudge() },
  });
  return agent.createMachine({
    context: ({ input }) => ({
      ticket: input.ticket,
      category: null,
      urgent: null,
      severity: null,
      model: null,
      error: null,
    }),
    initial: "judging",
    states: {
      judging: {
        invoke: {
          src: "judge",
          input: ({ context }) => ({ ticket: context.ticket, plan: "pro" }),
          onDone: ({ output }) => ({
            target: "done",
            context: {
              category: output.answers.category.choice,
              urgent: output.answers.urgent.noul,
              severity: output.answers.severity.score,
              model: output.model,
            },
          }),
          onError: ({ event }) => ({
            target: "done",
            // Name + message, so a test can tell the SDK's own error class apart.
            context: {
              error:
                event.error instanceof Error
                  ? `${event.error.name}: ${event.error.message}`
                  : String(event.error),
            },
          }),
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({
          category: context.category,
          urgent: context.urgent,
          severity: context.severity,
          model: context.model,
          error: context.error,
        }),
      },
    },
  });
}

describe("createSystemOneLogic", () => {
  const savedKey = process.env.TYPESAFE_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
  });

  test("answers choice, noul, and score through a registered actor", async () => {
    const jev = fakeJev(ticketAnswers);
    const result = await runAgent(createTriageMachine(), {
      input: { ticket: "I was charged twice and cannot log in." },
      actors: { judge: createJudge({ client: jev.client }) },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output).toEqual({
      category: "billing",
      urgent: 0.8,
      severity: 2,
      model: "jev-latest",
      error: null,
    });
  });

  test("builds state and questions from the invoke input", async () => {
    const jev = fakeJev(ticketAnswers);
    await runAgent(createTriageMachine(), {
      input: { ticket: "Refund please." },
      actors: { judge: createJudge({ client: jev.client }) },
    });

    expect(jev.sent).toHaveLength(1);
    const [body] = jev.sent;
    expect(body!.state).toEqual({ ticket: "Refund please.", plan: "pro" });
    expect(Object.keys(body!.questions)).toEqual(["category", "urgent", "severity"]);
    expect(body!.questions.category).toMatchObject({
      type: "choice",
      instructions: "Which team owns `ticket` for a pro customer?",
    });
    expect(body!.questions.urgent!.type).toBe("noul");
    expect(body!.questions.severity!.type).toBe("score");
  });

  test("forwards model", async () => {
    const jev = fakeJev(ticketAnswers);
    const result = await runAgent(createTriageMachine(), {
      input: { ticket: "Refund please." },
      actors: { judge: createJudge({ client: jev.client, model: "jev-custom" }) },
    });

    expect(jev.sent[0]!.model).toBe("jev-custom");
    expect(result.status === "done" && result.output.model).toBe("jev-custom");
  });

  test("constructs the default client lazily, on invoke rather than at definition", async () => {
    delete process.env.TYPESAFE_API_KEY;
    // Defining the machine (and its registered default actor) must not throw.
    const machine = createTriageMachine();

    const result = await runAgent(machine, { input: { ticket: "Refund please." } });

    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    expect(result.output.category).toBeNull();
    // The SDK's own config error, raised when the actor runs.
    expect(result.output.error).toMatch(/^TypeSafeError: No API key was provided/);
    expect(result.output.error).toMatch(/TYPESAFE_API_KEY/);
  });

  test("an empty question set resolves with no answers and no request", async () => {
    delete process.env.TYPESAFE_API_KEY;
    let fetches = 0;
    const client = new TypeSafeClient({
      apiKey: "test-key",
      fetch: async () => {
        fetches += 1;
        return Response.json({});
      },
    });
    const gradeNone = (options: { client?: TypeSafeClient }) =>
      createSystemOneLogic({
        ...options,
        state: (input: { documents: string[] }) => ({ documents: input.documents }),
        questions: (input) =>
          Object.fromEntries(
            input.documents.map((_doc, i) => [`doc${i}`, noul(`Is \`documents[${i}]\` relevant?`)]),
          ),
      });

    // With a client: it is never called.
    const withClient = createActor(gradeNone({ client }), { input: { documents: [] } });
    withClient.start();
    expect(await toPromise(withClient)).toEqual({
      answers: {},
      model: "jev-latest",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(fetches).toBe(0);

    // Without one: no default client is constructed, so no key is needed.
    const lazy = createActor(gradeNone({}), { input: { documents: [] } });
    lazy.start();
    await expect(toPromise(lazy)).resolves.toMatchObject({ answers: {} });
  });

  test("passes the run's abort signal through to fetch", async () => {
    const seen: AbortSignal[] = [];
    let entered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const client = new TypeSafeClient({
      apiKey: "test-key",
      retry: { maxRetries: 0 },
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!;
          seen.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          entered();
        }),
    });
    const controller = new AbortController();
    const run = runAgent(createTriageMachine(), {
      input: { ticket: "Refund please." },
      actors: { judge: createJudge({ client }) },
      signal: controller.signal,
    });

    await fetchEntered;
    expect(seen[0]!.aborted).toBe(false);
    controller.abort(new Error("stop"));
    const result = await run;

    expect(result.status).toBe("error");
    expect(seen[0]!.aborted).toBe(true);
  });
});
