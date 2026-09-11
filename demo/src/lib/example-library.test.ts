import { describe, expect, it } from "vitest";
import {
  getExampleDetail,
  isAuthoredInSource,
  listExampleSummaries,
  machineInitializer,
} from "./example-library.server";

describe("example library auto-discovery", () => {
  it("discovers every examples/* folder with an index.ts", () => {
    const summaries = listExampleSummaries();
    const ids = summaries.map((summary) => summary.id);
    expect(ids).toContain("joke");
    expect(ids).toContain("plan-and-execute");
    expect(ids.length).toBeGreaterThan(40);
    // Sorted by title for the sidebar.
    const titles = summaries.map((summary) => summary.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  it("extracts exported machines and source for an example", async () => {
    const detail = await getExampleDetail("joke");
    expect(detail.importError).toBeNull();
    expect(detail.source).toContain("createMachine");
    const machine = detail.machines.find((entry) => entry.exportName === "jokeMachine");
    expect(machine).toBeDefined();
    expect(machine!.vizConfig).toBe(detail.source);
  });

  it("serializes a JSON-authored machine's config for Viz (no createMachine in source)", async () => {
    const detail = await getExampleDetail("json-agent");
    const machine = detail.machines.find((entry) => entry.exportName === "jsonAgentMachine");

    expect(detail.source).not.toContain("createMachine(");
    expect(machine?.vizConfig).toMatchObject({
      id: expect.any(String),
      states: expect.any(Object),
    });
  });

  it("classifies each export by its own initializer in a mixed-authoring file", () => {
    const source = [
      'export const authored = setup({}).createMachine({ initial: "a", states: { a: {} } });',
      "export const { machine: lowered } = setupAgent.fromConfig(workflowConfig);",
      "export const built = setupAgent.fromConfig(workflowConfig).machine;",
      "export const derived = authored.provide({ actors: {} });",
    ].join("\n");
    expect(machineInitializer(source, "lowered")).toContain("fromConfig");
    expect(isAuthoredInSource(source, "authored")).toBe(true);
    // A `.provide()` of a local createMachine binding is still that source.
    expect(isAuthoredInSource(source, "derived")).toBe(true);
    // Neither JSON-lowered export borrows the sibling's createMachine call.
    expect(isAuthoredInSource(source, "lowered")).toBe(false);
    expect(isAuthoredInSource(source, "built")).toBe(false);
    expect(isAuthoredInSource(source, "missing")).toBe(false);
  });

  it("passes v6 example source directly to Viz", async () => {
    const detail = await getExampleDetail("customer-support");
    const machine = detail.machines.find((entry) => entry.exportName === "customerSupportMachine");

    expect(machine?.vizConfig).toBe(detail.source);
  });

  it("finds a re-exported machine in its defining source file", async () => {
    const detail = await getExampleDetail("email-drafter");
    const machine = detail.machines.find((entry) => entry.exportName === "emailDrafter");

    expect(detail.source).not.toContain("export const emailDrafter =");
    expect(machine?.vizConfig).toContain("export const emailDrafter =");
  });

  it("puts the selected machine first when a source file exports several", async () => {
    // hierarchical-teams exports three machines; metadata nominates the
    // coordinator, so a non-default selection must still be prepended.
    const detail = await getExampleDetail("hierarchical-teams");
    const machine = detail.machines.find((entry) => entry.exportName === "researchTeamMachine");

    const source = machine?.vizConfig;
    if (typeof source !== "string") throw new Error("expected source");
    expect(source.indexOf("researchSetup.createMachine")).toBeLessThan(
      source.indexOf("coordinatorSetup.createMachine"),
    );
  });

  it("surfaces pre-baked starters from metadata.json", () => {
    const summaries = listExampleSummaries();
    const joke = summaries.find((summary) => summary.id === "joke");
    expect(joke?.starters.length).toBeGreaterThan(0);
    expect(joke?.starters[0]).toMatchObject({ kind: "text", label: expect.any(String) });
    // Most runnable examples should ship at least one starter.
    const withStarters = summaries.filter((summary) => summary.starters.length > 0);
    expect(withStarters.length).toBeGreaterThan(30);
  });

  it("excludes examples flagged manual in metadata.json", () => {
    const ids = listExampleSummaries().map((summary) => summary.id);
    // Host adapters and CLI-only scripts have nothing the demo can run.
    expect(ids).not.toContain("langchain-host");
    expect(ids).not.toContain("mastra-host");
  });

  it("normalizes starter shapes", () => {
    const starters = listExampleSummaries().flatMap((summary) => summary.starters);
    for (const starter of starters) {
      expect(starter.label.length).toBeGreaterThan(0);
      // Labels never leak raw JSON braces onto a chip.
      expect(starter.label.startsWith("{")).toBe(false);
    }
  });

  it("rejects unknown example ids", async () => {
    await expect(getExampleDetail("does-not-exist")).rejects.toThrow(/Unknown example/);
  });
});
