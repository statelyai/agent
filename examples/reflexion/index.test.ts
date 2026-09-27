import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentRequestExecutors, type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import { MAX_REVISIONS, reflexionMachine, runReflexionExample, searchIndex } from "./index.js";

/**
 * Only the model is mocked, keyed by REQUEST NAME (`draft` / `revise`). The
 * `searchWeb` actor runs the real keyword search over the sample index, so
 * which passages exist to cite is decided by the index, not the script.
 */
const draft = {
  answer: "Pick a tool and let everyone use it.",
  reflection: { missing: "No rollout plan, no security rules.", superfluous: "Nothing." },
  searchQueries: ["small team roll out pilot", "security secrets credentials"],
};

const revision = (answer: string, references: string[], searchQueries: string[]) => ({
  answer,
  reflection: { missing: "How to measure whether it pays off.", superfluous: "None." },
  searchQueries,
  references,
});

test("draft → search → revise, looped until MAX_REVISIONS, with grounded citations", async () => {
  const scripted = createMockModelExecutors({
    text: {
      draft: [draft],
      revise: [
        revision(
          "Run a pilot [S1]; keep secrets out of prompts [S3].",
          ["S1", "S3"],
          ["measure pays off cycle time"],
        ),
        revision(
          "Pilot [S1], secrets [S3], measure cycle time [S5].",
          ["S1", "S3", "S5"],
          ["cost seats"],
        ),
      ],
    },
  });
  const result = await runReflexionExample({ generateText: scripted.generateText });

  expect(result.progress.at(-1)).toBe("done");
  expect(result.revisions).toBe(MAX_REVISIONS);
  expect(result.answer).toBe("Pilot [S1], secrets [S3], measure cycle time [S5].");
  expect(result.references.map((reference) => reference.slice(0, 4))).toEqual([
    "[S1]",
    "[S3]",
    "[S5]",
  ]);
  // Two search rounds, each feeding the next revision.
  expect(result.progress.filter((state) => state === "searching")).toHaveLength(MAX_REVISIONS);
  expect(result.progress.filter((state) => state === "revising")).toHaveLength(MAX_REVISIONS);

  // The revisor saw the reflection AND the numbered search results.
  const [firstRevise, secondRevise] = scripted.calls.filter((call) => call.name === "revise");
  const firstInput = firstRevise!.input as { reflection: { missing: string }; results: string };
  expect(firstInput.reflection.missing).toBe("No rollout plan, no security rules.");
  expect(firstInput.results).toContain(
    "Query: small team roll out pilot\n  [S1] [sample web result]",
  );
  expect(firstInput.results).toContain("[S3] [sample web result] Security");
  // The second search ran the revisor's NEW queries.
  expect((secondRevise!.input as { results: string }).results).toContain(
    "Query: measure pays off cycle time",
  );
  expect(result.trail).toContain("Draft:; missing: No rollout plan, no security rules.");
  expect(result.trail).toContain("Revision 2: cites [S1, S3, S5]");
});

test("citations to passages the run never retrieved are dropped", async () => {
  const result = await runReflexionExample({
    generateText: createMockModelExecutors({
      text: {
        draft: [draft],
        // S7 exists in the index but no search returned it; S42 does not exist.
        revise: [
          revision("Pilot [S1]; tests first [S7]; proven [S42].", ["S1", "S7", "S42"], ["x"]),
        ],
      },
    }).generateText,
  });

  expect(result.progress.at(-1)).toBe("done");
  expect(result.references).toHaveLength(1);
  expect(result.references[0]).toMatch(/^\[S1\] Small teams/);
  expect(result.trail).toContain("dropped unretrieved: S7, S42");
});

test("the loop is bounded: revisions stop at MAX_REVISIONS even with queries left", async () => {
  const scripted = createMockModelExecutors({
    text: { draft: [draft], revise: [revision("Better.", [], ["more", "and more"])] },
  });
  const result = await runReflexionExample({ generateText: scripted.generateText });

  expect(result.progress.at(-1)).toBe("done");
  expect(scripted.calls.filter((call) => call.name === "revise")).toHaveLength(MAX_REVISIONS);
  expect(scripted.calls.filter((call) => call.name === "draft")).toHaveLength(1);
});

test("a draft error lands in failed with no answer", async () => {
  const down: AgentRequestExecutors["generateText"] = async () => {
    throw new Error("model offline");
  };
  const result = await runReflexionExample({ generateText: down });
  expect(result.progress.at(-1)).toBe("failed");
  expect(result.answer).toContain("No answer: draft failed");
  expect(result.revisions).toBe(0);
});

test("a revise error lands in failed but keeps the latest answer", async () => {
  const scripted = createMockModelExecutors({
    text: {
      draft: [draft],
      revise: [
        revision("Pilot first [S1].", ["S1"], ["security"]),
        () => {
          throw new Error("model offline");
        },
      ],
    },
  });
  const result = await runReflexionExample({ generateText: scripted.generateText });
  expect(result.progress.at(-1)).toBe("failed");
  expect(result.answer).toBe("Pilot first [S1].");
  expect(result.revisions).toBe(1);
  expect(result.references[0]).toMatch(/^\[S1\]/);
  expect(result.trail).toContain("Failed: revise failed");
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  expect(starters.length).toBeGreaterThanOrEqual(3);
  const expected: Record<string, string> = {
    "How should a small team roll out an AI coding assistant?": "S1",
    "What security and licensing risks come with AI coding assistants?": "S4",
    "How can a team tell whether an AI coding assistant pays off?": "S5",
  };
  for (const starter of starters) {
    // The sample index answers each starter on its own words...
    expect(searchIndex(starter).map((passage) => passage.id)).toContain(expected[starter]);
    // ...and a full run that searches on the question cites what it found.
    const result = await runReflexionExample({
      question: starter,
      generateText: createMockModelExecutors({
        text: {
          draft: [{ ...draft, searchQueries: [starter] }],
          revise: [
            (request: AgentTextRequest) => {
              const results = (request.input as { results: string }).results;
              const ids = [...results.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]!);
              return revision("Grounded answer.", ids, [starter]);
            },
          ],
        },
      }).generateText,
    });
    expect(result.progress.at(-1)).toBe("done");
    expect(
      result.references.some((reference) => reference.startsWith(`[${expected[starter]}]`)),
    ).toBe(true);
  }
});

test("machine lints clean", () => {
  lintAgentMachine(reflexionMachine, { throw: true, warnings: true });
});
