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
 *   - Every tool result is held in `quarantined` until a classifier returns
 *     its level, a file read included. The model cannot be called and no tool
 *     can run while a result is held.
 *   - A result above the user's clearance, a verdict that is not a known
 *     level, or a classifier failure moves the session to `locked`. The result
 *     is withheld. Only an operator `DISCARD` leaves `locked`.
 *   - A subagent is the tool `task`. It gets its own machine, which starts at
 *     the parent's clearance and the parent's level, so it cannot search the
 *     web with what the parent has seen. Its report is not classified by
 *     content: the parent takes the level the subagent ended at.
 *
 * The machine imports only from `xstate`. `@statelyai/agent` supplies what
 * surrounds it: `recordLog` journals every event for audit and replay, and
 * `canReach` (in `index.test.ts`) proves the rules above for every clearance,
 * every starting level, every tool, and every classifier verdict, without a
 * model call. `recordLog` marks each refused event `ignored`.
 *
 * Tool results never enter the machine. The host keeps the held result in a
 * closure and the machine sees only the tool name and the verdict, so the
 * event log is safe to store.
 *
 * No API key needed. Run: npx tsx examples/harness-governor/index.ts
 */
import { z } from "zod";
import { createActor, createAsyncLogic, setup, waitFor, type Actor } from "xstate";
import { recordLog, type AgentLogEntry, type LogRecorder } from "@statelyai/agent/log";

// ─── Vocabulary ───

export const LEVELS = ["public", "confidential", "secret"] as const;
export type Level = (typeof LEVELS)[number];

export const TOOLS = ["read_file", "web_search", "query_records", "task"] as const;
export type Tool = (typeof TOOLS)[number];

const levelSchema = z.enum(LEVELS);
const toolSchema = z.enum(TOOLS);

const rank = (level: Level): number => LEVELS.indexOf(level);

