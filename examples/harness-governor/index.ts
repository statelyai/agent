/**
 * Harness governor: a machine that gates a tool loop it does not run.
 *
 * Some agent loops cannot be ported: a coding harness owns its model calls,
 * its tool execution, and its retries. `governorMachine` runs beside such a
 * loop instead of replacing it. The loop reports what it is about to do as
 * events, and the machine decides whether each one is legal.
 *
 *   - A tool call is the event `TOOL_CALL`. A tool is available only while the
 *     current state accepts that event, so the tool list is derived from the
 *     machine with `snapshot.can`, not kept in a second table.
 *   - `web_search` sends text out of the session. It is accepted only while
 *     the session level is `public`. The level only rises.
 *   - A `query_records` result is held in `quarantined` until a classifier
 *     returns its level. The model cannot be called and no tool can run while
 *     a result is held.
 *   - A result above the user's clearance, or a classifier failure, moves the
 *     session to `locked`. The result is withheld. Only an operator `DISCARD`
 *     leaves `locked`.
 *
 * The machine imports only from `xstate`. `@statelyai/agent` supplies what
 * surrounds it: `recordLog` journals every event for audit and replay, and
 * `canReach` (in `index.test.ts`) proves the rules above for every clearance,
 * every tool, and every classifier verdict, without a model call.
 *
 * Tool results never enter the machine. The host keeps the held result in a
 * closure and the machine sees only the tool name and the verdict, so the
 * event log is safe to store.
 *
 * No API key needed. Run: npx tsx examples/harness-governor/index.ts
 */
import { z } from "zod";
import { createActor, createAsyncLogic, setup, waitFor } from "xstate";
import { recordLog } from "@statelyai/agent/log";

// ─── Vocabulary ───

export const LEVELS = ["public", "confidential", "secret"] as const;
export type Level = (typeof LEVELS)[number];

export const TOOLS = ["read_file", "web_search", "query_records"] as const;
export type Tool = (typeof TOOLS)[number];

const levelSchema = z.enum(LEVELS);
const toolSchema = z.enum(TOOLS);

const rank = (level: Level): number => LEVELS.indexOf(level);

/** Tools that send session content to a third party. */
const EGRESS_TOOLS: ReadonlySet<Tool> = new Set(["web_search"]);

/** Tools whose results are held until classified. */
const QUARANTINED_TOOLS: ReadonlySet<Tool> = new Set(["query_records"]);

// ─── The governor machine: only `xstate` ───

const contextSchema = z.object({
  /** The highest level the user may see. Fixed for the session. */
  clearance: levelSchema,
  /** The highest level the model has seen. It only rises. */
  level: levelSchema,
  /** The tool that is running, or whose result is held. */
  active: toolSchema.nullable(),
});

const eventSchemas = {
  /** The loop wants to run a tool. */
  TOOL_CALL: z.object({ tool: toolSchema }),
  /** The running tool returned. The result stays with the host. */
  TOOL_RESULT: z.object({}),
  /** The loop is about to send the conversation to the model. */
  MODEL_REQUEST: z.object({}),
  /** An operator drops the withheld result. */
  DISCARD: z.object({}),
  END: z.object({}),
};

export const governorMachine = setup({
  schemas: {
    context: contextSchema,
    events: eventSchemas,
    input: z.object({ clearance: levelSchema }),
    output: z.object({ level: levelSchema }),
  },
  actors: {
    // Standalone, every result is public. The host replaces this with a real
    // classifier through `machine.provide(...)`.
    classify: createAsyncLogic<Level, { tool: Tool }>({ run: async () => "public" }),
  },
}).createMachine({
  id: "harness-governor",
  context: ({ input }) => ({ clearance: input.clearance, level: "public", active: null }),
  output: ({ context }) => ({ level: context.level }),
  initial: "ready",
  states: {
    ready: {
      on: {
        // Returning nothing rejects the event, so `snapshot.can` is false and
        // the tool is not available in this state.
        TOOL_CALL: ({ context, event }) =>
          EGRESS_TOOLS.has(event.tool) && context.level !== "public"
            ? undefined
            : { target: "running", context: { active: event.tool } },
        MODEL_REQUEST: { target: "ready" },
        END: { target: "ended" },
      },
    },
    running: {
      on: {
        TOOL_RESULT: ({ context }) =>
          context.active && QUARANTINED_TOOLS.has(context.active)
            ? { target: "quarantined" }
            : { target: "ready", context: { active: null } },
      },
    },
    // No `on` here: while a result is held, the machine accepts no event from
    // the loop. The classifier's verdict is the only way out.
    quarantined: {
      invoke: {
        id: "classify",
        src: "classify",
        input: ({ context }) => ({ tool: context.active! }),
        onDone: ({ context, output }) =>
          rank(output) > rank(context.clearance)
            ? { target: "locked" }
            : {
                target: "ready",
                context: {
                  active: null,
                  level: rank(output) > rank(context.level) ? output : context.level,
                },
              },
        // Fails closed: an unclassified result is treated as over clearance.
        onError: { target: "locked" },
      },
    },
    locked: {
      on: {
        DISCARD: { target: "ready", context: { active: null } },
        END: { target: "ended" },
      },
    },
    ended: { type: "final" },
  },
});

// ─── The host side: what the loop calls ───

export type Admission = { admitted: true; result: string } | { admitted: false; reason: "locked" };

