/**
 * MCP workflow: a coding agent (Claude Code, Codex, any MCP client) works
 * through a machine step by step, over MCP tools.
 *
 * The agent does the work in its own session; the machine holds the process.
 * Three tools bridge them:
 *
 *   - `start` opens a run and returns the workflow, described for a model
 *     (`describeMachine`), plus the run's status.
 *   - `status` returns where a run is: its state, the events the agent may
 *     send there (with payload JSON Schemas), or what it is waiting on a
 *     person for.
 *   - `send` delivers one event. The payload is parsed at the boundary
 *     (`parseAgentEvent`); an event a person sends is not delivered; an event
 *     the state has no transition for is ignored, and the tool says so.
 *
 * Review is a person's call: `approve` and `requestChanges` are tagged
 * `meta: { actor: "human" }`, so the agent is never offered them and `send`
 * will not deliver them. The host's own UI answers with `answer(...)`, and the
 * agent's next `status` call picks the run up from there.
 *
 * Runs live in a `Map` of persisted snapshots, and deliveries to one run go
 * one at a time. A real host keeps runs in its own store, keyed the same way,
 * and guards each write with a version check. Over stdio the only caller is
 * the agent that started the server; a server reachable by several clients
 * scopes each run to the caller that started it.
 *
 * Run: npx tsx examples/mcp-workflow/index.ts
 * Add to Claude Code: claude mcp add bugfix -- npx tsx examples/mcp-workflow/index.ts
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  describeMachine,
  getAcceptedEvents,
  getAgentSchemas,
  getInteraction,
  getJsonSchemaSync,
  interactionMetaSchema,
  parseAgentEvent,
  setupAgent,
  type AgentRunResult,
  type EventOf,
  runAgent,
} from "@statelyai/agent";

const agentSetup = setupAgent({
  context: z.object({
    issue: z.string(),
    test: z.string().nullable(),
    summary: z.string().nullable(),
    notes: z.array(z.string()),
  }),
  input: z.object({ issue: z.string() }),
  output: z.object({ summary: z.string() }),
  meta: interactionMetaSchema,
  events: {
    reproduced: z.object({ test: z.string().describe("Path of the failing test") }),
    cannotReproduce: z.object({ notes: z.string() }),
    fixed: z.object({ summary: z.string().describe("What changed and why") }),
    testsPassed: z.object({}),
    testsFailed: z.object({ output: z.string() }),
    approve: z.object({}),
    requestChanges: z.object({ notes: z.string() }),
    infoProvided: z.object({ notes: z.string() }),
  },
});

export const bugfixMachine = agentSetup.createMachine({
  id: "bugfix",
  description: "Fix the reported bug with a regression test, and get the fix approved.",
  context: ({ input }) => ({ issue: input.issue, test: null, summary: null, notes: [] }),
  output: ({ context }) => ({ summary: context.summary ?? "" }),
  initial: "reproducing",
  states: {
    reproducing: {
      description: "Write a test that fails because of the bug.",
      on: {
        reproduced: ({ event }) => ({ target: "fixing", context: { test: event.test } }),
        cannotReproduce: ({ context, event }) => ({
          target: "needsInfo",
          context: { notes: [...context.notes, event.notes] },
        }),
      },
    },
    fixing: {
      description: "Make the failing test pass. Do not touch unrelated code.",
      on: {
        fixed: ({ event }) => ({ target: "verifying", context: { summary: event.summary } }),
      },
    },
    verifying: {
      description: "Run the full test suite.",
      on: {
        testsPassed: { target: "inReview" },
        testsFailed: ({ context, event }) => ({
          target: "fixing",
          context: { notes: [...context.notes, event.output] },
        }),
      },
    },
    inReview: {
      description: "A person reviews the fix.",
      meta: {
        interaction: {
          label: "Review the fix: {summary}",
          events: {
            approve: { label: "Approve", style: "primary" },
            requestChanges: { label: "Request changes" },
          },
          textEvent: { type: "requestChanges", field: "notes" },
        },
      },
      on: {
        approve: { target: "approved", meta: { actor: "human" } },
        requestChanges: {
          target: "fixing",
          meta: { actor: "human" },
          context: ({ context, event }) => ({ notes: [...context.notes, event.notes] }),
        },
      },
    },
    needsInfo: {
      description: "A person adds what is needed to reproduce the bug.",
      meta: {
        interaction: {
          label: "The bug did not reproduce. What else is needed?",
          textEvent: { type: "infoProvided", field: "notes" },
        },
      },
      on: {
        infoProvided: {
          target: "reproducing",
          meta: { actor: "human" },
          context: ({ context, event }) => ({ notes: [...context.notes, event.notes] }),
        },
      },
    },
    approved: { type: "final" },
  },
});

type BugfixEvent = EventOf<typeof bugfixMachine>;

/** What a run looks like to the agent. */
export interface RunStatus {
  runId: string;
  state: string;
  /** The current state's description: what to do now. */
  instructions?: string;
  /** What the run is waiting on a person for; call `status` again later. */
  waitingFor?: string;
  /** The events the agent may send now, each with its payload's JSON Schema. */
  events: { type: string; payload?: Record<string, unknown> }[];
  output?: { summary: string };
}

