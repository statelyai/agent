import type { DiagramHints } from "./scenarios";

/** Targets of function transitions in the plain XState example. */
export const exampleDiagramHints: Record<string, DiagramHints> = {
  "plain-xstate": {
    drafting: [
      { event: "writeDraft ✓", targets: ["judging"] },
      { event: "writeDraft ✗ (retries remain)", targets: ["retrying"] },
      { event: "writeDraft ✗ (budget exhausted)", targets: ["failed"] },
    ],
    judging: [{ event: "REVISE (under limit)", targets: ["drafting"] }],
  },
};