/** Tools that send session content to a third party. */
const EGRESS_TOOLS: ReadonlySet<Tool> = new Set(["web_search"]);

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
    // `level` is set for a subagent: it starts at its parent's level.
    input: z.object({ clearance: levelSchema, level: levelSchema.optional() }),
    output: z.object({ level: levelSchema }),
  },
  actors: {
    // Standalone, every result is public. The host replaces this with a real
    // classifier through `machine.provide(...)`.
    classify: createAsyncLogic<Level, { tool: Tool }>({ run: async () => "public" }),
  },
}).createMachine({
  id: "harness-governor",
  context: ({ input }) => {
    const level = input.level ?? "public";
    // No session starts above its clearance: the actor errors instead.
    if (rank(level) > rank(input.clearance)) {
      throw new Error(`A session cannot start at ${level} with ${input.clearance} clearance.`);
    }
    return { clearance: input.clearance, level, active: null };
  },
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
    // Every result is classified. A tool the machine trusted by name would
    // let its content reach an egress tool with the level still `public`.
    running: {
      on: { TOOL_RESULT: { target: "quarantined" } },
    },
    // No `on` here: while a result is held, the machine accepts no event from
    // the loop. The classifier's verdict is the only way out.
    quarantined: {
      invoke: {
        id: "classify",
        src: "classify",
        input: ({ context }) => ({ tool: context.active! }),
        onDone: ({ context, output }) =>
          // `rank` is -1 for a label that is not a level, which would compare
          // as below every clearance. An unknown verdict locks instead.
          !LEVELS.includes(output) || rank(output) > rank(context.clearance)
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

export type Admission =
  | { admitted: true; result: string }
  | { admitted: false; reason: "locked" | "not-running" };

type Classify = (tool: Tool, result: string) => Promise<Level>;

export interface Governor {
  actor: Actor<typeof governorMachine>;
  log: LogRecorder;
  /** The tools the current state accepts. */
  allowedTools(): Tool[];
  /**
   * True when the call may run. The machine is then waiting on its result.
   * A refused call is sent too: the machine ignores it, and the log keeps
   * the attempt.
   */
  authorize(tool: Tool): boolean;
  /**
   * A governor for the subagent of an authorized `task` call. Its report is
   * handed back through `admit` once the subagent has ended.
   */
  spawn(): Governor;
  /**
   * Returns the result once it is safe for the model, or withholds it. A
   * result with no authorized call behind it is refused: the machine would
   * ignore the event, and nothing would classify the result.
   */
  admit(result: string): Promise<Admission>;
  /** True when the conversation may be sent to the model. */
  requestModel(): boolean;
  discard(): void;
  end(): void;
}

/**
 * Binds the machine to one session. The methods mirror the points where a
 * harness can be intercepted: when it lists tools, before it runs one, when
 * it starts a subagent, and after a tool returns.
 */
export function createGovernor(options: {
  clearance: Level;
  classify: Classify;
  /** The level a subagent starts at. `spawn` sets it. */
  level?: Level;
}): Governor {
  // The held result lives here, not in machine context or an event payload.
  let held: string | null = null;
  let child: Governor | null = null;

  // A subagent's report is built from what its model saw, so it is as
  // sensitive as the level the subagent ended at. A subagent that has not
  // ended has no level to give, and the parent locks.
  const subagentLevel = async (): Promise<Level> => {
    const snapshot = child?.actor.getSnapshot();
    child = null;
    if (snapshot?.status !== "done") throw new Error("The subagent has not ended.");
    return snapshot.output.level;
  };

  const actor = createActor(
    governorMachine.provide({
      actors: {
        classify: createAsyncLogic<Level, { tool: Tool }>({
          run: ({ input }) =>
            input.tool === "task" ? subagentLevel() : options.classify(input.tool, held!),
        }),
      },
    }),
    { input: { clearance: options.clearance, level: options.level } },
  );
  // The machine refused the input: no session.
  const initial = actor.getSnapshot();
  if (initial.status === "error") throw initial.error;
  const log = recordLog(actor);
  actor.start();

  return {
    actor,
    log,
    allowedTools: () =>
      TOOLS.filter((tool) => actor.getSnapshot().can({ type: "TOOL_CALL", tool })),
    authorize(tool) {
      const event = { type: "TOOL_CALL", tool } as const;
      const allowed = actor.getSnapshot().can(event);
      actor.send(event);
      return allowed;
    },
    spawn() {
      const snapshot = actor.getSnapshot();
      if (!snapshot.matches("running") || snapshot.context.active !== "task") {
        throw new Error("spawn needs an authorized task call.");
      }
      // One subagent per task call: a second one could end lower and lend
      // its level to the first one's report.
      if (child) throw new Error("This task call already has a subagent.");
      child = createGovernor({
        clearance: snapshot.context.clearance,
        level: snapshot.context.level,
        classify: options.classify,
      });
      return child;
    },
    async admit(result) {
      const event = { type: "TOOL_RESULT" } as const;
      const running = actor.getSnapshot().can(event);
      if (running) held = result;
      actor.send(event);
      if (!running) return { admitted: false, reason: "not-running" };
      const settled = await waitFor(actor, (snapshot) => !snapshot.matches("quarantined"));
      held = null;
      return settled.matches("locked")
        ? { admitted: false, reason: "locked" }
        : { admitted: true, result };
    },
    requestModel() {
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
  /** For `task`: the calls the subagent attempts. */
  subagent?: ScriptedCall[];
}

export interface HarnessStep {
  tool: Tool;
  /** `denied`: never ran. `withheld`: ran, but the model did not see the result. */
  outcome: "result" | "denied" | "withheld";
  /** What the model saw. */
  seen?: string;
  /** The session level after the step. */
  level: Level;
  /** For `task`: what the subagent did. */
  steps?: HarnessStep[];
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

/** A subagent's report: everything its model saw. */
const report = (steps: HarnessStep[]): string =>
  steps.flatMap((step) => step.seen ?? []).join("\n") || "Nothing to report.";

/** Stands in for a decision model: looks the record's level up by its body. */
const classifyByLookup: Classify = async (_tool, result) =>
  Object.values(RECORDS).find((record) => record.body === result)?.level ?? "public";

export const DEFAULT_SCRIPT: ScriptedCall[] = [
  { tool: "web_search", query: "grid frequency standards" },
  {
    tool: "task",
    query: "summarize station A",
    subagent: [
      { tool: "query_records", query: "station A load" },
      { tool: "web_search", query: "412 MW at 14:00" },
    ],
  },
  { tool: "web_search", query: "station A summary" },
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
    classify?: Classify;
  } = {},
) {
  const {
    clearance = "confidential",
    script = DEFAULT_SCRIPT,
    classify = classifyByLookup,
  } = options;
  const governor = createGovernor({ clearance, classify });
  const level = (of: Governor) => of.actor.getSnapshot().context.level;
  /** One log per subagent, in the order they started. */
  const subagents: AgentLogEntry[][] = [];

  const attempt = async (session: Governor, call: ScriptedCall): Promise<HarnessStep> => {
    if (!session.authorize(call.tool)) {
      return { tool: call.tool, outcome: "denied", level: level(session) };
    }
    let steps: HarnessStep[] | undefined;
    if (call.tool === "task") {
      const subagent = session.spawn();
      // Reserved now: a subagent's own subagents start after it.
      const slot = subagents.push([]) - 1;
      steps = [];
      for (const inner of call.subagent ?? []) steps.push(await attempt(subagent, inner));
      subagent.end();
      subagent.log.stop();
      subagents[slot] = subagent.log.entries;
    }
    const admission = await session.admit(steps ? report(steps) : await runTool(call));
    // The loop would call the model here. A locked session refuses.
    session.requestModel();
    return {
      tool: call.tool,
      outcome: admission.admitted ? "result" : "withheld",
      ...(admission.admitted ? { seen: admission.result } : {}),
      level: level(session),
      ...(steps ? { steps } : {}),
    };
  };

  const steps: HarnessStep[] = [];
  for (const call of script) steps.push(await attempt(governor, call));

  const locked = governor.actor.getSnapshot().matches("locked");
  if (locked) {
    governor.discard();
    steps.push(await attempt(governor, script.at(-1)!));
  }

  governor.end();
  governor.log.stop();
  return {
    steps,
    locked,
    level: level(governor),
    /** The audit trail: every event the machine processed, in order. */
    entries: governor.log.entries,
    subagents,
  };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  void (async () => {
    const result = await runHarnessGovernorExample();
    const print = (steps: HarnessStep[], indent = "") => {
      for (const step of steps) {
        console.log(
          `${indent}${step.tool.padEnd(14)} ${step.outcome.padEnd(9)} level: ${step.level}`,
        );
        if (step.steps) print(step.steps, `${indent}  `);
      }
    };
    print(result.steps);
    // A refused event is in parentheses.
    const trail = (entries: AgentLogEntry[]) =>
      entries
        .map((entry) => (entry.ignored ? `(${entry.event.type})` : entry.event.type))
        .join(" → ");
    console.log("\nAudit trail:", trail(result.entries));
    result.subagents.forEach((entries, index) =>
      console.log(`Subagent ${index + 1}:`, trail(entries)),
    );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
