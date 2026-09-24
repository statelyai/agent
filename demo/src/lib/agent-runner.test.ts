import { describe, expect, test, vi } from "vitest";
import type { Snapshot } from "xstate";
import type { AgentRequestExecutors } from "@statelyai/agent";
import { resumeScenario, startScenarioRun, resumeScenarioRun } from "./agent-runner";
import type { ScenarioId } from "./scenarios";

// The free-text review interpreter calls `ai`'s generateText directly.
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: vi.fn(async () => ({ text: "UNCLEAR" })),
}));

type Executors = Partial<AgentRequestExecutors>;

// Every test runs the REAL machine with a small stub executor that stands in
// for the model's answer in that test. No network, no key.
function start(id: ScenarioId, prompt: string, executors: Executors) {
  return startScenarioRun(id, prompt, undefined, executors);
}
// The persisted snapshot crosses the wire as opaque JSON; cast it back at the boundary
// (mirrors the zod-validated server fn) before handing it to runAgent.
function resume(
  id: ScenarioId,
  snapshot: unknown,
  event: { type: string; [k: string]: unknown },
  executors: Executors,
) {
  return resumeScenarioRun(id, snapshot as Snapshot<unknown>, event, undefined, executors);
}

const decides = (event: { type: string; [k: string]: unknown }): Executors => ({
  decide: async () => ({ event }),
});
const writes = (result: unknown): Executors => ({ generateText: async () => ({ result }) });

