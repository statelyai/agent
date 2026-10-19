/** The terminal reviewer over a fake stdin: it offers only the answers the snapshot accepts. */
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { MAX_TOTAL_ROUNDS, codeReviewLoopMachine } from "./environment.js";
import { createTerminalReviewer } from "./terminal-reviewer.js";
import { reviewContext } from "./test-doubles.js";

/** Answers each prompt with the next line; returns everything printed. */
function fakeTerminal(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => {
    printed += chunk.toString();
    if (chunk.toString().endsWith("leave waiting: ")) input.write(`${lines.shift() ?? ""}\n`);
  });
  return { io: { input, output }, printed: () => printed };
}

const waitingAt = (round: number) =>
  codeReviewLoopMachine.resolveState({
    value: "humanReview",
    context: reviewContext({ round, roundLimit: round, escalation: "Round cap." }),
  });

describe("the terminal reviewer", () => {
  test("under the ceiling, r <notes> requests changes", async () => {
    const terminal = fakeTerminal(["r trim the dashes"]);
    const reviewer = createTerminalReviewer(terminal.io);
    await expect(reviewer(waitingAt(3))).resolves.toEqual({
      type: "REQUEST_CHANGES",
      notes: "trim the dashes",
    });
    reviewer.close();
    expect(terminal.printed()).toContain("[r] <notes> request changes");
  });

  test("at the hard ceiling, r is not offered, says why, and a typed r is refused locally", async () => {
    const snapshot = waitingAt(MAX_TOTAL_ROUNDS);
    expect(snapshot.can({ type: "REQUEST_CHANGES", notes: "again" })).toBe(false);
    const terminal = fakeTerminal(["r again", "a"]);
    const reviewer = createTerminalReviewer(terminal.io);
    await expect(reviewer(snapshot)).resolves.toEqual({ type: "APPROVE" });
    reviewer.close();
    const printed = terminal.printed();
    expect(printed).not.toContain("[r] <notes> request changes");
    expect(printed).toContain("Requesting changes is unavailable");
    expect(printed).toContain("'r again' is not one of the offered answers.");
  });
});
