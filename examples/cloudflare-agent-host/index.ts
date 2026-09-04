/// <reference types="@cloudflare/workers-types" />
/**
 * Cloudflare Agents host for XState agent machines — a complete, runnable Worker.
 *
 * The shape:
 * - The Agent (a Durable Object) hosts the agent machine.
 * - **The event log is the source of truth.** The DO persists an append-only
 *   journal of external inputs (`AgentLogEntry`) in its own SQLite storage, and
 *   every wake resumes by replaying that journal through `runDurableAgent`.
 *   A snapshot is only ever a cache over what the log already implies, so this
 *   host keeps none: there is no snapshot to go stale, diverge, or fail to
 *   deserialize after a machine change.
 * - Model calls are never re-run on resume: an invoke whose completion is
 *   already journaled replays its recorded result instead of executing again.
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
 *                                              validated, journaled, then run
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
import type { EventFromLogic, SnapshotFrom } from "xstate";
import { createOpenAI } from "@ai-sdk/openai";
import {
  createScriptedExecutors,
  getAcceptedEvents,
  getStateMeta,
  parseAgentEvent,
  runDurableAgent,
  type AgentLogEntry,
  type AgentRequestExecutors,
  type AgentTextRequest,
} from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { emailDrafter, emailDrafterSchemas } from "../email-drafter/agent-logic.js";
import { createDurableObjectEventLogStore } from "./event-log-store.js";

interface Env {
  EmailDrafter: DurableObjectNamespace<EmailDrafter>;
  /** Optional: set it and the run is live, leave it unset and the run is scripted. */
  OPENAI_API_KEY?: string;
}

type DrafterSnapshot = SnapshotFrom<typeof emailDrafter>;
type DrafterEvent = EventFromLogic<typeof emailDrafter>;

/** One DO instance is one conversation, so it holds exactly one log thread. */
const THREAD_ID = "main";

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

export class EmailDrafter extends Agent<Env> {
  #store: ReturnType<typeof createDurableObjectEventLogStore> | undefined;
  /** Derived state, never authoritative: recomputed from the log on every wake. */
  #snapshot: DrafterSnapshot | undefined;
  /** Serializes turns, so two overlapping requests cannot interleave appends. */
  #turns: Promise<unknown> = Promise.resolve();

  get #log() {
    // Lazily built so the table DDL runs on first use rather than at construction.
    this.#store ??= createDurableObjectEventLogStore(this.ctx.storage);
    return this.#store;
  }

  onStart() {
    // Warm the DO: replay the journal (or start a fresh run) so a connecting
    // client gets a state broadcast without having to send anything first.
    void this.#enqueue(() => this.#ready());
  }

  onMessage(connection: Connection, message: string) {
    // Client messages are machine events (PROMPT_SUBMITTED, SEND, ...).
    const event = JSON.parse(message) as { type: string; [key: string]: unknown };
    void this.#enqueue(() => this.#send(event)).catch((error: unknown) => {
      connection.send(
        JSON.stringify({
          type: "error",
          issues: [{ message: (error as Error).message }],
        }),
      );
    });
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      await this.#enqueue(() => this.#ready());
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
      // One POST maps to one settled turn: `runDurableAgent` returns only when
      // the machine is waiting on a human again, or is done.
      await this.#enqueue(() => this.#send(event));
    } catch (error) {
      return Response.json({ error: (error as Error).message, ...this.#view() }, { status: 400 });
    }
    return Response.json(this.#view());
  }

  /** Runs `work` after every previously queued turn, whatever their outcome. */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#turns.then(work, work);
    this.#turns = result.catch(() => {});
    return result;
  }

  /** Ensures the derived snapshot exists: a fresh run, or a replay of the journal. */
  async #ready(): Promise<void> {
    if (!this.#snapshot) {
      await this.#turn();
    }
  }

  /** Validates the event against the derived snapshot, then runs one turn with it. */
  async #send(event: { type: string } & Record<string, unknown>): Promise<void> {
    await this.#ready();
    const parsed = parseAgentEvent(this.#snapshot!, event, {
      events: emailDrafterSchemas.events,
    });
    await this.#turn(parsed);
  }

  /**
   * One durable turn: read the journal, resume from it, optionally deliver one
   * client event, and append everything the run journals as it happens.
   *
   * `runDurableAgent` settles when the machine is waiting on a human or done —
   * the same "idle" the HTTP protocol promises — and the entries it appends are
   * what makes the turn durable. Nothing else is persisted.
   */
  async #turn(event?: DrafterEvent): Promise<void> {
    const store = this.#log;
    const journal = await store.read(THREAD_ID);
    const log: AgentLogEntry[] = [...journal];
    const writes: Promise<void>[] = [];

    const result = await runDurableAgent(emailDrafter, {
      entries: journal.length > 0 ? journal : undefined,
      event,
      executors: resolveExecutors(this.env),
      // Incremental persistence: each external input is journaled the moment
      // the run accepts it, so a crash mid-turn loses only in-flight work.
      onEntry: (entry, snapshot) => {
        log.push(entry);
        writes.push(this.#turnWrite(store, entry, snapshot));
      },
    });

    await Promise.all(writes);
    this.#snapshot = result.snapshot;
    if (writes.length === 0) {
      // A pure resume appended nothing; still tell clients where we are.
      this.#broadcastState(result.snapshot);
    }
  }

  /** Appends one entry, then broadcasts the state that entry produces. */
  async #turnWrite(
    store: ReturnType<typeof createDurableObjectEventLogStore>,
    entry: AgentLogEntry,
    snapshot: DrafterSnapshot,
  ): Promise<void> {
    await store.append({ threadId: THREAD_ID, expectedIndex: entry.index, entries: [entry] });
    // `onEntry` hands over the live snapshot that entry produced, so the
    // broadcast is exact — no replay of the log prefix to re-derive it.
    this.#broadcastState(snapshot);
  }

  #broadcastState(snapshot: DrafterSnapshot) {
    this.broadcast(
      JSON.stringify({
        type: "state",
        value: snapshot.value,
        // meta is schema-typed: clients get the interaction protocol
        // (text / select / confirm) for the current state.
        meta: snapshot.getMeta(),
      }),
    );
  }

  /** The wire view of the machine: what a client needs to render the next step. */
  #view() {
    const snapshot = this.#snapshot!;
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
  "Each :name is its own Durable Object, i.e. its own conversation, and its own",
  "append-only event log in that object's SQLite storage.",
].join("\n");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(usage, { status: 404, headers: { "content-type": "text/plain" } })
    );
  },
};
