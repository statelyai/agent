import type { AnyStateMachine, EventFromLogic } from "xstate";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "./run-agent.js";
import type { AgentLogEntry } from "./event-log.js";
import type { AgentUsage } from "./text-logic.js";

export interface RunAgentLoopOptions<TMachine extends AnyStateMachine> extends Omit<
  RunAgentOptions<TMachine>,
  "snapshot" | "event"
> {
  /** Called whenever the machine pauses. Return its next event, or nothing to
   * leave the run paused. */
  onIdle?: (
    result: Extract<RunAgentResult<TMachine>, { status: "idle" }>,
  ) =>
    | EventFromLogic<TMachine>
    | null
    | undefined
    | Promise<EventFromLogic<TMachine> | null | undefined>;
  /** Called before `onIdle`, at every pause. Framework/host persistence stays here. */
  persist?: (
    snapshot: ReturnType<Extract<RunAgentResult<TMachine>, { status: "idle" }>["persist"]>,
    result: Extract<RunAgentResult<TMachine>, { status: "idle" }>,
  ) => void | Promise<void>;
  maxTurns?: number;
}

function addUsage(total: AgentUsage, next: AgentUsage): AgentUsage {
  const merged: Record<string, number> = { ...total };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number") merged[key] = (merged[key] ?? 0) + value;
  }
  return merged as unknown as AgentUsage;
}

/** Drives one machine artifact across as many idle/resume turns as the host
 * supplies. XState snapshots remain the continuation; this helper owns no
 * persistence, retry, tool-loop, or storage policy. */
export async function runAgentLoop<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentLoopOptions<TMachine>,
): Promise<RunAgentResult<TMachine>> {
  const { onIdle, persist, maxTurns = 100, ...runOptions } = options;
  if (!Number.isInteger(maxTurns) || maxTurns < 0) {
    throw new Error("runAgentLoop: maxTurns must be a non-negative integer.");
  }

  let usage: AgentUsage = { modelCalls: 0 };
  let snapshot: ReturnType<RunAgentResult<TMachine>["persist"]> | undefined;
  let event: EventFromLogic<TMachine> | undefined;
  // Threaded turn to turn so the whole loop yields ONE continuous log rather
  // than a fresh segment per turn.
  let events: readonly AgentLogEntry[] | undefined = options.events;

  for (let turn = 0; ; turn++) {
    const result = await runAgent(machine, {
      ...runOptions,
      ...(events ? { events } : {}),
      ...(snapshot ? { snapshot, event } : {}),
    } as RunAgentOptions<TMachine>);
    events = result.events;
    usage = addUsage(usage, result.usage);
    const cumulative = { ...result, usage } as RunAgentResult<TMachine>;

    if (result.status !== "idle" || !onIdle || turn >= maxTurns) {
      return cumulative;
    }

    snapshot = result.persist();
    await persist?.(snapshot, result);
    event = (await onIdle(result)) ?? undefined;
    if (!event) return cumulative;
  }
}