describe("scenario outcomes", () => {
  test("refund under $100 auto-refunds", async () => {
    const result = await start(
      "refund",
      "Please refund $75 for a damaged item.",
      decides({ type: "AUTO_REFUND", amount: 75 }),
    );
    expect(result.status).toBe("done");
    expect((result.output as { outcome: string }).outcome).toBe("refunded");
    expect(result.trace.length).toBeGreaterThan(0);
  });

  test("refund over $100 settles idle awaiting approval; APPROVE resumes to done", async () => {
    const executors = decides({ type: "AUTO_REFUND", amount: 500 });
    const first = await start("refund", "I need a $500 refund for a cancelled order.", executors);
    expect(first.status).toBe("idle");
    expect(first.idle?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["APPROVE", "DENY"]),
    );
    const second = await resume("refund", first.idle!.snapshot, { type: "APPROVE" }, executors);
    expect(second.status).toBe("done");
    expect((second.output as { outcome: string }).outcome).toBe("approved");
  });

  test("refund with no amount asks once, then decides on the reply", async () => {
    const executors: Executors = {
      decide: async (request) => ({
        event: request.prompt?.includes("$60")
          ? { type: "AUTO_REFUND", amount: 60 }
          : { type: "NEEDS_DETAILS" },
      }),
    };
    const first = await start("refund", "I want my money back.", executors);
    expect(first.status).toBe("idle");
    expect(first.idle?.textEvent).toEqual({ type: "DETAILS", field: "text" });
    expect(first.idle?.prompt).toContain("How much");
    const second = await resume(
      "refund",
      first.idle!.snapshot,
      { type: "DETAILS", text: "It was $60." },
      executors,
    );
    expect(second.status).toBe("done");
    expect((second.output as { outcome: string; amount: number }).outcome).toBe("refunded");
    expect((second.output as { amount: number }).amount).toBe(60);
  });

  test("refund gives up after one unanswered clarification", async () => {
    const executors = decides({ type: "NEEDS_DETAILS" });
    const first = await start("refund", "I want my money back.", executors);
    const second = await resume(
      "refund",
      first.idle!.snapshot,
      { type: "DETAILS", text: "I don't remember." },
      executors,
    );
    expect(second.status).toBe("done");
    expect((second.output as { outcome: string }).outcome).toBe("needs-details");
  });

  test("an event the snapshot does not accept is ignored, leaving the state put", async () => {
    const executors = decides({ type: "AUTO_REFUND", amount: 500 });
    const first = await start("refund", "Refund $500 please.", executors);
    expect(first.status).toBe("idle");

    const second = await resume(
      "refund",
      first.idle!.snapshot,
      { type: "NOT_A_REAL_EVENT" },
      executors,
    );

    // runAgent ignores an unhandled event instead of throwing.
    expect(second.ignored).toEqual({ type: "NOT_A_REAL_EVENT" });
    // Still idle at the same wait, offering the same events.
    expect(second.status).toBe("idle");
    expect(second.idle?.events).toEqual(first.idle?.events);
    // What the UI shows for "nothing happened".
    expect(second.response).toContain("nothing happened");
  });

  test("approval drafts, settles idle, then publishes on APPROVE", async () => {
    const executors = writes("Heads up: the migration moved.");
    const first = await start("approval", "Announce the delayed database migration.", executors);
    expect(first.status).toBe("idle");
    expect(first.idle?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["APPROVE", "REJECT"]),
    );
    const second = await resume("approval", first.idle!.snapshot, { type: "APPROVE" }, executors);
    expect(second.status).toBe("done");
    expect((second.output as { published: boolean }).published).toBe(true);
  });

  test("approval REJECT loops back to drafting (idle again)", async () => {
    const executors = writes("Heads up: an outage.");
    const first = await start("approval", "Announce the outage.", executors);
    const second = await resume(
      "approval",
      first.idle!.snapshot,
      { type: "REJECT", reason: "too vague" },
      executors,
    );
    expect(second.status).toBe("idle");
  });

  test("routing picks a typed queue", async () => {
    const result = await start(
      "routing",
      "I was charged twice and cannot download my invoice.",
      decides({ type: "BILLING", reason: "The request mentions a duplicate charge." }),
    );
    expect(result.status).toBe("done");
    const output = result.output as { queue: string; reason: string };
    expect(output.queue).toBe("billing");
    // The model must justify the route, and the justification reaches the chat.
    expect(output.reason).toBe("The request mentions a duplicate charge.");
    expect(result.response).toContain(output.reason);
  });

  test("research runs both regions then synthesizes", async () => {
    const result = await start("research", "Adopting passkeys.", {
      generateText: async (request) => ({ result: `${request.name} paragraph` }),
    });
    expect(result.status).toBe("done");
    expect(result.output).toEqual({
      risks: "researchRisks paragraph",
      opportunities: "researchOpportunities paragraph",
      synthesis: "synthesize paragraph",
    });
  });

  test("pipeline plans, executes, and verifies", async () => {
    const result = await start(
      "pipeline",
      "Write a launch update: faster sync, safer retries, gradual rollout.",
      { generateText: async (request) => ({ result: `${request.name} output` }) },
    );
    expect(result.status).toBe("done");
    const output = result.output as { verification: string; failedAt: string | null };
    expect(output.failedAt).toBeNull();
    expect(output.verification).toBe("verifyTask output");
  });

  test("retry answers on the first attempt when the primary is healthy", async () => {
    const result = await start(
      "retry",
      "Classify this ticket: the billing page shows last month's total.",
      writes("Category: billing"),
    );
    expect(result.status).toBe("done");
    const output = result.output as { attempts: number; usedFallback: boolean; outcome: string };
    expect(output.attempts).toBe(0);
    expect(output.usedFallback).toBe(false);
    expect(output.outcome).toBe("Attempt 1 of 3 succeeded on the primary model.");
  });

  test("retry recovers on the primary after one failure", async () => {
    let calls = 0;
    const result = await start("retry", "Classify this ticket: exports time out.", {
      generateText: async () => {
        calls += 1;
        if (calls === 1) throw new Error("primary unavailable");
        return { result: "Category: technical" };
      },
    });
    expect(result.status).toBe("done");
    const output = result.output as { attempts: number; usedFallback: boolean; outcome: string };
    expect(output.attempts).toBe(1);
    expect(output.usedFallback).toBe(false);
    expect(output.outcome).toBe("Attempt 2 of 3 succeeded on the primary model.");
  });

  test("retry reaches fallback success after primary failures", async () => {
    const result = await start("retry", "I was charged twice and cannot open my invoice.", {
      generateText: async (request) => {
        if (request.model === "primary") throw new Error("primary unavailable");
        return { result: "Category: billing" };
      },
    });
    expect(result.status).toBe("done");
    const output = result.output as {
      category: string;
      attempts: number;
      usedFallback: boolean;
      outcome: string;
    };
    expect(output.usedFallback).toBe(true);
    expect(output.attempts).toBe(2);
    expect(output.category).toBe("Category: billing");
    // The visible outcome names the winning attempt and the model that served it.
    expect(output.outcome).toBe("Attempt 3 of 3 succeeded on the fallback model.");
    expect(result.response).toContain(output.outcome);
  });

  test("tools calls real tools then finishes within the cap", async () => {
    const moves = [
      { type: "CALCULATE", operation: "multiply", a: 42, b: 17 },
      { type: "LOOKUP", key: "speed of light" },
    ];
    const result = await start("tools", "What is 42 times 17, and what is the speed of light?", {
      // Call each tool once, then answer with the observations it was shown.
      decide: async (request) => ({
        event: moves.shift() ?? { type: "FINISH", answer: request.prompt ?? "" },
      }),
      // Only the step cap reaches `forceAnswer`; this run finishes first.
      generateText: async () => ({ result: "unused" }),
    });
    expect(result.status).toBe("done");
    const output = result.output as { answer: string; steps: number };
    expect(output.steps).toBe(2);
    expect(output.answer).toContain("42 multiply 17 = 714");
    expect(output.answer).toContain("speed of light: 299,792,458 meters per second");
  });

  test("reflection revises once then accepts", async () => {
    const result = await start("reflection", "A tidal shoreline at dusk.", {
      generateText: async (request) =>
        request.name === "writeDraft"
          ? { result: request.prompt?.includes("Revise") ? "Revised draft." : "Flat draft." }
          : {
              result: request.prompt?.includes("Revised draft.")
                ? { score: 9, feedback: "Nothing left to name." }
                : { score: 5, feedback: "Name one concrete image." },
            },
    });
    expect(result.status).toBe("done");
    const output = result.output as {
      revisions: number;
      accepted: boolean;
      score: number;
      firstDraft: string;
      draft: string;
      verdict: string;
    };
    expect(output.revisions).toBe(1);
    expect(output.accepted).toBe(true);
    expect(output.score).toBe(9);
    // Before/after: the weak first pass is kept alongside the revised draft.
    expect(output.firstDraft).toBe("Flat draft.");
    expect(output.draft).toBe("Revised draft.");
    expect(output.verdict).toBe("Reached target in 1 revision (score 9/10).");
    expect(result.response).toContain(output.firstDraft);
    expect(result.response).toContain(output.verdict);
  });
});