/**
 * Binds the machine to one session. The three methods mirror the points where
 * a harness can be intercepted: when it lists tools, before it runs one, and
 * after one returns.
 */
export function createGovernor(options: {
  clearance: Level;
  classify: (tool: Tool, result: string) => Promise<Level>;
}) {
  // The held result lives here, not in machine context or an event payload.
  let held: string | null = null;

  const actor = createActor(
    governorMachine.provide({
      actors: {
        classify: createAsyncLogic<Level, { tool: Tool }>({
          run: ({ input }) => options.classify(input.tool, held!),
        }),
      },
    }),
    { input: { clearance: options.clearance } },
  );
  const log = recordLog(actor);
  actor.start();

  return {
    actor,
    log,
    /** The tools the current state accepts. */
    allowedTools: (): Tool[] =>
      TOOLS.filter((tool) => actor.getSnapshot().can({ type: "TOOL_CALL", tool })),
    /**
     * True when the call may run. The machine is then waiting on its result.
     * A refused call is sent too: the machine ignores it, and the log keeps
     * the attempt.
     */
    authorize(tool: Tool): boolean {
      const event = { type: "TOOL_CALL", tool } as const;
      const allowed = actor.getSnapshot().can(event);
      actor.send(event);
      return allowed;
    },
    /** Returns the result once it is safe for the model, or withholds it. */
    async admit(result: string): Promise<Admission> {
      held = result;
      actor.send({ type: "TOOL_RESULT" });
      const settled = await waitFor(actor, (snapshot) => !snapshot.matches("quarantined"));
      held = null;
      return settled.matches("locked")
        ? { admitted: false, reason: "locked" }
        : { admitted: true, result };
    },
    /** True when the conversation may be sent to the model. */
    requestModel(): boolean {
      const event = { type: "MODEL_REQUEST" } as const;
      const allowed = actor.getSnapshot().can(event);
      actor.send(event);
      return allowed;
    },
    discard: () => actor.send({ type: "DISCARD" }),
    end: () => actor.send({ type: "END" }),
  };
}

// ─── A stand-in for the external loop ───

/** One tool call the scripted "model" attempts. */
export interface ScriptedCall {
  tool: Tool;
  query: string;
}

export interface HarnessStep {
  tool: Tool;
  /** `denied`: never ran. `withheld`: ran, but the model did not see the result. */
  outcome: "result" | "denied" | "withheld";
  /** What the model saw. */
  seen?: string;
  /** The session level after the step. */
  level: Level;
}

/** Fake records. The second one is above a `confidential` clearance. */
const RECORDS: Record<string, { level: Level; body: string }> = {
  "station A load": { level: "confidential", body: "Station A: 412 MW at 14:00." },
  "station B protection": { level: "secret", body: "Station B relay settings: 87L pickup 0.2 pu." },
};

const runTool = async (call: ScriptedCall): Promise<string> =>
  call.tool === "query_records"
    ? (RECORDS[call.query]?.body ?? "No record.")
    : `${call.tool}: ${call.query}`;

/** Stands in for a decision model: looks the record's level up by its body. */
const classifyByLookup = async (_tool: Tool, result: string): Promise<Level> =>
  Object.values(RECORDS).find((record) => record.body === result)?.level ?? "public";

export const DEFAULT_SCRIPT: ScriptedCall[] = [
  { tool: "web_search", query: "grid frequency standards" },
  { tool: "query_records", query: "station A load" },
  { tool: "web_search", query: "412 MW at 14:00" },
  { tool: "query_records", query: "station B protection" },
  { tool: "read_file", query: "notes.md" },
];

/**
 * Plays a script of tool calls through a loop the machine does not own. An
 * operator discards a withheld result once, after the script, and the last
 * call is tried again.
 */
export async function runHarnessGovernorExample(
  options: {
    clearance?: Level;
    script?: ScriptedCall[];
    classify?: (tool: Tool, result: string) => Promise<Level>;
  } = {},
) {
  const {
    clearance = "confidential",
    script = DEFAULT_SCRIPT,
    classify = classifyByLookup,
  } = options;
  const governor = createGovernor({ clearance, classify });
  const level = () => governor.actor.getSnapshot().context.level;
  const steps: HarnessStep[] = [];

  const attempt = async (call: ScriptedCall) => {
    if (!governor.authorize(call.tool)) {
      steps.push({ tool: call.tool, outcome: "denied", level: level() });
      return;
    }
    const admission = await governor.admit(await runTool(call));
    steps.push(
      admission.admitted
        ? { tool: call.tool, outcome: "result", seen: admission.result, level: level() }
        : { tool: call.tool, outcome: "withheld", level: level() },
    );
    // The loop would call the model here. A locked session refuses.
    governor.requestModel();
  };

  for (const call of script) await attempt(call);

  const locked = governor.actor.getSnapshot().matches("locked");
  if (locked) {
    governor.discard();
    await attempt(script.at(-1)!);
  }

  governor.end();
  governor.log.stop();
  return {
    steps,
    locked,
    level: level(),
    /** The audit trail: every event the machine processed, in order. */
    entries: governor.log.entries,
  };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  void (async () => {
    const result = await runHarnessGovernorExample();
    for (const step of result.steps) {
      console.log(`${step.tool.padEnd(14)} ${step.outcome.padEnd(9)} level: ${step.level}`);
    }
    console.log("\nAudit trail:", result.entries.map((entry) => entry.event.type).join(" → "));
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
