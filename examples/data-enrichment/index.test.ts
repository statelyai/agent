import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  dataEnrichmentMachine,
  FIELDS,
  MAX_LOOPS,
  runDataEnrichmentExample,
  SAMPLE_WEB_INDEX,
  type Field,
} from "./index.js";

type Record4 = Record<Field, string | null>;

/**
 * A stand-in extractor that reads ONLY the passages it is handed: each
 * passage's recorded `facts` from the sample index. So the tests measure what
 * the search actually found, not what the script already knew.
 */
function extractFromPassages(request: AgentTextRequest): { record: Record4 } {
  const { passages } = request.input as { passages: string[] };
  const record: Record4 = { founded: null, headquarters: null, ceo: null, employees: null };
  for (const entry of SAMPLE_WEB_INDEX) {
    if (passages.some((passage) => passage.endsWith(entry.text)))
      Object.assign(record, entry.facts);
  }
  return { record };
}

/** A query naming the company and the fields it still needs. */
function queryForMissing(request: AgentTextRequest): { query: string } {
  const { company, missingFields } = request.input as { company: string; missingFields: string[] };
  return { query: `${company} ${missingFields.join(" ")}` };
}

/** Model mocked by request name; the search actor runs its real keyword logic. */
function scripted(reviewRecord: unknown[] = [{ satisfactory: true, feedback: "Supported." }]) {
  return createMockModelExecutors({
    text: {
      planSearch: queryForMissing,
      extractRecord: extractFromPassages,
      reviewRecord,
    },
  }).generateText;
}

test("fully covered company: one search pass, reviewed, done", async () => {
  const result = await runDataEnrichmentExample({
    company: "Northwind Robotics",
    generateText: scripted(),
  });
  expect(result.progress).toEqual([
    "planningSearch",
    "searching",
    "extracting",
    "reflecting",
    "done",
  ]);
  expect(result.loops).toBe(1);
  expect(result.missingFields).toEqual([]);
  expect(result.record).toEqual({
    founded: "2014",
    headquarters: "Pittsburgh, Pennsylvania",
    ceo: "Dana Okafor",
    employees: "about 320",
  });
  expect(result.summary).toContain("Founded: 2014");
  expect(result.summary).toContain("CEO: Dana Okafor");
});

test("partially covered company: a missing field sends the loop back to search", async () => {
  const result = await runDataEnrichmentExample({
    company: "Bluefin Analytics",
    generateText: scripted(),
  });
  expect(result.progress).toEqual([
    "planningSearch",
    "searching",
    "extracting",
    "planningSearch",
    "searching",
    "extracting",
    "reflecting",
    "done",
  ]);
  expect(result.loops).toBe(2);
  expect(result.record.headquarters).toBe("Lisbon, Portugal");
});

test("a field missing everywhere spends MAX_LOOPS and ends in `failed` with the partial record", async () => {
  const result = await runDataEnrichmentExample({
    company: "Cedar Grid Energy",
    generateText: scripted(),
  });
  expect(result.finalState).toBe("failed");
  expect(result.loops).toBe(MAX_LOOPS);
  expect(result.progress.filter((state) => state === "searching")).toHaveLength(MAX_LOOPS);
  // An incomplete record is never sent for review.
  expect(result.progress).not.toContain("reflecting");
  expect(result.missingFields).toEqual(["employees"]);
  expect(result.record).toMatchObject({ founded: "2008", ceo: "Marcus Bell" });
  expect(result.summary).toContain("Employees: (not found)");
  expect(result.summary).toContain("Search budget spent");
});

test("requesting fewer fields changes what counts as complete", async () => {
  const result = await runDataEnrichmentExample({
    company: "Cedar Grid Energy",
    fields: ["founded", "headquarters", "ceo"],
    generateText: scripted(),
  });
  expect(result.finalState).toBe("done");
  expect(result.loops).toBe(2);
  expect(result.summary).not.toContain("Employees");
});

test("a reviewer rejection costs a search pass, then the record is accepted", async () => {
  const result = await runDataEnrichmentExample({
    company: "Northwind Robotics",
    generateText: scripted([
      { satisfactory: false, feedback: "Confirm the headcount." },
      { satisfactory: true, feedback: "Supported." },
    ]),
  });
  expect(result.finalState).toBe("done");
  expect(result.loops).toBe(2);
  expect(result.progress.filter((state) => state === "reflecting")).toHaveLength(2);
});

test("a reviewer that never accepts exhausts the budget → `failed`", async () => {
  const result = await runDataEnrichmentExample({
    company: "Northwind Robotics",
    generateText: scripted([{ satisfactory: false, feedback: "Values look stale." }]),
  });
  expect(result.finalState).toBe("failed");
  expect(result.loops).toBe(MAX_LOOPS);
  expect(result.missingFields).toEqual([]);
  expect(result.summary).toContain("Values look stale.");
});

test("a failing extraction ends in `failed` with the reason", async () => {
  const result = await runDataEnrichmentExample({
    company: "Northwind Robotics",
    generateText: createMockModelExecutors({
      text: {
        planSearch: queryForMissing,
        extractRecord: () => {
          throw new Error("model unavailable");
        },
      },
    }).generateText,
  });
  expect(result.finalState).toBe("failed");
  expect(result.summary).toContain("extractRecord failed");
  expect(result.missingFields).toEqual([...FIELDS]);
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as Array<{ label: string; input: { company: string } }>;
  expect(starters).toHaveLength(3);
  for (const starter of starters) {
    const result = await runDataEnrichmentExample({
      company: starter.input.company,
      generateText: scripted(),
    });
    if (starter.label.startsWith("Fully covered")) {
      expect(result.finalState).toBe("done");
      expect(result.loops).toBe(1);
    } else if (starter.label.startsWith("Partially covered")) {
      expect(result.finalState).toBe("done");
      expect(result.loops).toBeGreaterThan(1);
    } else {
      expect(starter.label).toContain("failed");
      expect(result.finalState).toBe("failed");
      expect(result.loops).toBe(MAX_LOOPS);
    }
  }
});

test("machine is structurally sound", () => {
  lintAgentMachine(dataEnrichmentMachine, { throw: true });
});
