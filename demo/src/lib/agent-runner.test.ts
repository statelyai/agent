import { describe, expect, test, vi } from "vitest";
import type { Experimental_DecisionModel } from "ai";
import type { Snapshot } from "xstate";
import type { AgentRequestExecutors } from "@statelyai/agent";
import {
  REVIEW_CONFIDENCE,
  resumeScenario,
  startScenarioRun,
  resumeScenarioRun,
} from "./agent-runner";
import { ROUTING_CONFIDENCE } from "@/agents/routing";
import { CRITERION_THRESHOLD, SCORE_THRESHOLD } from "@/agents/reflection";
import type { ScenarioId } from "./scenarios";
import { createTestJudge } from "./test-judge";

type Executors = Partial<AgentRequestExecutors>;

// Every test runs the REAL machine with a small stub executor that stands in
// for the model's answer in that test, and a scripted decision model for
// Jev's judgments. No network, no key.
function start(
  id: ScenarioId,
  prompt: string,
  executors: Executors,
  judge?: Experimental_DecisionModel,
) {
  return startScenarioRun(id, prompt, undefined, executors, undefined, judge);
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
    const judge = createTestJudge({ intent: "billing" });
    const result = await start(
      "routing",
      "I was charged twice and cannot download my invoice.",
      {},
      judge.model,
    );
    expect(result.status).toBe("done");
    const output = result.output as { queue: string; reason: string };
    expect(output.queue).toBe("billing");
    // Every route carries its justification, and the justification reaches the chat.
    expect(output.reason).toBe("Charges, payments, refunds, or invoices. (Jev confidence 90%)");
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
    const revised = (state: { draft: string }) => state.draft === "Revised draft.";
    const judge = createTestJudge({
      quality: (state) => (revised(state) ? 4 : 1),
      concrete: (state) => (revised(state) ? 0.9 : 0.1),
      noFiller: 0.9,
      controllingIdea: 0.9,
      rhythm: 0.9,
    });
    const result = await start(
      "reflection",
      "A tidal shoreline at dusk.",
      {
        generateText: async (request) => ({
          result: request.prompt?.includes("Revise") ? "Revised draft." : "Flat draft.",
        }),
      },
      judge.model,
    );
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
    expect(output.score).toBe(4);
    // Before/after: the weak first pass is kept alongside the revised draft.
    expect(output.firstDraft).toBe("Flat draft.");
    expect(output.draft).toBe("Revised draft.");
    expect(output.verdict).toBe("Reached target in 1 revision (score 4/4).");
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
    const judge = createTestJudge({
      quality: 2,
      concrete: 0.1,
      noFiller: 0.9,
      controllingIdea: 0.9,
      rhythm: 0.9,
    });
    const result = await start(
      "reflection",
      "A tidal shoreline at dusk.",
      {
        generateText: async (request) => ({
          result: `Draft about the shoreline (${request.prompt?.length ?? 0}).`,
        }),
      },
      judge.model,
    );
    expect(result.status).toBe("done");
    const output = result.output as { revisions: number; accepted: boolean; verdict: string };
    expect(output.revisions).toBe(2);
    expect(output.accepted).toBe(false);
    expect(output.verdict).toBe("Best effort after 2 revisions (score 2/4, target 3/4).");
    expect(result.response).toContain(output.verdict);
  });
});

describe("ambiguous free-text review", () => {
  test("re-idles with the snapshot's own event descriptors (REJECT still needs a reason)", async () => {
    // Jev reads the review as unclear; no model call leaves the process.
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_AI_API_KEY", "test-key");
    const judge = createTestJudge({ verdict: "unclear" });
    const first = await start("approval", "Announce the outage.", writes("Heads up: an outage."));
    expect(first.status).toBe("idle");

    const echoed = await resumeScenario(
      "approval",
      first.idle!.snapshot as unknown as Snapshot<unknown>,
      { kind: "interpret", text: "hmm, not sure" },
      undefined,
      judge.model,
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
    vi.stubEnv("TYPESAFE_AI_API_KEY", "test-key");
    await expect(
      resumeScenario("approval", {} as Snapshot<unknown>, { type: "APPROVE" }),
    ).rejects.toThrow("Set OPENAI_API_KEY");
    vi.unstubAllEnvs();
  });

  test("a run without TYPESAFE_AI_API_KEY refuses and names the missing key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_AI_API_KEY", "");
    await expect(
      resumeScenario("approval", {} as Snapshot<unknown>, { type: "APPROVE" }),
    ).rejects.toThrow(
      "Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY on the demo server to run examples. Missing: TYPESAFE_AI_API_KEY.",
    );
    vi.unstubAllEnvs();
  });
});

