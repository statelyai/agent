import { expect, test } from "vitest";
import { getExampleDetail, listExampleSummaries } from "./example-library.server";

test.each([
  ["consensus-review", "consensusReviewMachine"],
  ["booking-compensation", "bookingCompensationMachine"],
] as const)("%s exposes its machine, inputs, and source to the demo", async (id, exportName) => {
  const detail = await getExampleDetail(id);
  expect(detail.importError).toBeNull();
  const machine = detail.machines.find((entry) => entry.exportName === exportName);
  expect(machine).toBeDefined();
  expect(machine?.vizConfig).toBe(detail.source);
  expect(machine?.inputJsonSchema).toBeDefined();
  expect(listExampleSummaries().find((entry) => entry.id === id)?.starters.length).toBeGreaterThan(
    0,
  );
});

test("scheduler example is excluded from generic chat because the host must supply a trusted clock", () => {
  expect(listExampleSummaries().map((entry) => entry.id)).not.toContain("deadline-escalation");
});
