/**
 * Runs the Worker in real workerd (via @cloudflare/vitest-plugin), so the
 * Durable Object, its SQLite storage, and the persisted event log are the real
 * thing — not a Node stand-in. Keyless: `vitest.config.ts` forces the
 * `OPENAI_API_KEY` binding empty (it would otherwise be picked up from a
 * `.dev.vars` left behind by `dev:live`), so the host falls back to scripted
 * executors and this suite never bills a provider.
 *
 * The host is log-as-truth: it persists no snapshot at all, so "does it survive
 * a wake?" is really "does replaying the journal reproduce the conversation?".
 */
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

async function send(name: string, event: Record<string, unknown>): Promise<View> {
  const response = await SELF.fetch(url(name), {
    method: "POST",
    body: JSON.stringify(event),
  });
  return (await response.json()) as View;
}

describe("cloudflare agent host", () => {
  it("starts idle at the first interaction", async () => {
    const response = await SELF.fetch(url("start"));
    const view = (await response.json()) as View;

    expect(response.status).toBe(200);
    expect(view.state).toBe("prompting");
    expect(view.acceptedEvents).toEqual(["PROMPT_SUBMITTED"]);
  });

  it("drives a full start -> idle -> resume -> done cycle", async () => {
    const name = "cycle";

    const drafted = await send(name, {
      type: "PROMPT_SUBMITTED",
      prompt: "Email ana@example.com about Friday's launch",
    });
    expect(drafted.state).toBe("reviewing");
    expect(drafted.draft?.subject).toBe("Friday's launch");

    const sent = await send(name, { type: "SEND" });
    expect(sent.state).toBe("sent");

    const done = await send(name, { type: "END" });
    expect(done.status).toBe("done");
    expect(done.output?.sentEmails).toHaveLength(1);
  });

  it("resumes from the journal across requests", async () => {
    const name = "persisted";
    await send(name, { type: "PROMPT_SUBMITTED", prompt: "Email ana@example.com" });

    const view = (await (await SELF.fetch(url(name))).json()) as View;
    expect(view.state).toBe("reviewing");
    expect(view.draft).not.toBeNull();
  });

  it("journals the run as an append-only log, and stores no snapshot", async () => {
    const name = "journaled";
    await send(name, { type: "PROMPT_SUBMITTED", prompt: "Email ana@example.com" });

    const namespace = (env as { EmailDrafter: DurableObjectNamespace }).EmailDrafter;
    const stub = namespace.get(namespace.idFromName(name));
    await runInDurableObject(stub, async (_instance, state) => {
      const entries = await createDurableObjectEventLogStore(state.storage).read("main");

      // Contiguous from a reserved init entry, then one entry per external
      // input: the user event and each invoke completion.
      expect(entries.map((entry) => entry.index)).toEqual(entries.map((_e, i) => i));
      expect(entries[0]!.event.type).toBe("@agent.init");
      expect(entries.map((entry) => entry.event.type)).toContain("PROMPT_SUBMITTED");
      expect(entries.length).toBeGreaterThan(2);

      // No snapshot cache: the log is the only durable representation.
      const keys = await state.storage.list<unknown>();
      expect([...keys.keys()].filter((key) => key.includes("snapshot"))).toEqual([]);
    });
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

  it("keeps each :name in its own Durable Object", async () => {
    await send("alice", { type: "PROMPT_SUBMITTED", prompt: "Email alice@example.com" });
    const bob = (await (await SELF.fetch(url("bob"))).json()) as View;

    expect(bob.state).toBe("prompting");
  });
});

describe("host error channels", () => {
  it("answers a malformed WebSocket frame with a structured error", async () => {
    const namespace = (env as { EmailDrafter: DurableObjectNamespace }).EmailDrafter;
    const stub = namespace.get(namespace.idFromName("bad-frame"));
    const sent: string[] = [];

    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { onMessage(connection: unknown, message: string): void }).onMessage(
        { send: (data: string) => sent.push(data) },
        "{ not json",
      );
    });

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: "error" });
  });

  it("reports a first-turn failure as a 500 instead of throwing on a missing view", async () => {
    const name = "corrupt-log";
    const namespace = (env as { EmailDrafter: DurableObjectNamespace }).EmailDrafter;
    const stub = namespace.get(namespace.idFromName(name));

    // Seed a journal whose recorded hashes cannot be reproduced, so the very
    // first turn of this conversation fails: the host has no snapshot to
    // render, and the response must carry the real error rather than blow up
    // building a view.
    await runInDurableObject(stub, async (_instance, state) => {
      await createDurableObjectEventLogStore(state.storage).append({
        threadId: "main",
        expectedIndex: 0,
        entries: [
          {
            schemaVersion: 1,
            id: "corrupt-0",
            index: 0,
            recordedAt: new Date(0).toISOString(),
            machineId: "emailDrafter",
            machineVersion: "corrupt",
            event: { type: "SEND" },
            verification: { stateHash: "corrupt", effectsHash: "corrupt" },
          },
        ],
      });
    });

    const response = await SELF.fetch(url(name), {
      method: "POST",
      body: JSON.stringify({ type: "PROMPT_SUBMITTED", prompt: "Email ana@example.com" }),
    });
    const view = (await response.json()) as View;
    expect(response.status).toBe(500);
    expect(view.error).toBeTruthy();
    expect(view.state).toBeUndefined();
  });
});
