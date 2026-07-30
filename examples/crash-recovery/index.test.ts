import { describe, expect, test } from "vitest";
import { replay } from "@statelyai/agent";
import { crashRecoveryMachine, recover, runUntilCrash } from "./index.js";

describe("crash-recovery", () => {
  test("recovers from the persisted log alone, re-executing only the in-flight request", async () => {
    const log = await runUntilCrash();
    // The log holds the init entry and the recorded outline result; the draft
    // call was in flight when the process died, so it is absent.
    expect(log[0]?.event.type).toBe("@agent.init");
    expect(log.some((entry) => entry.event.type === "xstate.done.actor")).toBe(true);

    const recovered = await recover(log);
    expect(recovered.status).toBe("done");
    expect(recovered.status === "done" ? recovered.output.outline : "").toContain("Intro");

    // The full recovered log still replays deterministically to done.
    expect(replay(crashRecoveryMachine, recovered.events).snapshot.status).toBe("done");
  });
});
