import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentError,
  createAgentInbox,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
  type EventOf,
} from "./index.js";

const text = (name: string) => ({
  schemas: { input: z.object({}), output: z.string() },
  model: "m",
  prompt: () => name,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const worker = setupAgent({
  context: z.object({ cleaned: z.boolean() }),
  output: z.object({ cleaned: z.boolean() }),
  events: { CANCEL: z.object({}) },
  requests: { work: text("work"), cleanup: text("cleanup") },
}).createMachine({
  context: { cleaned: false },
  initial: "working",
  states: {
    working: {
      invoke: { src: "work", input: {}, onDone: { target: "done" } },
      on: { CANCEL: { target: "cleaning" } },
    },
    cleaning: {
      invoke: {
        src: "cleanup",
        input: {},
        onDone: { target: "cancelled", context: { cleaned: true } },
      },
    },
    cancelled: { type: "final", output: ({ context }) => context },
    done: { type: "final", output: ({ context }) => context },
  },
});
const hangingWork = (): AgentRequestExecutors => ({
  generateText: async (request) =>
    request.name === "work" ? new Promise(() => {}) : { result: "ok" },
});

const steps = setupAgent({
  context: z.object({}),
  events: { FIRST: z.object({}), SECOND: z.object({}) },
}).createMachine({
  context: {},
  initial: "a",
  states: {
    a: { on: { FIRST: { target: "b" } } },
    b: { on: { SECOND: { target: "done" } } },
    done: { type: "final" },
  },
});

describe("runAgent inbox", () => {
  test("send mid-invoke reaches the running machine", async () => {
    const inbox = createAgentInbox<EventOf<typeof worker>>();
    const run = runAgent(worker, { executors: hangingWork(), inbox });
    await tick();
    expect(inbox.send({ type: "CANCEL" })).toBe(true);
    const result = await run;
    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("cancelled");
    expect(result.status === "done" ? result.output : undefined).toEqual({ cleaned: true });
  });

  test("send before start is delivered after the init event", async () => {
    const inbox = createAgentInbox<EventOf<typeof worker>>();
    expect(inbox.send({ type: "CANCEL" })).toBe(true);
    const result = await runAgent(worker, { executors: hangingWork(), inbox });
    expect(result.snapshot.value).toBe("cancelled");
    expect(result.events.map((entry) => entry.event.type).slice(0, 2)).toEqual([
      "@agent.init",
      "CANCEL",
    ]);
  });

  test("send before start follows the opening event", async () => {
    const first = await runAgent(steps, {});
    expect(first.snapshot.value).toBe("a");
    const inbox = createAgentInbox<EventOf<typeof steps>>();
    inbox.send({ type: "SECOND" });
    const result = await runAgent(steps, {
      snapshot: first.persist(),
      event: { type: "FIRST" },
      inbox,
    });
    expect(result.status).toBe("done");
    expect(result.ignored).toBeUndefined();
  });

  test("send after done returns false", async () => {
    const inbox = createAgentInbox<EventOf<typeof worker>>();
    const result = await runAgent(worker, {
      executors: { generateText: async () => ({ result: "ok" }) },
      inbox,
    });
    expect(result.snapshot.value).toBe("done");
    expect(inbox.send({ type: "CANCEL" })).toBe(false);
  });

  test("send after an idle return returns false", async () => {
    const inbox = createAgentInbox<EventOf<typeof steps>>();
    const result = await runAgent(steps, { inbox });
    expect(result.status).toBe("idle");
    expect(inbox.send({ type: "FIRST" })).toBe(false);
  });

  test("an inbox event while idle resumes ahead of onIdle", async () => {
    const inbox = createAgentInbox<EventOf<typeof steps>>();
    let idles = 0;
    const run = runAgent(steps, {
      inbox,
      onIdle: async (snapshot) => {
        idles += 1;
        if (snapshot.value === "a") return { type: "FIRST" } as const;
        return new Promise(() => {});
      },
    });
    await tick();
    expect(idles).toBe(2);
    expect(inbox.send({ type: "SECOND" })).toBe(true);
    const result = await run;
    expect(result.status).toBe("done");
    expect(result.events.map((entry) => entry.event.type)).toEqual([
      "@agent.init",
      "FIRST",
      "SECOND",
    ]);
  });

  test("an ignored inbox event does not stop onIdle", async () => {
    const inbox = createAgentInbox<EventOf<typeof steps>>();
    inbox.send({ type: "SECOND" });
    inbox.send({ type: "FIRST" });
    const idles: unknown[] = [];
    const result = await runAgent(steps, {
      inbox,
      onIdle: async (snapshot) => {
        idles.push(snapshot.value);
        return { type: "SECOND" } as const;
      },
    });
    expect(idles).toEqual(["b"]);
    expect(result.status).toBe("done");
  });

  test("an inbox send from inside onIdle resumes the run", async () => {
    const inbox = createAgentInbox<EventOf<typeof steps>>();
    const result = await runAgent(steps, {
      inbox,
      onIdle: (snapshot) => {
        inbox.send(snapshot.value === "a" ? { type: "FIRST" } : { type: "SECOND" });
        return new Promise(() => {});
      },
    });
    expect(result.status).toBe("done");
  });

  test("an ignored onIdle answer stops the loop even if it was once an inbox event", async () => {
    const inbox = createAgentInbox<EventOf<typeof steps>>();
    const second = { type: "SECOND" } as const;
    inbox.send(second); // ignored in `a`
    let idles = 0;
    const result = await runAgent(steps, {
      inbox,
      onIdle: async () => {
        idles += 1;
        if (idles > 3) throw new Error("retried an ignored answer");
        return second; // ignored in `a` again, now as an answer
      },
    });
    expect(idles).toBe(1);
    expect(result.status).toBe("idle");
    expect(result.ignored).toBe(second);
  });

  test.each([1, 2, 3, 4, 5])(
    "a send just after the onIdle answer wins reaches the next pass (%i hops)",
    async (hops) => {
      const inbox = createAgentInbox<EventOf<typeof steps>>();
      let calls = 0;
      const result = await runAgent(steps, {
        inbox,
        onIdle: () => {
          calls += 1;
          if (calls > 1) return new Promise(() => {});
          const answer = Promise.resolve({ type: "FIRST" } as const);
          let hop: Promise<unknown> = answer;
          for (let n = 0; n < hops; n++) hop = hop.then(() => undefined);
          void hop.then(() => inbox.send({ type: "SECOND" }));
          return answer;
        },
      });
      expect(result.status).toBe("done");
    },
    1000,
  );

  test("an inbox serves one runAgent call", async () => {
    const inbox = createAgentInbox<EventOf<typeof steps>>();
    await runAgent(steps, { inbox });
    await expect(runAgent(steps, { inbox })).rejects.toThrow(AgentError);
  });
});
