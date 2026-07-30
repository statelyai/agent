import { describe, expect, test } from "vitest";
import { replay } from "@statelyai/agent";
import { runSession, sessionQuizMachine } from "./index.js";

describe("session-actor", () => {
  test("one live actor spans idle settles; the log replays and usage aggregates", async () => {
    const { session, result } = await runSession();
    expect(result.status).toBe("done");
    expect(result.status === "done" ? result.output : undefined).toEqual({
      rounds: 1,
      correct: 1,
    });

    // Two model calls (one question per asking pass), aggregated tokens.
    expect(session.usage().modelCalls).toBe(2);
    expect(session.usage().totalTokens).toBe(24);

    // The session-wide log replays deterministically to the same final state.
    const replayed = replay(sessionQuizMachine, [...session.events]);
    expect(replayed.snapshot.status).toBe("done");
    expect(replayed.snapshot.output).toEqual({ rounds: 1, correct: 1 });
  });
});
