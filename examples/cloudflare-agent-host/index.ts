/// <reference types="@cloudflare/workers-types" />
/**
 * Cloudflare Agents host for XState agent machines — a complete, runnable
 * Worker, and the reference recipe for a DURABLE host.
 *
 * The shape:
 * - The Agent (a Durable Object) owns an append-only event log in its own
 *   SQLite storage (`./event-log-store.ts`). THE LOG IS THE SOURCE OF TRUTH;
 *   no snapshot is persisted anywhere.
 * - Every turn is one `runAgent` call: read the journal, run, append what the
 *   run produced. A turn is a `runAgent` leg that settles idle (the machine is
 *   waiting on a human) or done.
 * - Eviction is a non-event: the next request reads the journal back and
 *   `runAgent` folds it — journaled model/tool results are replayed, never
 *   re-executed.
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
 *                                              validated, then run as one turn
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
import type { EventFromLogic } from "xstate";
import { createOpenAI } from "@ai-sdk/openai";
import {
  createScriptedExecutors,
  getAcceptedEvents,
  getStateMeta,
  parseAgentEvent,
  runAgent,
  type AgentEventLogStore,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type RunAgentResult,
} from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { emailDrafter, emailDrafterSchemas } from "../email-drafter/agent-logic.js";
import { createDurableObjectEventLogStore } from "./event-log-store.js";

interface Env {
  EmailDrafter: DurableObjectNamespace<EmailDrafter>;
  /** Optional: set it and the run is live, leave it unset and the run is scripted. */
  OPENAI_API_KEY?: string;
}

type Turn = RunAgentResult<typeof emailDrafter>;
type ClientEvent = { type: string } & Record<string, unknown>;

/**
 * One Durable Object is one conversation, so the log needs only one thread.
 * A host that packs several conversations into one DO would key this per
 * conversation instead — the store is thread-keyed for exactly that.
 */
const THREAD_ID = "main";

/** An event the current state does not accept: a client mistake (400), not a host failure. */
class RejectedEventError extends Error {}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "Unknown error");

/**
 * How many keyless model calls this Worker has made. The durability claim of
 * this host is that a resume REPLAYS journaled calls instead of re-running
 * them, and this counter is what makes that observable — see
 * `test/agent.workers-test.ts`.
 */
export const scriptedModelCalls = { count: 0 };

/**
 * Keyless answers, routed on the request's model ref (`model: 'promptEvaluator'`
 * / `'emailDrafter'` in `../email-drafter/agent-logic.ts`) so an entry is valid
 * wherever it lands in the queue. Queues are FIFO and finite; this one is sized
 * for a handful of drafting rounds.
 */
