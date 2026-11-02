import { createAsyncLogic, type ActorLogic } from "xstate";
import { setupAgent } from "../setup-agent.js";
import {
  emptyPayload,
  jsonAny,
  jsonArray,
  jsonRecord,
  jsonString,
  objectSchema,
  type PresetMachine,
} from "./internal.js";

/** One tool call a model proposed: its call id, tool name, and arguments. */
export type ProposedCall = { id: string; name: string; args: unknown };

/** What the approval policy decides for one call. */
export type ApprovalDecision = "allow" | "ask" | "deny";

/** The input the policy and execute actors receive. */
export type ApprovalCallInput = { call: ProposedCall };

/** One call's outcome in {@link ApprovalBatchOutput}. */
export type ApprovalCallResult = {
  id: string;
  status: "executed" | "rejected" | "failed" | "cancelled";
  /** The execute actor's output, when `executed`. */
  result?: unknown;
  /** The policy or execute failure, when `failed`. */
  error?: string;
  /** The `REJECT` reason, or `"denied by policy"`, when `rejected`. */
  reason?: string;
};

/** A standing approval granted with `APPROVE_ALWAYS`. The host persists it and feeds it to its policy. */
export type ApproveAlwaysRule = { name: string };

/** Config for {@link createApprovalBatchMachine}. */
export interface CreateApprovalBatchMachineConfig {
  /**
   * Decides each call: `"allow"` runs it, `"ask"` waits for a person,
   * `"deny"` rejects it. Receives `{ call }`. Default: every call is `"ask"`.
   */
  policy?: ActorLogic<any, any, ApprovalCallInput, any, any>;
  /** Runs one approved call. Receives `{ call }`; its output is the call's `result`. */
  execute: ActorLogic<any, any, ApprovalCallInput, any, any>;
  /**
   * `"allReady"` (default): no call executes until every call has settled its
   * approval. `"eachReady"`: each call executes as soon as it is approved.
   */
  executeWhen?: "allReady" | "eachReady";
}

/** Context of a {@link createApprovalBatchMachine} machine. */
export type ApprovalBatchContext = {
  calls: ProposedCall[];
  /** Calls waiting on a person, in arrival order. */
  awaiting: ProposedCall[];
  /** One payload choice per awaiting call and verb, read by `getInteraction`. */
  choices: Array<{ label: string; event: ApprovalBatchEvent }>;
  /** Approved call ids held at the `allReady` barrier. */
  ready: string[];
  results: Record<string, ApprovalCallResult>;
  approveAlways: ApproveAlwaysRule[];
};

/** Machine input of a {@link createApprovalBatchMachine} machine. */
export type ApprovalBatchInput = { calls: ProposedCall[] };
/** Machine output: one result per input call, in input order, plus the `APPROVE_ALWAYS` rules. */
export type ApprovalBatchOutput = {
  results: ApprovalCallResult[];
  approveAlways: ApproveAlwaysRule[];
};
/** The host events a {@link createApprovalBatchMachine} machine accepts, routed by `callId`. */
export type ApprovalBatchEvent =
  | { type: "APPROVE"; callId: string }
  | { type: "APPROVE_ALWAYS"; callId: string }
  | { type: "REJECT"; callId: string; reason?: string }
  | { type: "CANCEL_ALL" };
/** The machine {@link createApprovalBatchMachine} returns. */
export type ApprovalBatchMachine = PresetMachine<
  ApprovalBatchContext,
  ApprovalBatchInput,
  ApprovalBatchOutput,
  ApprovalBatchEvent
>;

/** Context of the per-call child machine. */
type CallContext = {
  call: ProposedCall;
  decision: ApprovalDecision | null;
  approvedBy: "policy" | "user" | null;
  result: unknown;
  error: string | null;
  reason: string | null;
};

const CHILD_PREFIX = "call:";
/** The actor source key the per-call child machine is registered under. */
const CALL_SRC = "call";
const askEveryCall = createAsyncLogic<ApprovalDecision, ApprovalCallInput>({
  run: async () => "ask",
});

const callSchema = { type: "object", properties: { id: jsonString, name: jsonString } };
const callIdPayload = objectSchema<{ callId: string }>({ callId: jsonString }, ["callId"]);

