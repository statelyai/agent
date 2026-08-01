/// <reference types="@cloudflare/workers-types" />
/**
 * Cloudflare Agents host for XState agent machines — a complete, runnable Worker.
 *
 * The shape:
 * - The Agent (a Durable Object) hosts the XState actor.
 * - The persisted snapshot lives in Agent state, so the machine survives
 *   hibernation/eviction and resumes exactly where it left off.
 * - Clients drive the machine with plain machine events, over HTTP
 *   (`onRequest`) or WebSocket (`onMessage`) — provider/runtime details stay in
 *   the host, never in the machine.
 *
 * Executors are resolved per Durable Object, not at import: Workers have no
 * ambient `process.env`, so the provider is constructed from the `env` binding.
 * With `OPENAI_API_KEY` set (via `.dev.vars` locally, `wrangler secret` in
 * production) the run is live; without it the host falls back to keyless
 * `createScriptedExecutors`, so the example boots and completes with no
 * credentials at all.
 *
 * HTTP protocol (one Agent instance per `:name`, i.e. one conversation):
 *   GET  /agents/email-drafter/:name        -> current view (state, interaction,
 *                                              accepted events, draft, output)
 *   POST /agents/email-drafter/:name        -> body is a machine event
 *                                              (`{"type":"PROMPT_SUBMITTED", ...}`),
 *                                              validated, sent, then awaited
 *                                              until the machine is idle again
 *
 * Run:
 *   pnpm --filter @statelyai/example-cloudflare-agent-host dev        # keyless
 *   pnpm --filter @statelyai/example-cloudflare-agent-host dev:live   # real model
 *
 *   curl -X POST localhost:3009/agents/email-drafter/demo \
 *     -d '{"type":"PROMPT_SUBMITTED","prompt":"Email ana@x.com about Friday'\''s launch"}'
 *   curl -X POST localhost:3009/agents/email-drafter/demo -d '{"type":"SEND"}'
 *   curl -X POST localhost:3009/agents/email-drafter/demo -d '{"type":"END"}'
 */
import { Agent, routeAgentRequest, type Connection } from "agents";
import { createActor, type Actor, type AnyMachineSnapshot, type Snapshot } from "xstate";
import { createOpenAI } from "@ai-sdk/openai";
import {
  createScriptedExecutors,
  getAcceptedEvents,
  getStateMeta,
  parseAgentEvent,
  provideExecutors,
  type AgentRequestExecutors,
  type AgentTextRequest,
} from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { emailDrafter, emailDrafterSchemas } from "../email-drafter/agent-logic.js";

interface Env {
  EmailDrafter: DurableObjectNamespace<EmailDrafter>;
  /** Optional: set it and the run is live, leave it unset and the run is scripted. */
  OPENAI_API_KEY?: string;
}

interface EmailDrafterState {
  snapshot?: Snapshot<unknown>;
}

/**
 * Keyless answers, routed on the request's model ref (`model: 'promptEvaluator'`
 * / `'emailDrafter'` in `../email-drafter/agent-logic.ts`) so an entry is valid
 * wherever it lands in the queue. Queues are FIFO and finite; this one is sized
 * for a handful of drafting rounds.
 */
const scriptedAnswer = (request: AgentTextRequest) => {
  switch (request.model) {
    case "promptEvaluator":
      return { satisfied: true, missing: [], questions: [] };
    case "emailDrafter":
      return {
        to: "ana@example.com",
        subject: "Friday's launch",
        body: "Hi Ana — we ship Friday at 9am. Shout if anything is still open on your side.",
      };
    default:
      throw new Error(`No scripted answer for model ref '${request.model}'.`);
  }
};

/** Live executors when the DO has a key, scripted (keyless) otherwise. */
function resolveExecutors(env: Env): AgentRequestExecutors {
  if (!env.OPENAI_API_KEY) {
    return createScriptedExecutors({ text: Array.from({ length: 12 }, () => scriptedAnswer) });
  }

  // Bind the provider to the Worker's env: `openai(...)` from the module scope
  // would look for a `process.env` key that does not exist in workerd.
  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
  return createAiSdkExecutors({
    models: {
      promptEvaluator: openai("gpt-5.4-mini"),
      emailDrafter: openai("gpt-5.4-mini"),
    },
  });
}

