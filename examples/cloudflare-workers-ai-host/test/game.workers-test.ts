/**
 * Runs the replay loop in real workerd (via @cloudflare/vitest-plugin).
 *
 * The `AI` binding is stubbed here on purpose: `env.AI` proxies to the live
 * Cloudflare account even under `wrangler dev`, so a test that used it would be
 * a billed network call with non-deterministic output. What this asserts is the
 * part that is this host's own: the journal-and-replay loop, the prompt-encoded
 * event choice, and the JSON parsing on the way back.
 */
import { describe, expect, it } from "vitest";
import { runCloudflareGameTurn, toAgentCallUsage, type Env } from "../index.js";

/** Answers keyed by what the serialized prompt is asking for. */
function stubAi(): Env["AI"] {
  return {
    async run(model: string, input: Record<string, unknown>) {
      // The machine's symbolic ref (`moveChooser`) is mapped to a Workers AI id.
      expect(model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      const prompt = String(input.prompt ?? "");

      // Decision effect: the legal events are serialized into the prompt.
      if (prompt.includes("Choose exactly one legal event")) {
        return {
          response: JSON.stringify({ type: "ATTACK" }),
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        };
      }
      // Text effect: structured output (narration only — HP is the machine's).
      return {
        response: JSON.stringify({ summary: "You strike first and the goblin staggers." }),
        usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
      };
    },
  };
}

describe("toAgentCallUsage", () => {
  it("maps Workers AI token counts onto the flat AgentCallUsage fields", () => {
    expect(toAgentCallUsage({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })).toEqual(
      { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    );
  });

  it("sums a missing total, and reports nothing when the model reports nothing", () => {
    expect(toAgentCallUsage({ prompt_tokens: 3, completion_tokens: 2 })).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    });
    expect(toAgentCallUsage(undefined)).toBeUndefined();
    expect(toAgentCallUsage({})).toBeUndefined();
  });
});

describe("cloudflare workers AI host", () => {
  it("runs a game turn by replaying the journal", async () => {
    const { output } = await runCloudflareGameTurn({ AI: stubAi() }, { playerHp: 20, enemyHp: 15 });

    // 6 damage dealt, 4 taken from the counter — computed by the machine.
    expect(output).toMatchObject({ playerHp: 16, enemyHp: 9 });
  });

  it("reports the tokens every call billed", async () => {
    const { usage } = await runCloudflareGameTurn({ AI: stubAi() }, { playerHp: 20, enemyHp: 15 });

    // One decision (14) plus one summary (26).
    expect(usage).toMatchObject({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
  });

  it("surfaces a decision response that never parses instead of inventing an event", async () => {
    let decisionCalls = 0;
    const ai: Env["AI"] = {
      async run(_model: string, input: Record<string, unknown>) {
        const prompt = String(input.prompt ?? "");
        if (prompt.includes("Choose exactly one legal event")) {
          decisionCalls += 1;
          return { response: "still not json" };
        }
        return { response: JSON.stringify({ summary: "A hit lands." }) };
      },
    };

    const { output } = await runCloudflareGameTurn({ AI: ai }, { playerHp: 20, enemyHp: 15 });

    // The host asked again, still got prose, and threw rather than feeding a
    // fabricated `<unparsed response: …>` event to the machine — so the
    // decision invoke errored and the machine took its own `onError` path.
    expect(decisionCalls).toBe(2);
    expect(output.summary).toContain("fumbled");
    // No HP moved: nothing was ever chosen.
    expect(output).toMatchObject({ playerHp: 20, enemyHp: 15 });
  });

  it("retries a malformed decision response with feedback", async () => {
    let decisionCalls = 0;
    const ai: Env["AI"] = {
      async run(_model: string, input: Record<string, unknown>) {
        const prompt = String(input.prompt ?? "");
        if (prompt.includes("Choose exactly one legal event")) {
          decisionCalls += 1;
          return {
            response: decisionCalls === 1 ? "not json at all" : JSON.stringify({ type: "ATTACK" }),
          };
        }
        return { response: JSON.stringify({ summary: "A hit lands." }) };
      },
    };

    const { output } = await runCloudflareGameTurn({ AI: ai }, { playerHp: 20, enemyHp: 15 });

    expect(decisionCalls).toBeGreaterThan(1);
    expect(output).toMatchObject({ enemyHp: 9 });
  });
});
