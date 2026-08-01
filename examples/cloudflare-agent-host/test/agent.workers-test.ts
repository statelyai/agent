/**
 * Runs the Worker in real workerd (via @cloudflare/vitest-pool-workers), so the
 * Durable Object, its SQLite storage, and the persisted XState snapshot are the
 * real thing — not a Node stand-in. Keyless: `vitest.config.ts` forces the
 * `OPENAI_API_KEY` binding empty (it would otherwise be picked up from a
 * `.dev.vars` left behind by `dev:live`), so the host falls back to scripted
 * executors and this suite never bills a provider.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

  it("persists the snapshot in Durable Object state across requests", async () => {
    const name = "persisted";
    await send(name, { type: "PROMPT_SUBMITTED", prompt: "Email ana@example.com" });

    const view = (await (await SELF.fetch(url(name))).json()) as View;
    expect(view.state).toBe("reviewing");
    expect(view.draft).not.toBeNull();
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
