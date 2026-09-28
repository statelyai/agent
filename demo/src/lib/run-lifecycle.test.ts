/**
 * Run-lifecycle behavior the example sweep cannot reach: a user cancelling a
 * run mid-flight, the wall-clock budget cutting a run short, and an invoked
 * child machine keeping its state across chat turns. Driven through the same
 * demo server entry points as the sweep, with the provider layer replaced by
 * the test doubles plus one model call that can be made to hang.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Snapshot } from "xstate";
import { getExampleMachine } from "./example-library.server";
import { resumeMachineChat, startMachineChat } from "./machine-chat.server";
import { resetGenericModels } from "./test-generic-models";

// Controls the language model: `hangFromCall` makes that call (1-based) and
// every later one wait until the run's abort signal fires.
const control = vi.hoisted(() => ({
  calls: 0,
  hangFromCall: Number.POSITIVE_INFINITY,
  onHang: undefined as (() => void) | undefined,
}));

vi.mock("@ai-sdk/openai", async () => {
  const { genericLanguageModel } = await import("./test-generic-models");
  const model = (modelId: string) => {
    const inner = genericLanguageModel(modelId);
    // Captured before wrapping: the wrappers below replace these on `inner`.
    const generate = inner.doGenerate.bind(inner);
    const stream = inner.doStream.bind(inner);
    const hangOrAnswer = async <T>(
      options: { abortSignal?: AbortSignal },
      answer: () => PromiseLike<T>,
    ): Promise<T> => {
      control.calls += 1;
      if (control.calls < control.hangFromCall) return answer();
      control.onHang?.();
      return new Promise<T>((_, reject) => {
        const signal = options.abortSignal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    return Object.assign(inner, {
      doGenerate: (options: Parameters<typeof inner.doGenerate>[0]) =>
        hangOrAnswer(options, () => generate(options)),
      doStream: (options: Parameters<typeof inner.doStream>[0]) =>
        hangOrAnswer(options, () => stream(options)),
    });
  };
  const openai = Object.assign(model, { chat: model, responses: model });
  return { openai, createOpenAI: () => openai };
});

vi.mock("@ai-sdk/typesafe-ai", async () => {
  const { genericEvaluationModel } = await import("./test-generic-models");
  const provider = { evaluationModel: () => genericEvaluationModel() };
  return { typeSafeAi: provider, createTypeSafeAi: () => provider };
});

beforeAll(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  vi.stubEnv("TYPESAFE_AI_API_KEY", "test-typesafe-key");
  vi.stubEnv("OPENAI_MODEL", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
});
beforeEach(() => {
  resetGenericModels();
  control.calls = 0;
  control.hangFromCall = Number.POSITIVE_INFINITY;
  control.onHang = undefined;
});

describe("cancellation and the time budget", () => {
  test("a user cancel mid-run stops the run and returns the work so far", async () => {
    const machine = await getExampleMachine("prompt-chaining", "promptChainingMachine");
    const cancel = new AbortController();
    // The first model call (the joke) lands; the second hangs until cancelled.
    control.hangFromCall = 2;
    control.onHang = () => cancel.abort(new Error("user cancelled"));

    const result = await startMachineChat(machine, { topic: "cats" }, { signal: cancel.signal });

    expect(result.status).toBe("error");
    expect(result.response).toMatch(/^Run cancelled\. Work so far:/);
    // The joke the first call produced is the work shown.
    expect(result.response).toContain("mock joke");
    // The trace kept the transitions that happened before the cancel.
    expect(result.trace.some((entry) => entry.event.type.includes("done"))).toBe(true);
  });

  test("the wall-clock budget stops a hung run and says which limit fired", async () => {
    const machine = await getExampleMachine("prompt-chaining", "promptChainingMachine");
    control.hangFromCall = 1;

    const result = await startMachineChat(machine, { topic: "cats" }, { budgetMs: 1000 });

    expect(result.status).toBe("error");
    expect(result.response).toBe("Run stopped at its 1s time budget.");
  });
});

describe("resuming across chat turns", () => {
  test("an invoked child machine keeps its state from one turn to the next", async () => {
    const machine = await getExampleMachine("game-loop-agent", "gameMachine");
    const notesOf = (snapshot: unknown): string[] =>
      (
        snapshot as {
          children: Record<string, { snapshot: { context: { notes: string[] } } }>;
        }
      ).children.player!.snapshot.context.notes;

    let result = await startMachineChat(machine, { seed: 11 });
    expect(result.status).toBe("idle");
    const before = notesOf(result.idle!.snapshot);

    result = await resumeMachineChat(
      machine,
      result.idle!.snapshot as unknown as Snapshot<unknown>,
      { type: "HUMAN_ROLL" },
    );
    expect(result.status).toBe("idle");
    const after = notesOf(result.idle!.snapshot);

    // The player agent saw the human's roll, and remembers everything it saw
    // before it: the child was carried across the turn, not restarted.
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toMatch(/^human rolled/);
  });
});
