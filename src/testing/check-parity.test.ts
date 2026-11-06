import { describe, expect, test } from "vitest";
import { wrapWorkflow } from "../index.js";
import { checkParity, RecordingDivergenceError } from "./index.js";

interface Ticket {
  orderId: string;
  amount: number;
}

function createEffects(total = 50) {
  return {
    lookupOrder: async (orderId: string) => ({ orderId, total }),
    issueRefund: async (refund: Ticket) => ({ refundId: `R-${refund.orderId}` }),
  };
}
type Effects = ReturnType<typeof createEffects>;

async function legacy(ticket: Ticket, effects: Effects) {
  const order = await effects.lookupOrder(ticket.orderId);
  if (ticket.amount > order.total) return { outcome: "declined" as const };
  const { refundId } = await effects.issueRefund(ticket);
  return { outcome: "refunded" as const, refundId };
}

const scenarios = [
  { id: "refund", input: { orderId: "A-1", amount: 20 }, total: 50 },
  { id: "over-total", input: { orderId: "A-2", amount: 80 }, total: 50 },
];

describe("checkParity", () => {
  test("a wrapped workflow is equivalent to itself", async () => {
    let calls = 0;
    const step0 = wrapWorkflow({ id: "support", effects: createEffects(), run: legacy });
    const report = await checkParity({
      scenarios,
      effects: (scenario) => {
        const effects = createEffects(scenario.total);
        return {
          ...effects,
          issueRefund: async (refund: Ticket) => {
            calls++;
            return effects.issueRefund(refund);
          },
        };
      },
      before: legacy,
      after: (input, effects) => step0.run(input, { effects }),
    });
    expect(report.equivalent).toBe(true);
    expect(report.scenarios.map((row) => [row.id, row.equivalent, row.before])).toEqual([
      ["refund", true, { output: { outcome: "refunded", refundId: "R-A-1" } }],
      ["over-total", true, { output: { outcome: "declined" } }],
    ]);
    expect(report.scenarios[0]!.after).toEqual(report.scenarios[0]!.before);
    // Only `before` really ran the effect; `after` replayed it.
    expect(calls).toBe(1);
    expect(report.scenarios[0]!.recording.effects.map((effect) => effect.kind)).toEqual([
      "call",
      "call",
      "output",
    ]);
  });

  test("a port that calls an effect with different args diverges", async () => {
    const report = await checkParity({
      scenarios: scenarios.slice(0, 1),
      effects: (scenario) => createEffects(scenario.total),
      before: legacy,
      after: async (ticket, effects) => {
        await effects.lookupOrder(ticket.orderId.toLowerCase());
        const { refundId } = await effects.issueRefund(ticket);
        return { outcome: "refunded" as const, refundId };
      },
    });
    expect(report.equivalent).toBe(false);
    expect(report.scenarios[0]!.divergences.map((d) => d.reason)).toEqual(["call-args"]);
  });

  test("a port that skips an effect or returns something else diverges", async () => {
    const report = await checkParity({
      scenarios: scenarios.slice(0, 1),
      effects: (scenario) => createEffects(scenario.total),
      before: legacy,
      after: async (ticket, effects) => {
        await effects.lookupOrder(ticket.orderId);
        return { outcome: "declined" as const };
      },
    });
    expect(report.scenarios[0]!.divergences.map((d) => d.reason)).toEqual([
      "missing-effect",
      "output",
    ]);
  });

  test("a port that throws is a row, not a throw", async () => {
    const report = await checkParity({
      scenarios: scenarios.slice(0, 1),
      effects: (scenario) => createEffects(scenario.total),
      before: legacy,
      after: async (ticket, effects) => {
        // A second lookup the original never made: replay cannot answer it.
        await effects.lookupOrder(ticket.orderId);
        await effects.lookupOrder(ticket.orderId);
        return "unreachable";
      },
    });
    const [row] = report.scenarios;
    expect(row!.equivalent).toBe(false);
    expect("error" in row!.after && row!.after.error).toBeInstanceOf(RecordingDivergenceError);
    // The second lookup stands where `issueRefund` was, and no output was recorded.
    expect(row!.divergences.map((d) => d.reason)).toEqual(["call-name", "output"]);
    expect(row!.divergences[1]!.message).toContain("the port threw RecordingDivergenceError");
  });

  test("one side throwing is an output divergence that names the error", async () => {
    const config = {} as { run: () => string };
    const portThrew = await checkParity({
      scenarios: scenarios.slice(0, 1),
      effects: (scenario) => createEffects(scenario.total),
      before: legacy,
      after: async () => config.run(),
    });
    // The two effect calls it never made, then the output it never returned.
    expect(portThrew.scenarios[0]!.divergences.map((d) => d.reason)).toEqual([
      "missing-effect",
      "missing-effect",
      "output",
    ]);
    expect(portThrew.scenarios[0]!.divergences[2]!.message).toBe(
      'The original returned {"outcome":"refunded","refundId":"R-A-1"}; the port threw TypeError: config.run is not a function.',
    );
    const originalThrew = await checkParity({
      scenarios: [{ id: "x", input: null }],
      effects: () => ({}),
      before: async (): Promise<string> => {
        throw new Error("legacy broke");
      },
      after: async () => "ok",
    });
    expect(originalThrew.scenarios[0]!.divergences).toEqual([
      expect.objectContaining({
        reason: "output",
        message: 'The original threw Error: legacy broke; the port returned "ok".',
      }),
    ]);
  });

  test("both sides throwing match on name and message", async () => {
    const failing = (message: string) => async (): Promise<never> => {
      throw new Error(message);
    };
    const same = await checkParity({
      scenarios: [{ id: "x", input: null }],
      effects: () => ({}),
      before: failing("nope"),
      after: failing("nope"),
    });
    expect(same.equivalent).toBe(true);
    const different = await checkParity({
      scenarios: [{ id: "x", input: null }],
      effects: () => ({}),
      before: failing("nope"),
      after: failing("other"),
    });
    expect(different.scenarios[0]!.divergences).toEqual([
      expect.objectContaining({ reason: "output", message: expect.stringContaining("other") }),
    ]);
  });

  test("normalizeError pins what differs in an error run to run", async () => {
    let run = 0;
    const failing = async (): Promise<never> => {
      throw new Error(`request failed\n    at handler (worker.ts:${++run}:7)`);
    };
    const options = {
      scenarios: [{ id: "x", input: null }],
      effects: () => ({}),
      before: failing,
      after: failing,
    };
    expect((await checkParity(options)).equivalent).toBe(false);
    const report = await checkParity({
      ...options,
      normalizeError: (error) => (error as Error).message.split("\n")[0],
    });
    expect(report.equivalent).toBe(true);
    // Rows keep the raw errors.
    const row = report.scenarios[0]!;
    expect("error" in row.after && (row.after.error as Error).message).toContain("worker.ts:4");
  });

  test("a normalizeError result that cannot be plain JSON still compares", async () => {
    const failing = async (): Promise<never> => {
      throw new Error("nope");
    };
    const report = await checkParity({
      scenarios: [{ id: "x", input: null }],
      effects: () => ({}),
      before: failing,
      after: failing,
      normalizeError: (error) => {
        const value: Record<string, unknown> = { message: (error as Error).message };
        value.self = value;
        return value;
      },
    });
    expect(report.equivalent).toBe(true);
  });

  test("normalizeOutput pins what differs run to run", async () => {
    let clock = 0;
    const timed = async (ticket: Ticket, effects: Effects) => ({
      ...(await legacy(ticket, effects)),
      durationMs: ++clock,
    });
    const options = {
      scenarios,
      effects: (scenario: (typeof scenarios)[number]) => createEffects(scenario.total),
      before: timed,
      after: timed,
    };
    expect((await checkParity(options)).equivalent).toBe(false);
    const report = await checkParity({
      ...options,
      normalizeOutput: (output) => ({ ...(output as object), durationMs: 0 }),
    });
    expect(report.equivalent).toBe(true);
    // Rows keep the raw outputs.
    expect(report.scenarios[0]!.before).toMatchObject({
      output: { durationMs: expect.any(Number) },
    });
  });
});
