import { expect, test } from "vitest";
import { createMockModelExecutors } from "../mock-model.js";
import { runTicTacToeExample } from "./index.js";
import { CLIMB } from "./test-doubles.js";

test("runTicTacToeExample: v0 refuted, the climb ends proven", { timeout: 60_000 }, async () => {
  const lines: string[] = [];
  const executors = createMockModelExecutors({
    text: { proposePolicy: [CLIMB.v1, CLIMB.v2, CLIMB.v3, CLIMB.v3] },
  });
  const result = await runTicTacToeExample({ executors, log: (line) => lines.push(line) });
  expect(lines[0]).toMatch(/^v0 refuted in \d+ms: X 0, O 1, X 3, O 2, X 6/);
  expect(lines.at(-1)).toBe("ttt-policy-v3: PROVEN never to lose");
  expect(result.rounds.filter((round) => round.promoted)).toHaveLength(3);
});
