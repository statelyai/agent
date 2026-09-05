/**
 * Runs the Worker in real workerd (via @cloudflare/vitest-plugin), so the
 * Durable Object, its SQLite event log, and the folded XState machine are the
 * real thing — not a Node stand-in. Keyless: `vitest.config.ts` forces the
 * `OPENAI_API_KEY` binding empty (it would otherwise be picked up from a
 * `.dev.vars` left behind by `dev:live`), so the host falls back to scripted
 * executors and this suite never bills a provider.
 *
 * What these specs are really testing is the host's durability claim: the
 * append-only log in the Durable Object is the ONLY persisted state, and a
 * conversation survives eviction by folding it back — replaying journaled
 * model calls instead of re-running them.
 */
import { getAgentByName } from "agents";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentLogEntry } from "@statelyai/agent";
import { EmailDrafter, scriptedModelCalls } from "../index.js";
import { createDurableObjectEventLogStore } from "../event-log-store.js";

interface View {
  status: string;
  state: string;
  acceptedEvents: string[];
  draft: { to: string; subject: string; body: string } | null;
  output?: { sentEmails: unknown[] };
  error?: string;
}

const url = (name: string) => `https://example.com/agents/email-drafter/${name}`;

const namespace = () =>
  (env as unknown as { EmailDrafter: DurableObjectNamespace<EmailDrafter> }).EmailDrafter;

/** The very stub the Worker's own routing resolves `:name` to. */
const stubFor = (name: string) => getAgentByName(namespace(), name);

async function get(name: string): Promise<{ status: number; view: View }> {
  const response = await SELF.fetch(url(name));
  return { status: response.status, view: (await response.json()) as View };
}

async function send(name: string, event: Record<string, unknown>): Promise<View> {
  const response = await SELF.fetch(url(name), {
    method: "POST",
    body: JSON.stringify(event),
  });
  return (await response.json()) as View;
}

/** The conversation's whole durable state, read straight out of the DO's SQLite. */
async function journal(name: string): Promise<AgentLogEntry[]> {
  return runInDurableObject(await stubFor(name), async (_instance, state) =>
    createDurableObjectEventLogStore(state.storage).read("main"),
  );
}

/**
 * Simulates an eviction: `abort()` discards the running Durable Object, so the
 * next request builds a brand-new instance with nothing in memory — only the
 * log on disk.
 */
async function evict(name: string): Promise<void> {
  const stub = await stubFor(name);
  try {
    await runInDurableObject(stub, (_instance, state) => {
      state.abort("test eviction");
    });
  } catch {
    // `abort()` tears down the very context the callback runs in.
  }
}

