import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createAsyncLogic, type InspectionEvent } from "xstate";
import { runAgent, setupAgent } from "./index.js";

function createTwoStepMachine() {
  return setupAgent({
    context: z.object({}),
    actors: { work: createAsyncLogic<number>({ run: async () => 1 }) },
  }).createMachine({
    context: {},
    initial: "a",
    states: {
      a: { invoke: { src: "work", onDone: { target: "b" } } },
      b: { invoke: { src: "work", onDone: { target: "c" } } },
      c: { type: "final" },
    },
  });
}

describe("runAgent inspection", () => {
  test("each actor session is announced once, under one stable handle", async () => {
    const events: InspectionEvent[] = [];
    await runAgent(createTwoStepMachine(), { inspect: (event) => events.push(event) });

    const announced = events
      .filter((event) => event.type === "@xstate.actor")
      .map((event) => event.actorRef.sessionId);
    expect(announced.length).toBe(new Set(announced).size);

    const handles = new Map<string, Set<unknown>>();
    for (const event of events) {
      const sessionId = event.actorRef.sessionId!;
      const set = handles.get(sessionId) ?? new Set();
      set.add(event.actorRef);
      handles.set(sessionId, set);
    }
    for (const set of handles.values()) expect(set.size).toBe(1);
  });

  test("the root's handle reads the newest state, and transitions carry each step", async () => {
    const events: InspectionEvent[] = [];
    await runAgent(createTwoStepMachine(), { inspect: (event) => events.push(event) });
    const root = events.find(
      (event) =>
        event.type === "@xstate.actor" &&
        (event.actorRef as unknown as { _parent?: unknown })._parent === undefined,
    )!.actorRef;
    const values = events
      .filter((event) => event.type === "@xstate.transition" && event.actorRef === root)
      .map((event) => (event as unknown as { snapshot: { value: unknown } }).snapshot.value);
    expect(values).toContain("b");
    expect(values.at(-1)).toBe("c");
    expect((root.getSnapshot() as { value: unknown }).value).toBe("c");
    // A child's parent is the root's stable handle.
    const child = events.find(
      (event) => event.type === "@xstate.actor" && event.actorRef !== root,
    )!.actorRef;
    expect((child as unknown as { _parent?: unknown })._parent).toBe(root);
  });

  test("an earlier child's parent link never rewinds the root's handle", async () => {
    const events: InspectionEvent[] = [];
    await runAgent(createTwoStepMachine(), { inspect: (event) => events.push(event) });
    const root = events.find(
      (event) =>
        event.type === "@xstate.actor" &&
        (event.actorRef as unknown as { _parent?: unknown })._parent === undefined,
    )!.actorRef;
    // The first child, announced while the root was in `a`.
    const firstChild = events.find(
      (event) => event.type === "@xstate.actor" && event.actorRef !== root,
    )!.actorRef as unknown as {
      _parent: { getSnapshot(): { value: unknown } };
      options: { parent: unknown };
    };
    expect(firstChild._parent.getSnapshot().value).toBe("c");
    void firstChild.options.parent;
    expect((root.getSnapshot() as { value: unknown }).value).toBe("c");
  });
});
