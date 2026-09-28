/**
 * Live-inspection wiring under the durable runtime: real example runs through
 * the demo's server entry points (`startMachineChat` / `resumeMachineChat`),
 * with `@statelyai/sdk/inspect` replaced by a recorder of every MANUAL
 * inspector call (`actor` / `snapshot` / `event` / `stop`), in order. The
 * provider layer is the same deterministic test doubles the example sweep uses,
 * so nothing touches the network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Snapshot } from "xstate";

type Call = { inspector: number; method: string; args: unknown[] };
const recorder = vi.hoisted(() => ({ calls: [] as Call[], inspectors: 0 }));
vi.mock("@statelyai/sdk/inspect", () => ({
  createInspector: (options: unknown) => {
    const inspector = ++recorder.inspectors;
    recorder.calls.push({ inspector, method: "create", args: [options] });
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        recorder.calls.push({ inspector, method, args });
      };
    return {
      actor: record("actor"),
      machine: record("machine"),
      snapshot: record("snapshot"),
      event: record("event"),
      stop: record("stop"),
      destroy: record("destroy"),
    };
  },
}));

vi.mock("@ai-sdk/openai", async () => {
  const { genericLanguageModel } = await import("./test-generic-models");
  const openai = Object.assign((modelId: string) => genericLanguageModel(modelId), {
    chat: (modelId: string) => genericLanguageModel(modelId),
    responses: (modelId: string) => genericLanguageModel(modelId),
  });
  return { openai, createOpenAI: () => openai };
});

vi.mock("@ai-sdk/typesafe-ai", async () => {
  const { genericEvaluationModel } = await import("./test-generic-models");
  const provider = { evaluationModel: () => genericEvaluationModel() };
  return { typeSafeAi: provider, createTypeSafeAi: () => provider };
});

import { getExampleMachine } from "./example-library.server";
import { ensureInspectionRelay } from "./inspection.server";
import { resumeMachineChat, startMachineChat } from "./machine-chat.server";
import { resetGenericModels } from "./test-generic-models";

type WireSnapshot = { value: unknown; status: unknown; context: unknown };
type ActorCall = { id: string; parent?: string; index: number };
type SnapshotCall = { id: string; snapshot: WireSnapshot; event?: string; index: number };

beforeAll(async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  vi.stubEnv("TYPESAFE_AI_API_KEY", "test-typesafe-key");
  vi.stubEnv("OPENAI_MODEL", "");
  // Hosted default, no local relay: inspection turns on once the viz asks
  // (`ensureInspectionRelay`), and the mocked inspector never opens a socket.
  vi.stubEnv("DEMO_INSPECT_WS_URL", "");
  vi.stubEnv("DEMO_INSPECT_PORT", "");
  vi.stubEnv("STATELY_INSPECT_URL", "");
  await ensureInspectionRelay();
});
afterAll(() => {
  vi.unstubAllEnvs();
});
beforeEach(() => {
  resetGenericModels();
  recorder.calls = [];
});

function actorCalls(calls: Call[]): ActorCall[] {
  return calls.flatMap((call, index) => {
    if (call.method !== "actor") return [];
    const [id, options] = call.args as [string, { parent?: string } | undefined];
    return [{ id, parent: options?.parent, index }];
  });
}

function snapshotCalls(calls: Call[], id?: string): SnapshotCall[] {
  return calls.flatMap((call, index) => {
    if (call.method !== "snapshot") return [];
    const [actorId, snapshot, event] = call.args as [string, WireSnapshot, { type?: string }?];
    if (id !== undefined && actorId !== id) return [];
    return [{ id: actorId, snapshot, event: event?.type, index }];
  });
}

function stopIndex(calls: Call[], id: string): number {
  return calls.findIndex((call) => call.method === "stop" && call.args[0] === id);
}

function childIds(calls: Call[]): string[] {
  const ids = calls
    .filter((call) => ["actor", "snapshot", "event", "stop"].includes(call.method))
    .map((call) => call.args[0] as string)
    .filter((id) => id !== "root");
  return [...new Set(ids)];
}

/** Compact, readable call log for failure messages. */
function describeCalls(calls: Call[]): string {
  return calls
    .map((call) => {
      const [id, arg, extra] = call.args as [
        string,
        Record<string, unknown> | undefined,
        Record<string, unknown> | undefined,
      ];
      if (call.method === "actor") {
        return `actor ${id} parent=${String(arg?.parent)}`;
      }
      if (call.method === "snapshot") {
        return `snapshot ${id} status=${String(arg?.status)} value=${JSON.stringify(arg?.value)} event=${String(extra?.type)}`;
      }
      if (call.method === "create" || call.method === "destroy") return call.method;
      return `${call.method} ${id} ${JSON.stringify(arg ?? "")}`;
    })
    .join("\n");
}