/** Idle = the machine is waiting on a human (it declares an interaction) or finished. */
function isSettled(snapshot: AnyMachineSnapshot): boolean {
  return snapshot.status !== "active" || Boolean(getStateMeta(snapshot).interaction);
}

export class EmailDrafter extends Agent<Env, EmailDrafterState> {
  initialState: EmailDrafterState = {};
  #actor: Actor<typeof emailDrafter> | undefined;

  onStart() {
    // Executors are provided by the host; the machine only names its requests.
    const machine = provideExecutors(emailDrafter, resolveExecutors(this.env));

    // Restore from the persisted snapshot if the DO was evicted mid-run.
    this.#actor = createActor(machine, { snapshot: this.state.snapshot });

    this.#actor.subscribe((snapshot) => {
      // Durable persistence on every transition: this is the journal the
      // analytics/visualization layer reads, keyed by this Agent instance.
      this.setState({ snapshot: this.#actor!.getPersistedSnapshot() });
      this.broadcast(
        JSON.stringify({
          type: "state",
          value: snapshot.value,
          // meta is schema-typed: clients get the interaction protocol
          // (text / select / confirm) for the current state.
          meta: snapshot.getMeta(),
        }),
      );
    });

    this.#actor.start();
  }

  onMessage(connection: Connection, message: string) {
    // Client messages are machine events (PROMPT_SUBMITTED, SEND, ...).
    const event = JSON.parse(message) as { type: string; [key: string]: unknown };
    try {
      this.#send(event);
    } catch (error) {
      connection.send(
        JSON.stringify({
          type: "error",
          issues: [{ message: (error as Error).message }],
        }),
      );
    }
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return Response.json(this.#view());
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "Use GET to read state, POST to send an event." },
        {
          status: 405,
        },
      );
    }

    const event = (await request.json().catch(() => null)) as
      | ({ type: string } & Record<string, unknown>)
      | null;
    if (!event?.type) {
      return Response.json(
        { error: "POST a machine event: { type, ...payload }" },
        { status: 400 },
      );
    }

    try {
      this.#send(event);
    } catch (error) {
      return Response.json({ error: (error as Error).message, ...this.#view() }, { status: 400 });
    }

    // Hold the request open across the machine's async work, so one POST maps
    // to one settled turn: the response is always an idle (or final) state.
    await this.#settle();
    return Response.json(this.#view());
  }

  /** Validates the event against the snapshot's accepted events + payload schemas, then sends it. */
  #send(event: { type: string } & Record<string, unknown>) {
    const snapshot = this.#actor?.getSnapshot();
    if (!snapshot) {
      throw new Error("Agent actor is not running.");
    }
    this.#actor!.send(parseAgentEvent(snapshot, event, { events: emailDrafterSchemas.events }));
  }

  /** Resolves once the machine is waiting on a human again, or is done. */
  #settle(timeoutMs = 60_000): Promise<void> {
    const actor = this.#actor!;
    if (isSettled(actor.getSnapshot())) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.unsubscribe();
        reject(new Error(`Machine did not settle within ${timeoutMs}ms.`));
      }, timeoutMs);
      const subscription = actor.subscribe((snapshot) => {
        if (!isSettled(snapshot)) return;
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve();
      });
    });
  }

  /** The wire view of the machine: what a client needs to render the next step. */
  #view() {
    const snapshot = this.#actor!.getSnapshot();
    const { display, interaction } = getStateMeta(snapshot);
    return {
      status: snapshot.status,
      state: snapshot.value,
      display,
      interaction,
      acceptedEvents: getAcceptedEvents(snapshot, { events: emailDrafterSchemas.events }).map(
        (candidate) => candidate.type,
      ),
      draft: snapshot.context.draft,
      output: snapshot.status === "done" ? snapshot.output : undefined,
    };
  }
}

const usage = [
  "Cloudflare Agents host for the email drafter machine.",
  "",
  "  GET  /agents/email-drafter/:name   read the current state",
  "  POST /agents/email-drafter/:name   send a machine event, e.g.",
  '       {"type":"PROMPT_SUBMITTED","prompt":"Email ana@example.com about Friday\'s launch"}',
  "",
  "Each :name is its own Durable Object, i.e. its own conversation.",
].join("\n");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(usage, { status: 404, headers: { "content-type": "text/plain" } })
    );
  },
};
