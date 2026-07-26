import { describe, expect, it } from "vitest";
import { getExampleDetail, listExampleSummaries } from "./example-library.server";

describe("example library auto-discovery", () => {
  it("discovers every examples/* folder with an index.ts", () => {
    const summaries = listExampleSummaries();
    const ids = summaries.map((summary) => summary.id);
    expect(ids).toContain("joke");
    expect(ids).toContain("react-agent");
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
    expect(machine!.vizConfig).toMatchObject({ id: expect.any(String) });
    expect(machine!.vizConfig.states).toBeTruthy();
  });

  it("surfaces pre-baked starters from metadata.json", () => {
    const summaries = listExampleSummaries();
    const joke = summaries.find((summary) => summary.id === "joke");
    expect(joke?.starters.length).toBeGreaterThan(0);
    expect(typeof joke?.starters[0]).toBe("string");
    // Most runnable examples should ship at least one starter.
    const withStarters = summaries.filter((summary) => summary.starters.length > 0);
    expect(withStarters.length).toBeGreaterThan(30);
  });

  it("rejects unknown example ids", async () => {
    await expect(getExampleDetail("does-not-exist")).rejects.toThrow(/Unknown example/);
  });
});