interface StoredRun {
  /** What a resume restores from. */
  persisted: unknown;
  status: RunStatus;
  /** Every event the state accepts, a person's included. */
  accepted: string[];
}

/** Every run, by id. A real host keeps these in its own store. */
const runs = new Map<string, StoredRun>();

/** The event payload schemas, for the JSON Schemas `status` lists. */
const schemas = getAgentSchemas(bugfixMachine);

function save(runId: string, result: AgentRunResult<typeof bugfixMachine>): RunStatus {
  if (result.status === "error") throw result.error;
  const snapshot = result.snapshot;
  const state = String(snapshot.value);
  const instructions = bugfixMachine.root.states[state]?.description;
  const events = getAcceptedEvents(snapshot, { actor: "agent", schemas }).map((event) => ({
    type: event.type,
    ...(event.inputSchema ? { payload: getJsonSchemaSync(event.inputSchema) } : {}),
  }));
  const interaction = events.length === 0 ? getInteraction(snapshot) : undefined;
  const status: RunStatus = {
    runId,
    state,
    ...(instructions ? { instructions } : {}),
    ...(interaction ? { waitingFor: interaction.label } : {}),
    events,
    ...(result.status === "done" ? { output: result.output } : {}),
  };
  runs.set(runId, {
    persisted: result.persist(),
    status,
    accepted: getAcceptedEvents(snapshot).map((event) => event.type),
  });
  return status;
}

function load(runId: string): StoredRun {
  const run = runs.get(runId);
  if (!run) throw new Error(`No run '${runId}'.`);
  return run;
}

/** Each run's last delivery, so deliveries to one run never restore the same snapshot. */
const deliveries = new Map<string, Promise<unknown>>();

function deliver(runId: string, event: BugfixEvent): Promise<RunStatus> {
  const delivery = (deliveries.get(runId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const result = await runAgent(bugfixMachine, {
        snapshot: load(runId).persisted as never,
        event,
      });
      if (result.ignored) {
        throw new Error(
          `'${event.type}' does not apply in state '${String(result.snapshot.value)}'.`,
        );
      }
      return save(runId, result);
    });
  deliveries.set(runId, delivery);
  return delivery;
}

/** Opens a run for an issue. */
export async function start(issue: string): Promise<RunStatus> {
  const result = await runAgent(bugfixMachine, { input: { issue } });
  return save(randomUUID(), result);
}

/** Where a run is now. */
export function status(runId: string): RunStatus {
  return load(runId).status;
}

/** The agent's move: parsed at the boundary, never an event a person sends. */
export async function send(runId: string, payload: unknown): Promise<RunStatus> {
  const run = load(runId);
  const event = parseAgentEvent(bugfixMachine, payload);
  const forAgent = run.status.events.some((offered) => offered.type === event.type);
  if (!forAgent && run.accepted.includes(event.type)) {
    throw new Error(`A person sends '${event.type}'. Call status later to see their answer.`);
  }
  return deliver(runId, event);
}

/** A person's answer, from the host's own UI. */
export function answer(runId: string, event: BugfixEvent): Promise<RunStatus> {
  return deliver(runId, event);
}

/** The MCP server: the three tools over the functions above. */
export function createBugfixServer(): McpServer {
  const server = new McpServer({ name: "bugfix", version: "1.0.0" });
  const reply = async (work: () => unknown) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await work(), null, 2) }] };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text }], isError: true };
    }
  };

  server.registerTool(
    "start",
    {
      description: "Open a bug-fix run. Returns the workflow and the run's status.",
      inputSchema: { issue: z.string().describe("The bug report") },
    },
    ({ issue }) =>
      reply(async () => ({ workflow: describeMachine(bugfixMachine), ...(await start(issue)) })),
  );
  server.registerTool(
    "status",
    {
      description: "Where a run is: its state and the events you may send, or what it waits on.",
      inputSchema: { runId: z.string() },
    },
    ({ runId }) => reply(() => status(runId)),
  );
  server.registerTool(
    "send",
    {
      description: "Report what happened: one of the events status lists, with its payload.",
      inputSchema: {
        runId: z.string(),
        event: z.looseObject({ type: z.string() }).describe("{ type, ...payload }"),
      },
    },
    ({ runId, event }) => reply(() => send(runId, event)),
  );
  return server;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await createBugfixServer().connect(new StdioServerTransport());
}