describe("a plain request machine", () => {
  test("prompt-chaining streams the root and its request children", async () => {
    const machine = await getExampleMachine("prompt-chaining", "promptChainingMachine");
    const result = await startMachineChat(machine, { topic: "cats" });
    expect(result.status).toBe("done");
    const calls = recorder.calls;
    const log = describeCalls(calls);

    // One inspector for the run, the root registered once as "root".
    expect(
      calls.filter((call) => call.method === "create"),
      log,
    ).toHaveLength(1);
    const roots = actorCalls(calls).filter((call) => call.parent === undefined);
    expect(
      roots.map((call) => call.id),
      log,
    ).toEqual(["root"]);
    expect(stopIndex(calls, "root"), log).toBe(-1);

    // At least one root snapshot per committed transition, ending done.
    const transitions = result.trace.filter(
      (entry) => (entry.kind ?? "transition") === "transition",
    );
    const rootSnapshots = snapshotCalls(calls, "root");
    expect(rootSnapshots.length, log).toBeGreaterThanOrEqual(transitions.length);
    expect(rootSnapshots.at(-1)?.snapshot.status, log).toBe("done");

    // XState v6 carries the causing event on the transition, so completions
    // reach the wire as each snapshot's event.
    expect(
      rootSnapshots.some((call) => call.event?.startsWith("xstate.done.actor")),
      log,
    ).toBe(true);

    // Every request child hangs off the root, finishes, and is then stopped.
    const children = actorCalls(calls).filter((call) => call.id !== "root");
    expect(children.length, log).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.parent, log).toBe("root");
      expect(snapshotCalls(calls, child.id).at(-1)?.snapshot.status, log).toBe("done");
      expect(stopIndex(calls, child.id), log).toBeGreaterThan(child.index);
    }
  });
});

describe("a long-lived child machine across turns", () => {
  let turn1: Call[] = [];
  let turn2: Call[] = [];

  beforeAll(async () => {
    resetGenericModels();
    recorder.calls = [];
    const machine = await getExampleMachine("game-loop-agent", "gameMachine");
    const first = await startMachineChat(machine, { seed: 11 });
    expect(first.status).toBe("idle");
    turn1 = recorder.calls;
    recorder.calls = [];
    const second = await resumeMachineChat(
      machine,
      first.idle!.snapshot as unknown as Snapshot<unknown>,
      { type: "HUMAN_ROLL" },
    );
    expect(second.status).toBe("idle");
    turn2 = recorder.calls;
  });

  test("the root stays one inspected actor, 'root', across both turns", () => {
    const log = `turn 1:\n${describeCalls(turn1)}\nturn 2:\n${describeCalls(turn2)}`;
    expect(
      actorCalls(turn1)
        .filter((call) => call.parent === undefined)
        .map((call) => call.id),
      log,
    ).toEqual(["root"]);
    // The resume reuses the start's inspector and root: no new session, no
    // second root registration, only snapshot updates.
    expect(
      turn2.filter((call) => call.method === "create" || call.method === "destroy"),
      log,
    ).toEqual([]);
    expect(
      actorCalls(turn2).filter((call) => call.parent === undefined || call.id === "root"),
      log,
    ).toEqual([]);
    const resumed = snapshotCalls(turn2, "root");
    expect(
      resumed.some((call) => call.event === "HUMAN_ROLL"),
      log,
    ).toBe(true);
    expect([stopIndex(turn1, "root"), stopIndex(turn2, "root")], log).toEqual([-1, -1]);
  });

  test("the player child keeps one manual id across turns", () => {
    const log = `turn 1:\n${describeCalls(turn1)}\nturn 2:\n${describeCalls(turn2)}`;
    expect(childIds(turn1), log).toEqual(["player"]);
    // Resuming carries the same child forward, so it updates under the same
    // id rather than registering as a new actor (`player#2`).
    expect(childIds(turn2), log).toEqual(["player"]);
    expect(actorCalls(turn2), log).toEqual([]);
  });

  test("the player child is not marked stopped while the game idles between turns", () => {
    const log = `turn 1:\n${describeCalls(turn1)}`;
    // Like the root, the child is only torn down because the turn settled;
    // the persisted game still holds it, so it must not read as stopped.
    expect(stopIndex(turn1, "player"), log).toBe(-1);
    expect(
      snapshotCalls(turn1, "player").map((call) => call.snapshot.status),
      log,
    ).not.toContain("stopped");
  });

  test("the resumed turn continues the child's context", () => {
    const log = `turn 1:\n${describeCalls(turn1)}\nturn 2:\n${describeCalls(turn2)}`;
    // Matched by parent rather than id, so this holds apart from id stability.
    const notesOf = (calls: Call[]) =>
      snapshotCalls(calls)
        .filter((call) => call.id !== "root")
        .map((call) => (call.snapshot.context as { notes: string[] }).notes);
    const before = notesOf(turn1).at(-1)!;
    const after = notesOf(turn2);
    expect(before, log).toBeDefined();
    expect(after[0], log).toEqual(before);
    expect(after.at(-1)!.length, log).toBeGreaterThan(before.length);
    expect(after.at(-1)!.slice(0, before.length), log).toEqual(before);
    expect(after.at(-1)!.at(-1), log).toMatch(/^human rolled/);
  });
});

describe("a parallel machine", () => {
  test("parallel-streams registers both regions' children under the root", async () => {
    const machine = await getExampleMachine("parallel-streams", "parallelStreamsMachine");
    const result = await startMachineChat(machine, { topic: "cats" });
    expect(result.status).toBe("done");
    const calls = recorder.calls;
    const log = describeCalls(calls);

    const children = actorCalls(calls).filter((call) => call.id !== "root");
    expect(children.map((call) => call.id).sort(), log).toEqual(["poet", "thinker"]);
    for (const child of children) {
      expect(child.parent, log).toBe("root");
      expect(snapshotCalls(calls, child.id).at(-1)?.snapshot.status, log).toBe("done");
      expect(stopIndex(calls, child.id), log).toBeGreaterThan(child.index);
    }
    const last = snapshotCalls(calls, "root").at(-1)?.snapshot;
    expect(last, log).toEqual(
      expect.objectContaining({ status: "done", value: { thinking: "done", versing: "done" } }),
    );
  });
});