describe("Jev judgments", () => {
  test("routing asks one choice over the query; a pick below ROUTING_CONFIDENCE asks for clarification", async () => {
    const sure = createTestJudge({
      intent: { value: "technical", confidence: ROUTING_CONFIDENCE },
    });
    const routed = await start("routing", "The app crashes on settings.", {}, sure.model);
    expect((routed.output as { queue: string }).queue).toBe("technical");
    expect(sure.calls).toHaveLength(1);
    expect(sure.calls[0]!.state).toEqual({ query: "The app crashes on settings." });
    expect(Object.keys(sure.calls[0]!.questions)).toEqual(["intent"]);
    expect(sure.calls[0]!.questions.intent!.type).toBe("choice");

    const unsure = createTestJudge({
      intent: { value: "technical", confidence: ROUTING_CONFIDENCE - 0.01 },
    });
    const asked = await start("routing", "The app crashes on settings.", {}, unsure.model);
    expect((asked.output as { queue: string }).queue).toBe("unclear");
  });

  test("routing degrades to clarification when Jev fails", async () => {
    const judge = createTestJudge({});
    const result = await start("routing", "Help.", {}, judge.model);
    expect(result.status).toBe("done");
    expect(result.output).toEqual({ queue: "unclear", reason: "The classifier was unavailable." });
  });

  test("reflection scores the draft with one score and a boolean question per criterion; unmet criteria become feedback", async () => {
    const prompts: string[] = [];
    const judge = createTestJudge({
      quality: (state) => (state.draft === "Second." ? SCORE_THRESHOLD : SCORE_THRESHOLD - 1),
      concrete: CRITERION_THRESHOLD - 0.01,
      noFiller: CRITERION_THRESHOLD,
      controllingIdea: 0.9,
      rhythm: 0.9,
    });
    const result = await start(
      "reflection",
      "A night market in the rain.",
      {
        generateText: async (request) => {
          prompts.push(request.prompt ?? "");
          return { result: prompts.length === 1 ? "First." : "Second." };
        },
      },
      judge.model,
    );
    expect((result.output as { accepted: boolean; revisions: number }).accepted).toBe(true);
    expect((result.output as { revisions: number }).revisions).toBe(1);
    expect(judge.calls[0]!.state).toEqual({
      topic: "A night market in the rain.",
      draft: "First.",
    });
    expect(
      Object.fromEntries(Object.entries(judge.calls[0]!.questions).map(([k, q]) => [k, q.type])),
    ).toEqual({
      quality: "score",
      concrete: "boolean",
      noFiller: "boolean",
      controllingIdea: "boolean",
      rhythm: "boolean",
    });
    // Only the criterion under CRITERION_THRESHOLD reaches the writer.
    expect(prompts[1]).toContain("concrete, specific sensory detail");
    expect(prompts[1]).not.toContain("clichés");
  });

  test("a free-text review is one Jev choice; approve resumes, low confidence re-asks", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("TYPESAFE_AI_API_KEY", "test-key");
    const first = await start("approval", "Announce the outage.", writes("Heads up: an outage."));
    const snapshot = first.idle!.snapshot as unknown as Snapshot<unknown>;
    const review = { kind: "interpret", text: "looks good, ship it" } as const;

    const approve = createTestJudge({
      verdict: { value: "approve", confidence: REVIEW_CONFIDENCE },
    });
    const approved = await resumeScenario("approval", snapshot, review, undefined, approve.model);
    expect(approved.status).toBe("done");
    expect((approved.output as { published: boolean }).published).toBe(true);
    expect(approve.calls[0]!.state).toEqual({ review: "looks good, ship it" });
    expect(approve.calls[0]!.questions.verdict!.type).toBe("choice");

    const unsure = createTestJudge({
      verdict: { value: "approve", confidence: REVIEW_CONFIDENCE - 0.01 },
    });
    const echoed = await resumeScenario("approval", snapshot, review, undefined, unsure.model);
    expect(echoed.status).toBe("idle");
    vi.unstubAllEnvs();
  });
});
