import { describe, expect, test } from "vitest";
import { recover, runUntilCrash } from "./index.js";

describe("crash-recovery", () => {
  test("recovers from the persisted snapshot, re-executing only the in-flight request", async () => {
    const snapshot = await runUntilCrash();
    const recovered = await recover(snapshot);
    expect(recovered.status).toBe("done");
    expect(recovered.status === "done" ? recovered.output.outline : "").toContain("Intro");
  });

  test("the topic survives the crash: recovery drafts the original topic", async () => {
    const snapshot = await runUntilCrash("the history of the fax machine");
    const recovered = await recover(snapshot);

    expect(recovered.status).toBe("done");
    if (recovered.status !== "done") return;
    expect(recovered.output.topic).toBe("the history of the fax machine");
    expect(recovered.output.outline).toContain("the history of the fax machine");
    // The draft prompt (and so the article) is topic-specific, not generic.
    expect(recovered.output.article).toContain("the history of the fax machine");
  });
});
