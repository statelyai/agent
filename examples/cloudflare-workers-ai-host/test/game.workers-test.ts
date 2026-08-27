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
import { runCloudflareGameTurn, type Env } from "../index.js";

/** Answers keyed by what the serialized prompt is asking for. */
function stubAi(): Env["AI"] {
  return {
    async run(model: string, input: Record<string, unknown>) {
      // The machine's symbolic ref (`moveChooser`) is mapped to a Workers AI id.
      expect(model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      const prompt = String(input.prompt ?? "");

      // Decision effect: the legal events are serialized into the prompt.
      if (prompt.includes("Choose exactly one legal event")) {
        return { response: JSON.stringify({ type: "ATTACK" }) };
      }
      // Text effect: structured output, JSON in the response body.
      return {
        response: JSON.stringify({
          summary: "You strike first and the goblin staggers.",
          enemyHp: 5,
          playerHp: 20,
        }),
      };
    },
  };
}

describe("cloudflare workers AI host", () => {
  it("runs a game turn by replaying the journal", async () => {
    const output = await runCloudflareGameTurn({ AI: stubAi() }, { playerHp: 20, enemyHp: 15 });

    expect(output).toMatchObject({ playerHp: 20, enemyHp: 5 });
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
        return {
          response: JSON.stringify({ summary: "A hit lands.", enemyHp: 5, playerHp: 20 }),
        };
      },
    };

    const output = await runCloudflareGameTurn({ AI: ai }, { playerHp: 20, enemyHp: 15 });

    expect(decisionCalls).toBeGreaterThan(1);
    expect(output).toMatchObject({ enemyHp: 5 });
  });
});
