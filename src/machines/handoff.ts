import { setupAgent } from "../setup-agent.js";
import {
  assertEntryNames,
  entryInput,
  entrySrc,
  jsonAny,
  jsonString,
  machineActors,
  objectSchema,
  type PresetEntry,
  type PresetMachine,
} from "./internal.js";

/** Config for {@link createHandoffMachine}. */
export interface CreateHandoffMachineConfig<
  TAgents extends Record<string, PresetEntry> = Record<string, PresetEntry>,
> {
  /** The peer agents, keyed by name. Each is an inline request or a child machine. */
  agents: TAgents;
  /** Which agent holds the mic at the start of a run. */
  defaultActiveAgent: keyof TAgents & string;
  /** Default model ref for request agents that declare none. */
  model?: string;
}

/** Context of a {@link createHandoffMachine} machine. */
export type HandoffContext<TAgent extends string = string> = {
  message: string;
  activeAgent: TAgent;
  reply: unknown;
};

/** Machine input of a {@link createHandoffMachine} machine. */
export type HandoffInput<TAgent extends string = string> = {
  message: string;
  activeAgent?: TAgent;
};
/** The events a {@link createHandoffMachine} machine accepts: one per peer agent. */
export type HandoffEvent<TAgent extends string = string> = {
  type: `transfer_to_${TAgent}`;
  message?: string;
};
/** The machine {@link createHandoffMachine} returns. There is no final state, so it has no output. */
export type HandoffMachine<TAgent extends string = string> = PresetMachine<
  HandoffContext<TAgent>,
  HandoffInput<TAgent>,
  undefined,
  HandoffEvent<TAgent>
>;

const contextSchema = objectSchema<HandoffContext>(
  { message: jsonString, activeAgent: jsonString, reply: jsonAny },
  ["message", "activeAgent"],
);
const inputSchema = objectSchema<{ message: string; activeAgent?: string }>(
  { message: jsonString, activeAgent: jsonString },
  ["message"],
);
const transferPayload = objectSchema<{ message?: string }>({ message: jsonString });

/** The event that hands the mic to a peer: `transfer_to_<name>`. */
export function transferEventType(agent: string): string {
  return `transfer_to_${agent}`;
}

/**
 * Peer handoff (the swarm shape): `context.activeAgent` holds the mic, runs one
 * turn, then the machine settles idle in `waiting`. A `transfer_to_<name>`
 * event moves the mic to a peer and re-routes.
 *
 * Control TRANSFERS and does not return — the opposite of
 * {@link createSupervisorMachine}, where every worker hands control back.
 *
 * There is no final state: a conversation ends when the host stops resuming it.
 * Persist the idle snapshot between turns; `activeAgent` round-trips with it.
 *
 * States: `routing` → one turn state per agent → `waiting` → `routing` → …
 *
 * ```ts
 * const machine = createHandoffMachine({
 *   model: "quick",
 *   defaultActiveAgent: "travel",
 *   agents: {
 *     travel: { description: "Destinations and itineraries", instructions: "You are a travel concierge." },
 *     food: { description: "Restaurants and dishes", instructions: "You are a food concierge." },
 *   },
 * });
 *
 * const next = await runAgent(machine, {
 *   snapshot,
 *   event: { type: "transfer_to_food", message: "What should I eat there?" },
 *   executors,
 * });
 * ```
 */
export function createHandoffMachine<const TAgents extends Record<string, PresetEntry>>(
  config: CreateHandoffMachineConfig<TAgents>,
): HandoffMachine<keyof TAgents & string> {
  const { agents, defaultActiveAgent, model } = config;
  const names = Object.keys(agents);
  assertEntryNames("agent", names, ["routing", "waiting"]);
  if (!names.includes(defaultActiveAgent)) {
    throw new Error(
      `createHandoffMachine: defaultActiveAgent '${defaultActiveAgent}' is not a declared ` +
        `agent (${names.join(", ")}).`,
    );
  }

  const agentSetup = setupAgent({
    context: contextSchema,
    input: inputSchema,
    events: Object.fromEntries(names.map((name) => [transferEventType(name), transferPayload])),
    actors: machineActors(agents),
    // A turn ends in `waiting`, which is an intentional wait for the next
    // message — not a stall.
    isIdle: (snapshot) => snapshot.matches("waiting"),
  });

  const turnState = (name: string) => `${name}Turn`;

  const states: Record<string, unknown> = {
    routing: {
      type: "choice",
      choice: ({ context }: { context: HandoffContext }) => ({
        target: names.includes(context.activeAgent)
          ? turnState(context.activeAgent)
          : turnState(defaultActiveAgent),
      }),
    },
    // No invoke: `runAgent` settles idle here until the host sends the next
    // `transfer_to_*` event.
    waiting: {
      on: Object.fromEntries(
        names.map((name) => [
          transferEventType(name),
          ({ context, event }: { context: HandoffContext; event: { message?: string } }) => ({
            target: "routing",
            context: { activeAgent: name, message: event.message ?? context.message },
          }),
        ]),
      ),
    },
  };

  for (const [name, entry] of Object.entries(agents)) {
    states[turnState(name)] = {
      invoke: {
        id: name,
        src: entrySrc(name, entry),
        input: ({ context }: { context: HandoffContext }) =>
          entryInput(name, entry, model, context.message),
        onDone: ({ output }: { output: unknown }) => ({
          target: "waiting",
          context: { reply: output },
        }),
      },
    };
  }

  const machineConfig = {
    id: "handoff",
    // Stamped by runAgent onto snapshots/logs instead of the structural hash;
    // bumped only on a topology change a snapshot could not resume into.
    version: "1",
    context: ({ input }: { input: { message: string; activeAgent?: string } }) => ({
      message: input.message,
      activeAgent: input.activeAgent ?? defaultActiveAgent,
      reply: null,
    }),
    initial: "routing",
    states,
  } as unknown as Parameters<typeof agentSetup.createMachine>[0];

  const machine = agentSetup.createMachine(machineConfig);

  return machine as unknown as HandoffMachine<keyof TAgents & string>;
}