describe("cloudflare agent host", () => {
  it("starts idle at the first interaction", async () => {
    const { status, view } = await get("start");

    expect(status).toBe(200);
    expect(view.state).toBe("prompting");
    expect(view.acceptedEvents).toEqual(["PROMPT_SUBMITTED"]);
  });

  it("journals the log the run produced, and nothing else", async () => {
    const name = "journal-shape";
    await send(name, {
      type: "PROMPT_SUBMITTED",
      prompt: "Email ana@example.com about Friday's launch",
    });
    const entries = await journal(name);

    // The reserved init entry opens the log and pins the execution lineage.
    expect(entries[0]?.event.type).toBe("@agent.init");
    expect(typeof entries[0]?.metadata?.executionId).toBe("string");
    expect(entries.map((entry) => entry.index)).toEqual(entries.map((_entry, i) => i));
    expect(entries.length).toBeGreaterThan(1);
    // Every entry records the state it folds to, so a replay can prove itself.
    for (const entry of entries) {
      expect(typeof entry.verification?.stateHash).toBe("string");
      expect(entry.machineId).toBe("email-drafter");
    }
    // No snapshot is persisted: the log is all there is.
    const keys = await runInDurableObject(await stubFor(name), (_i, state) =>
      state.storage.list({ prefix: "" }),
    );
    expect([...keys.keys()].filter((key) => key.includes("snapshot"))).toEqual([]);
  });

  it("drives a full cycle across two Durable Object instances", async () => {
    const name = "cycle";

    const drafted = await send(name, {
      type: "PROMPT_SUBMITTED",
      prompt: "Email ana@example.com about Friday's launch",
    });
    expect(drafted.state).toBe("reviewing");
    expect(drafted.draft?.subject).toBe("Friday's launch");

    const callsAfterDrafting = scriptedModelCalls.count;
    const journaledAfterDrafting = (await journal(name)).length;

    // Eviction #1: the instance that drafted is gone.
    await evict(name);
    const resumed = await get(name);
    expect(resumed.status).toBe(200);
    expect(resumed.view.state).toBe("reviewing");
    expect(resumed.view.draft?.subject).toBe("Friday's launch");
    // Folding the log re-executed nothing and appended nothing.
    expect(scriptedModelCalls.count).toBe(callsAfterDrafting);
    expect(await journal(name)).toHaveLength(journaledAfterDrafting);

    const sent = await send(name, { type: "SEND" });
    expect(sent.state).toBe("sent");
    expect(scriptedModelCalls.count).toBe(callsAfterDrafting);

    // Eviction #2: the conversation still finishes on a third instance.
    await evict(name);
    const done = await send(name, { type: "END" });
    expect(done.status).toBe("done");
    expect(done.output?.sentEmails).toHaveLength(1);
    expect(scriptedModelCalls.count).toBe(callsAfterDrafting);

    const entries = await journal(name);
    expect(entries.map((entry) => entry.index)).toEqual(entries.map((_entry, i) => i));
    expect(entries.filter((entry) => entry.event.type === "@agent.init")).toHaveLength(1);
  });

  it("rejects an event the current state does not accept", async () => {
    const response = await SELF.fetch(url("rejects"), {
      method: "POST",
      body: JSON.stringify({ type: "SEND" }),
    });
    const view = (await response.json()) as View;

    expect(response.status).toBe(400);
    expect(view.error).toContain("not an accepted event");
    expect(view.state).toBe("prompting");
  });

  it("answers a malformed WebSocket frame with an error, and schedules no turn", async () => {
    const name = "malformed";
    await get(name);
    const before = (await journal(name)).length;

    const response = await SELF.fetch(url(name), { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    expect(socket).toBeTruthy();
    socket!.accept();

    // The `agents` runtime sends its own frames (`cf_agent_identity`, …) on
    // connect; wait for the host's structured error channel specifically.
    const frame = new Promise<{ type: string; issues: { message: string }[] }>((resolve) => {
      socket!.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data)) as {
          type: string;
          issues: { message: string }[];
        };
        if (payload.type === "error") {
          resolve(payload);
        }
      });
    });
    socket!.send("{ not json");
    const message = await frame;
    socket!.close();

    expect(message.type).toBe("error");
    expect(message.issues[0]?.message).toContain("Invalid JSON");
    expect(await journal(name)).toHaveLength(before);
  });

  it("reports a 500 (not a TypeError) when no turn can settle", async () => {
    const name = "corrupt";
    // A log written by another machine version, with no snapshot to migrate
    // from: `runAgent` refuses it, so no turn ever settles on this instance.
    await runInDurableObject(await stubFor(name), async (_instance, state) => {
      await createDurableObjectEventLogStore(state.storage).append({
        threadId: "main",
        expectedIndex: 0,
        entries: [
          {
            schemaVersion: 1,
            id: "evt_0",
            index: 0,
            recordedAt: "2026-01-01T00:00:00.000Z",
            machineId: "email-drafter",
            machineVersion: "from-a-previous-life",
            event: { type: "@agent.init" },
          },
        ],
      });
    });

    const response = await SELF.fetch(url(name));
    const view = (await response.json()) as View;

    expect(response.status).toBe(500);
    expect(view.error).toBeTruthy();
    expect(view.error).not.toContain("undefined is not an object");
    expect(view.state).toBeUndefined();
  });

  it("keeps each :name in its own Durable Object", async () => {
    await send("alice", { type: "PROMPT_SUBMITTED", prompt: "Email alice@example.com" });
    const bob = await get("bob");

    expect(bob.view.state).toBe("prompting");
    expect(await journal("bob")).toHaveLength(1);
  });
});