const scriptedAnswer = (request: AgentTextRequest) => {
  scriptedModelCalls.count += 1;
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

export class EmailDrafter extends Agent<Env> {
  #store: AgentEventLogStore | undefined;
  #executors: AgentRequestExecutors | undefined;
  /**
   * The last settled turn — a cache of what the log already implies, held only
   * for this DO's lifetime. Undefined after an eviction (and before the first
   * turn), which is why every entry point goes through `#current()`.
   */
  #last: Turn | undefined;
  /** Turns are serialized: one `runAgent` leg at a time per conversation. */
  #turns: Promise<unknown> = Promise.resolve();

  /** Lazy so the DO's storage is bound before the table is created. */
  get #log(): AgentEventLogStore {
    this.#store ??= createDurableObjectEventLogStore(this.ctx.storage);
    return this.#store;
  }

  /** Runs `work` after every turn already queued, and keeps the chain alive on failure. */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#turns.then(work, work);
    this.#turns = next.catch(() => undefined);
    return next;
  }

  /**
   * One turn: read the journal, run, append what the run produced.
   *
   * `events` is the whole durable state — a fresh thread has none and starts
   * from `input` instead. Entries stream to storage through `onEvent` as the
   * run makes them, each at its own index, so a crash mid-turn loses nothing
   * but the call that was in flight.
   */
  async #run(event?: EventFromLogic<typeof emailDrafter>): Promise<Turn> {
    const entries = await this.#log.read(THREAD_ID);
    this.#executors ??= resolveExecutors(this.env);

    // `onEvent` is synchronous; appends chain off it and are awaited below.
    let appends: Promise<void> = Promise.resolve();

    try {
      const result = await runAgent(emailDrafter, {
        ...(entries.length > 0 ? { events: entries } : { input: undefined }),
        ...(event !== undefined ? { event } : {}),
        executors: this.#executors,
        onEvent: (entry) => {
          appends = appends.then(() =>
            this.#log.append({
              threadId: THREAD_ID,
              // The entry's own index IS the optimistic precondition: a
              // concurrent writer at that position makes the append conflict
              // instead of silently interleaving.
              expectedIndex: entry.index,
              entries: [entry],
            }),
          );
        },
        onTransition: (snapshot) => {
          this.broadcast(
            JSON.stringify({
              type: "state",
              value: snapshot.value,
              // meta is schema-typed: clients get the interaction protocol
              // (text / select / confirm) for the current state.
              meta: snapshot.getMeta(),
            }),
          );
        },
      });
      this.#last = result;
      return result;
    } finally {
      // Await the journal even when the run failed: what did happen is durable.
      await appends;
    }
  }

  /**
   * The turn this DO is currently at. After an eviction (or on the very first
   * request) there is no cached turn, so one no-event `runAgent` leg folds the
   * journal back — replaying journaled results, executing nothing new.
   */
  async #current(): Promise<Turn> {
    return this.#last ?? (await this.#run());
  }

  /** Validates the event against the current state's accepted events + payload schemas. */
  #parse(current: Turn, event: ClientEvent) {
    try {
      return parseAgentEvent(current.snapshot, event, { events: emailDrafterSchemas.events });
    } catch (error) {
      throw new RejectedEventError(messageOf(error));
    }
  }

  onMessage(connection: Connection, message: string) {
    // Client messages are machine events (PROMPT_SUBMITTED, SEND, ...).
    let event: ClientEvent | undefined;
    try {
      event = JSON.parse(message) as ClientEvent;
    } catch (error) {
      // A malformed frame never reaches the queue: nothing is run for it.
      this.#sendError(connection, `Invalid JSON: ${messageOf(error)}`);
      return;
    }
    if (!event?.type) {
      this.#sendError(connection, "Send a machine event: { type, ...payload }");
      return;
    }

    const accepted = event;
    void this.#enqueue(async () => {
      const current = await this.#current();
      await this.#run(this.#parse(current, accepted));
    }).catch((error: unknown) => this.#sendError(connection, messageOf(error)));
  }

  #sendError(connection: Connection, message: string) {
    connection.send(JSON.stringify({ type: "error", issues: [{ message }] }));
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      try {
        await this.#enqueue(() => this.#current());
      } catch (error) {
        return Response.json({ error: messageOf(error) }, { status: 500 });
      }
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

    const event = (await request.json().catch(() => null)) as ClientEvent | null;
    if (!event?.type) {
      return Response.json(
        { error: "POST a machine event: { type, ...payload }" },
        { status: 400 },
      );
    }

    try {
      // One POST maps to one settled turn: the response is always an idle (or
      // final) state, with the journal already written.
      await this.#enqueue(async () => {
        const current = await this.#current();
        await this.#run(this.#parse(current, event));
      });
    } catch (error) {
      if (error instanceof RejectedEventError) {
        return Response.json({ ...this.#view(), error: error.message }, { status: 400 });
      }
      return Response.json({ error: messageOf(error) }, { status: 500 });
    }

    return Response.json(this.#view());
  }

  /**
   * The wire view of the machine: what a client needs to render the next step.
   * Derived from the last settled turn — with none (no turn has ever succeeded
   * on this instance) there is no state to report, only the error.
   */
  #view() {
    const result = this.#last;
    if (!result) {
      return { error: "No settled turn: the agent could not be resumed from its event log." };
    }
    const { snapshot } = result;
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
      output: result.status === "done" ? result.output : undefined,
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
  "Each :name is its own Durable Object, i.e. its own conversation, backed by",
  "its own append-only event log in that Durable Object's SQLite storage.",
].join("\n");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(usage, { status: 404, headers: { "content-type": "text/plain" } })
    );
  },
};