describe("bounded exits", () => {
  test("retry gives up once every attempt fails, and says so", async () => {
    const result = await start("retry", "Classify this ticket: exports time out.", {
      generateText: async () => {
        throw new Error("every model unavailable");
      },
    });
    expect(result.status).toBe("done");
    const output = result.output as { category: string; outcome: string };
    expect(output.category).toBe("");
    expect(output.outcome).toBe("All 3 attempts failed, the fallback model included.");
    expect(result.response).toContain(output.outcome);
  });

  test("reflection labels a best effort when the revision budget runs out", async () => {
    const result = await start("reflection", "A tidal shoreline at dusk.", {
      generateText: async (request) =>
        request.name === "writeDraft"
          ? { result: `Draft about the shoreline (${request.prompt?.length ?? 0}).` }
          : { result: { score: 5, feedback: "Still generic. Name one concrete image." } },
    });
    expect(result.status).toBe("done");
    const output = result.output as { revisions: number; accepted: boolean; verdict: string };
    expect(output.revisions).toBe(2);
    expect(output.accepted).toBe(false);
    expect(output.verdict).toBe("Best effort after 2 revisions (score 5/10, target 8/10).");
    expect(result.response).toContain(output.verdict);
  });
});

describe("ambiguous free-text review", () => {
  test("re-idles with the snapshot's own event descriptors (REJECT still needs a reason)", async () => {
    // The interpreter (mocked above) answers UNCLEAR; no model call leaves the process.
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const first = await start("approval", "Announce the outage.", writes("Heads up: an outage."));
    expect(first.status).toBe("idle");

    const echoed = await resumeScenario(
      "approval",
      first.idle!.snapshot as unknown as Snapshot<unknown>,
      { kind: "interpret", text: "hmm, not sure" },
    );
    expect(echoed.status).toBe("idle");

    const reject = echoed.idle!.events.find((event) => event.type === "REJECT");
    expect(reject?.needsPayload).toBe(true);
    expect((reject?.jsonSchema as { required?: string[] })?.required).toContain("reason");
    // Indistinguishable from the original idle description.
    expect(echoed.idle!.events).toEqual(first.idle!.events);
    expect(echoed.idle!.prompt).toBe(first.idle!.prompt);
    vi.unstubAllEnvs();
  });
});

describe("model key", () => {
  test("a run without OPENAI_API_KEY refuses instead of running", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expect(
      resumeScenario("approval", {} as Snapshot<unknown>, { type: "APPROVE" }),
    ).rejects.toThrow("Set OPENAI_API_KEY");
    vi.unstubAllEnvs();
  });
});