// Call ids are model-chosen strings: read only own keys, so an id like
// `toString` never finds an inherited property.
function settledResult(
  results: Record<string, ApprovalCallResult>,
  id: string,
): ApprovalCallResult | undefined {
  return Object.hasOwn(results, id) ? results[id] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createCallMachine(config: CreateApprovalBatchMachineConfig) {
  const callSetup = setupAgent({
    context: objectSchema<CallContext>(
      {
        call: callSchema,
        decision: { type: ["string", "null"] },
        approvedBy: { type: ["string", "null"] },
        result: jsonAny,
        error: { type: ["string", "null"] },
        reason: { type: ["string", "null"] },
      },
      ["call"],
    ),
    input: objectSchema<ApprovalCallInput>({ call: callSchema }, ["call"]),
    output: objectSchema<ApprovalCallResult>({ id: jsonString, status: jsonString }, [
      "id",
      "status",
    ]),
    events: {
      APPROVE: emptyPayload,
      APPROVE_ALWAYS: emptyPayload,
      REJECT: objectSchema<{ reason?: string }>({ reason: jsonString }),
      // Parent → child: the barrier opened.
      RELEASE: emptyPayload,
    },
    actors: { policy: config.policy ?? askEveryCall, execute: config.execute },
  });

  const toParent = (
    { context, parent }: { context: CallContext; parent: unknown },
    enq: { sendTo: (target: unknown, event: unknown) => void },
    type: "CALL_ASKING" | "CALL_READY",
  ) => {
    if (parent) enq.sendTo(parent, { type, callId: context.call.id });
  };

  return callSetup.createMachine({
    id: "approval-call",
    version: "1",
    context: ({ input }: { input: ApprovalCallInput }) => ({
      call: input.call,
      decision: null,
      approvedBy: null,
      result: null,
      error: null,
      reason: null,
    }),
    initial: "checking",
    states: {
      checking: {
        invoke: {
          id: "policy",
          src: "policy",
          input: ({ context }: { context: CallContext }) => ({ call: context.call }),
          onDone: ({ output }: { output: unknown }) => {
            switch (output) {
              case "allow":
                return { target: "approved", context: { decision: "allow", approvedBy: "policy" } };
              case "ask":
                return { target: "awaitingApproval", context: { decision: "ask" } };
              case "deny":
                return {
                  target: "rejected",
                  context: { decision: "deny", reason: "denied by policy" },
                };
              default:
                return {
                  target: "failed",
                  context: { error: `policy returned ${JSON.stringify(output)}` },
                };
            }
          },
          onError: ({ event }: { event: { error: unknown } }) => ({
            target: "failed",
            context: { error: errorMessage(event.error) },
          }),
        },
      },
      awaitingApproval: {
        entry: (args: { context: CallContext; parent: unknown }, enq: never) =>
          toParent(args, enq, "CALL_ASKING"),
        meta: {
          interaction: {
            label: "Run {call.name}?",
            events: {
              APPROVE: { label: "Approve", style: "primary" },
              APPROVE_ALWAYS: "Always approve",
              REJECT: { label: "Reject", style: "danger" },
            },
            textEvent: { type: "REJECT", field: "reason" },
          },
        },
        on: {
          APPROVE: { target: "approved", context: { approvedBy: "user" } },
          APPROVE_ALWAYS: { target: "approved", context: { approvedBy: "user" } },
          REJECT: ({ event }: { event: { reason?: string } }) => ({
            target: "rejected",
            context: { reason: event.reason ?? "rejected" },
          }),
        },
      },
      // Approved; waits for the parent's barrier to release it.
      approved: {
        entry: (args: { context: CallContext; parent: unknown }, enq: never) =>
          toParent(args, enq, "CALL_READY"),
        on: { RELEASE: { target: "executing" } },
      },
      executing: {
        invoke: {
          id: "execute",
          src: "execute",
          input: ({ context }: { context: CallContext }) => ({ call: context.call }),
          onDone: ({ output }: { output: unknown }) => ({
            target: "executed",
            context: { result: output },
          }),
          onError: ({ event }: { event: { error: unknown } }) => ({
            target: "failed",
            context: { error: errorMessage(event.error) },
          }),
        },
      },
      executed: {
        type: "final",
        output: ({ context }: { context: CallContext }) => ({
          id: context.call.id,
          status: "executed",
          result: context.result,
        }),
      },
      rejected: {
        type: "final",
        output: ({ context }: { context: CallContext }) => ({
          id: context.call.id,
          status: "rejected",
          reason: context.reason ?? "rejected",
        }),
      },
      failed: {
        type: "final",
        output: ({ context }: { context: CallContext }) => ({
          id: context.call.id,
          status: "failed",
          error: context.error ?? "failed",
        }),
      },
    },
  } as unknown as Parameters<typeof callSetup.createMachine>[0]);
}

function choicesFor(awaiting: ProposedCall[]): ApprovalBatchContext["choices"] {
  return awaiting.flatMap((call) => [
    { label: `Approve ${call.name} (${call.id})`, event: { type: "APPROVE", callId: call.id } },
    {
      label: `Always approve ${call.name} (${call.id})`,
      event: { type: "APPROVE_ALWAYS", callId: call.id },
    },
    { label: `Reject ${call.name} (${call.id})`, event: { type: "REJECT", callId: call.id } },
  ]);
}

const contextSchema = objectSchema<ApprovalBatchContext>(
  {
    calls: jsonArray,
    awaiting: jsonArray,
    choices: jsonArray,
    ready: jsonArray,
    results: jsonRecord,
    approveAlways: jsonArray,
  },
  ["calls", "awaiting", "choices", "ready", "results", "approveAlways"],
);
const inputSchema = objectSchema<ApprovalBatchInput>({ calls: jsonArray }, ["calls"]);
const outputSchema = objectSchema<ApprovalBatchOutput>(
  { results: jsonArray, approveAlways: jsonArray },
  ["results", "approveAlways"],
);

type Enq = { sendTo: (target: unknown, event: unknown) => void };
type Args = {
  context: ApprovalBatchContext;
  event: { type: string; callId?: string; reason?: string; actorId?: string; output?: unknown };
  children: Record<string, unknown>;
};

/**
 * One model turn's tool calls, each approved or rejected individually; only
 * approved calls execute. One child actor per call:
 *
 * `checking` (policy) → `awaitingApproval` (person) → `approved` → `executing`
 * → `executed` | `rejected` | `failed`.
 *
 * The parent routes `APPROVE` / `APPROVE_ALWAYS` / `REJECT` to the child by
 * `callId`, holds approved calls at the `executeWhen` barrier, and collects
 * outputs. `CANCEL_ALL` stops every unfinished child and ends the batch; those
 * calls report `cancelled`, including one whose execute was in flight.
 *
 * States: `running` → `done` | `cancelled`.
 *
 * ```ts
 * const machine = createApprovalBatchMachine({
 *   policy: createAsyncLogic({
 *     run: async ({ input }) => (input.call.name === "search" ? "allow" : "ask"),
 *   }),
 *   execute: createAsyncLogic({
 *     run: async ({ input }) => tools[input.call.name](input.call.args),
 *   }),
 * });
 * ```
 */
export function createApprovalBatchMachine(
  config: CreateApprovalBatchMachineConfig,
): ApprovalBatchMachine {
  const executeWhen = config.executeWhen ?? "allReady";
  const callMachine = createCallMachine(config);

  const agentSetup = setupAgent({
    context: contextSchema,
    input: inputSchema,
    output: outputSchema,
    events: {
      APPROVE: callIdPayload,
      APPROVE_ALWAYS: callIdPayload,
      REJECT: objectSchema<{ callId: string; reason?: string }>(
        { callId: jsonString, reason: jsonString },
        ["callId"],
      ),
      CANCEL_ALL: emptyPayload,
      // Child → parent status events.
      CALL_ASKING: callIdPayload,
      CALL_READY: callIdPayload,
    },
    actors: { [CALL_SRC]: callMachine },
  });

  const child = (children: Record<string, unknown>, id: string) => children[`${CHILD_PREFIX}${id}`];

  // Lands one settled call; finishes the batch once every call has a result.
  const settle = (args: Args, enq: Enq, result: ApprovalCallResult) => {
    const { context } = args;
    const results = { ...context.results, [result.id]: result };
    const awaiting = context.awaiting.filter((call) => call.id !== result.id);
    const ready = context.ready.filter((id) => id !== result.id);
    const next = { results, awaiting, ready, choices: choicesFor(awaiting) };
    if (Object.keys(results).length === context.calls.length) {
      return { target: "done", context: next };
    }
    return {
      context: { ...next, ready: release({ ...args, context: { ...context, ...next } }, enq) },
    };
  };

  // The `allReady` barrier: once every unsettled call is approved, release them all.
  const release = ({ context, children }: Args, enq: Enq): string[] => {
    const settled = Object.keys(context.results).length + context.ready.length;
    if (context.ready.length === 0 || settled < context.calls.length) return context.ready;
    for (const id of context.ready) enq.sendTo(child(children, id), { type: "RELEASE" });
    return [];
  };

  // Forwards a person's verdict to the awaiting child; ignored for any other call.
  const forward =
    (type: "APPROVE" | "APPROVE_ALWAYS" | "REJECT") =>
    ({ context, event, children }: Args, enq: Enq) => {
      const call = context.awaiting.find((candidate) => candidate.id === event.callId);
      if (!call) return undefined;
      enq.sendTo(
        child(children, call.id),
        type === "REJECT" && event.reason !== undefined ? { type, reason: event.reason } : { type },
      );
      const awaiting = context.awaiting.filter((candidate) => candidate.id !== call.id);
      const approveAlways =
        type === "APPROVE_ALWAYS" && !context.approveAlways.some((rule) => rule.name === call.name)
          ? [...context.approveAlways, { name: call.name }]
          : context.approveAlways;
      return { context: { awaiting, choices: choicesFor(awaiting), approveAlways } };
    };

  const output = ({ context }: { context: ApprovalBatchContext }): ApprovalBatchOutput => ({
    results: context.calls.map(
      (call) => settledResult(context.results, call.id) ?? { id: call.id, status: "cancelled" },
    ),
    approveAlways: context.approveAlways,
  });

  const machineConfig = {
    id: "approval-batch",
    // Stamped by the runtime onto snapshots/logs instead of the structural hash;
    // bumped only on a topology change a snapshot could not resume into.
    version: "1",
    context: ({ input }: { input: ApprovalBatchInput }) => {
      const ids = new Set(input.calls.map((call) => call.id));
      if (ids.size !== input.calls.length) {
        throw new Error("createApprovalBatchMachine: call ids must be unique.");
      }
      return {
        calls: input.calls,
        awaiting: [],
        choices: [],
        ready: [],
        results: {},
        approveAlways: [],
      };
    },
    initial: "running",
    states: {
      running: {
        entry: (
          { context }: { context: ApprovalBatchContext },
          enq: { spawn: (src: string, options: unknown) => void },
        ) => {
          for (const call of context.calls) {
            enq.spawn(CALL_SRC, { id: `${CHILD_PREFIX}${call.id}`, input: { call } });
          }
        },
        always: ({ context }: { context: ApprovalBatchContext }) =>
          context.calls.length === 0 ? { target: "done" } : undefined,
        meta: {
          interaction: {
            label: "Approve the proposed tool calls.",
            choices: "choices",
          },
        },
        on: {
          CALL_ASKING: ({ context, event }: Args) => {
            const call = context.calls.find((candidate) => candidate.id === event.callId);
            if (
              !call ||
              settledResult(context.results, call.id) ||
              context.awaiting.some((candidate) => candidate.id === call.id)
            ) {
              return undefined;
            }
            const awaiting = [...context.awaiting, call];
            return { context: { awaiting, choices: choicesFor(awaiting) } };
          },
          CALL_READY: (args: Args, enq: Enq) => {
            const { context, event, children } = args;
            const id = event.callId;
            if (!id || !context.calls.some((call) => call.id === id)) return undefined;
            if (context.ready.includes(id) || settledResult(context.results, id)) return undefined;
            if (executeWhen === "eachReady") {
              enq.sendTo(child(children, id), { type: "RELEASE" });
              // A taken (targetless) transition, so the enqueued send runs.
              return {};
            }
            const ready = [...context.ready, id];
            return {
              context: { ready: release({ ...args, context: { ...context, ready } }, enq) },
            };
          },
          APPROVE: forward("APPROVE"),
          APPROVE_ALWAYS: forward("APPROVE_ALWAYS"),
          REJECT: forward("REJECT"),
          CANCEL_ALL: { target: "cancelled" },
          "xstate.done.actor": (args: Args, enq: Enq) => {
            const { actorId, output: result } = args.event;
            if (!actorId?.startsWith(CHILD_PREFIX)) return undefined;
            return settle(args, enq, result as ApprovalCallResult);
          },
          "xstate.error.actor": (args: Args & { event: { error?: unknown } }, enq: Enq) => {
            const { actorId } = args.event;
            if (!actorId?.startsWith(CHILD_PREFIX)) return undefined;
            return settle(args, enq, {
              id: actorId.slice(CHILD_PREFIX.length),
              status: "failed",
              error: errorMessage(args.event.error),
            });
          },
        },
      },
      done: { type: "final", output },
      // Reaching a final state stops every unfinished child.
      cancelled: { type: "final", output },
    },
  } as unknown as Parameters<typeof agentSetup.createMachine>[0];

  return agentSetup.createMachine(machineConfig) as unknown as ApprovalBatchMachine;
}
