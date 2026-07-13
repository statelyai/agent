import { describe, expect, test } from "vitest";
import { renderDecisionAttempts } from "./decision.js";

describe("renderDecisionAttempts", () => {
  const events = [
    { type: "ASK", toolName: "send_event_ASK" },
    { type: "GUESS", toolName: "send_event_GUESS" },
  ];

  test("returns [] when there are no attempts", () => {
    expect(renderDecisionAttempts({ events, attempts: [] })).toEqual([]);
  });

  test("renders one user message per attempt naming the reason and candidate types", () => {
    const messages = renderDecisionAttempts({
      events,
      attempts: [
        { failure: "unknown-event", reason: "'FOO' is not allowed." },
        { failure: "invalid-payload", reason: "bad payload" },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0]!.content).toContain("'FOO' is not allowed.");
    expect(messages[0]!.content).toContain("ASK, GUESS");
    expect(messages[1]!.content).toContain("bad payload");
  });

  test("uses (none) when there are no candidate events", () => {
    const [message] = renderDecisionAttempts({
      events: [],
      attempts: [{ failure: "unknown-event", reason: "nothing legal" }],
    });
    expect(message!.content).toContain("(none)");
  });
});
