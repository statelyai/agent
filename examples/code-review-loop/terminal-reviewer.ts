/**
 * The person at the terminal (run.ts): answers a run waiting in `humanReview`
 * by reading one line. Only answers the snapshot accepts are offered; at the
 * hard round ceiling REQUEST_CHANGES is refused, so `r` is not offered.
 */
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AnyMachineSnapshot } from "xstate";
import type { ChosenEvent } from "@statelyai/agent";
import type { HumanReviewer } from "./bench.js";
import { MAX_TOTAL_ROUNDS, type ReviewContext } from "./environment.js";

type Answer = { key: string; hint: string; event: (rest: string) => ChosenEvent };

const ANSWERS: Answer[] = [
  { key: "a", hint: "[a]pprove as-is", event: () => ({ type: "APPROVE" }) },
  {
    key: "r",
    hint: "[r] <notes> request changes",
    event: (notes) => ({ type: "REQUEST_CHANGES", notes: notes || "Try again." }),
  },
  {
    key: "x",
    hint: "[x] reject",
    event: () => ({ type: "REJECT", reason: "rejected at the terminal" }),
  },
];

/** Asks on `input`: ship as-is, request changes, or reject; empty leaves the run waiting. */
export function createTerminalReviewer(
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): HumanReviewer & { close(): void } {
  const rl = createInterface({ input: io.input, output: io.output });
  const print = (line: string) => io.output.write(`${line}\n`);
  const ask = async (snapshot: AnyMachineSnapshot): Promise<ChosenEvent | undefined> => {
    const context = snapshot.context as ReviewContext;
    print(`\n── ${context.task.id} needs a person ── ${context.escalation}`);
    for (const issue of context.review?.issues ?? [])
      print(`  reviewer [${issue.severity}] ${issue.note}`);
    if (context.checks && !context.checks.passed) print(`  checks: ${context.checks.output}`);
    print(`  patch (${context.task.file}):\n${context.patch.replace(/^/gm, "    | ")}`);

    const offered = ANSWERS.filter((answer) => snapshot.can(answer.event("") as never));
    const refused = ANSWERS.filter((answer) => !offered.includes(answer));
    if (refused.some((answer) => answer.key === "r")) {
      print(
        `  Requesting changes is unavailable: round ${context.round} is the hard ceiling ` +
          `(${MAX_TOTAL_ROUNDS} rounds). Ship as-is or reject.`,
      );
    }
    const prompt = `  ${[...offered.map((a) => a.hint), "[enter] leave waiting"].join(", ")}: `;
    for (;;) {
      const line = (await rl.question(prompt)).trim();
      if (!line) return undefined;
      const answer = offered.find((a) => line === a.key || line.startsWith(`${a.key} `));
      if (answer) return answer.event(line.slice(answer.key.length).trim());
      print(`  '${line}' is not one of the offered answers.`);
    }
  };
  return Object.assign(ask, { close: () => rl.close() });
}
