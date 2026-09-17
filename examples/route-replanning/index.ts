/**
 * Replanning — a plan is a prediction, and the world gets a vote.
 *
 * A courier carries a parcel across a small road network. The machine plans
 * the whole route up front by traversing itself, then drives it one leg at a
 * time. Partway along, a road turns out to be shut — something no plan made
 * beforehand could have known — and the route from HERE has to be computed
 * again, with the closure now part of the world.
 *
 * The contrast with ../river-crossing is the point of this example:
 *
 *   - river-crossing plans ONCE and the plan holds, because the puzzle is a
 *     closed world: nothing happens that the machine did not cause. Following
 *     the route consumes it and no step ever fails.
 *   - here the plan is a hypothesis about an open world. `driveLeg` can report
 *     a closure, and when it does the plan is dead: the machine records what it
 *     learned, replans from where the courier is actually standing, and carries
 *     on. It does not recompute every step — only when reality contradicts it.
 *
 * What each side owns:
 *   - The MACHINE owns routing. `planRoute` traverses `roadNetwork` — the same
 *     network, as a bare XState machine whose STATE VALUE is the courier's
 *     location — with `xstate/graph`'s `getShortestPaths`. Closed roads are
 *     guarded out of the traversal, so a returned route never contains a road
 *     already known to be shut.
 *   - The MODEL owns judgement: after a closure it decides whether the detour
 *     is worth taking or the delivery should be abandoned, and it writes the
 *     final report. It never picks a road — that is a search problem, and the
 *     machine is the search space.
 *
 * Progress is announced with `enq.emit(...)` (PLANNED / ARRIVED / BLOCKED /
 * REPLANNED), so a host watching the run sees the plan form, break, and reform.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/route-replanning/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic, setup } from "xstate";
import { getShortestPaths } from "xstate/graph";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { runAgent, setupAgent, type RunAgentOptions } from "@statelyai/agent";

const models = defineModels({ dispatcher: openai("gpt-5.4-mini") });

// ─── The road network ───

const locationSchema = z.enum(["depot", "northGate", "eastGate", "bridge", "riverside", "market"]);
type Location = z.infer<typeof locationSchema>;

/**
 * Every one-way road. Small enough to read at a glance, and deliberately
 * shaped so one route is strictly shortest: depot → eastGate → bridge →
 * market. That is the route any first plan takes, and the bridge is where the
 * world is about to disagree.
 */
const ROADS: ReadonlyArray<readonly [Location, Location]> = [
  ["depot", "eastGate"],
  ["depot", "northGate"],
  ["northGate", "eastGate"],
  ["eastGate", "bridge"],
  ["bridge", "market"],
  ["bridge", "riverside"],
  ["riverside", "market"],
];

/** A road's key in `closed`, e.g. `"bridge>market"`. */
const roadKey = (from: Location, to: Location) => `${from}>${to}`;

/** The roads leading out of `from` that are not known to be shut. */
function openRoadsFrom(from: Location, closed: readonly string[]): Location[] {
  return ROADS.filter(([a, b]) => a === from && !closed.includes(roadKey(a, b))).map(([, b]) => b);
}

/**
 * The network as a bare XState machine: the courier's location IS the state
 * value, so the search space is the statechart itself and `getShortestPaths`
 * needs no custom serializer to tell two positions apart.
 */
const networkSetup = setup({
  schemas: {
    context: z.object({ closed: z.array(z.string()) }),
    input: z.object({ closed: z.array(z.string()) }),
    events: { GO: z.object({ to: locationSchema }) },
  },
});

export const roadNetwork = networkSetup.createMachine({
  id: "road-network",
  context: ({ input }) => ({ closed: input.closed }),
  initial: "depot",
  states: Object.fromEntries(
    locationSchema.options.map((from) => [
      from,
      {
        on: {
          // Guarded by the same closure list the courier is carrying: a shut
          // road is not in the graph, so a plan cannot route through one.
          GO: ({ context, event }: { context: { closed: string[] }; event: { to: Location } }) =>
            openRoadsFrom(from, context.closed).includes(event.to)
              ? { target: event.to }
              : undefined,
        },
      },
    ]),
  ) as never,
});

/** The traversal tries a `GO` to every location; the guards reject the rest. */
const GO_EVENTS = locationSchema.options.map((to) => ({ type: "GO" as const, to }));

/**
 * The shortest open route from `from` to `market`, or `null` when the closures
 * have cut the destination off entirely. Plain BFS over the statechart.
 */
export function planFrom(from: Location, closed: readonly string[]): Location[] | null {
  const context = { closed: [...closed] };
  const paths = getShortestPaths(roadNetwork, {
    input: context,
    // Seeded where the courier is STANDING, not at the depot. A replan is a
    // fresh search from here; the abandoned route is not consulted at all.
    fromState: roadNetwork.resolveState({ value: from, context }),
    events: GO_EVENTS,
    stopWhen: (snapshot) => snapshot.value === "market",
  });
  const route = paths.find((path) => path.state.value === "market");
  if (!route) return null;
  return route.steps
    .map((step) => step.event)
    .filter((event) => event.type === "GO")
    .map((event) => event.to);
}

// ─── The world's vote ───

/**
 * The road the world has decided to shut. A plan made before this is
 * discovered is not wrong — it is out of date, which is the whole point.
 */
export const CLOSED_ROAD = roadKey("bridge", "market");

type LegResult = { arrived: true; at: Location } | { arrived: false; closed: string };

/** Driving a leg is where a plan meets the world. */
const driveLeg = createAsyncLogic<LegResult, { from: Location; to: Location }>({
  run: async ({ input }) => {
    const road = roadKey(input.from, input.to);
    return road === CLOSED_ROAD
      ? { arrived: false, closed: road }
      : { arrived: true, at: input.to };
  },
});

const planRoute = createAsyncLogic<Location[], { from: Location; closed: string[] }>({
  run: async ({ input }) => {
    const route = planFrom(input.from, input.closed);
    if (!route) throw new Error(`No open route to the market from ${input.from}.`);
    return route;
  },
});

// ─── The agent machine ───

const MAX_REPLANS = 2;

const agentSetup = setupAgent({
  models,
  context: z.object({
    at: locationSchema,
    route: z.array(locationSchema),
    closed: z.array(z.string()),
    travelled: z.array(z.string()),
    replans: z.number(),
    maxReplans: z.number(),
    lastClosure: z.string().nullable(),
    report: z.string().nullable(),
  }),
  input: z.object({ parcel: z.string().default("a birthday cake") }),
  output: z.object({
    delivered: z.boolean(),
    report: z.string(),
    legs: z.number(),
    replans: z.number(),
    travelled: z.array(z.string()),
  }),
  events: {
    /** Take the detour the machine just computed. */
    REROUTE: z.object({ reasoning: z.string() }),
    /** Give up: the parcel goes back to the depot. */
    ABANDON: z.object({ reasoning: z.string() }),
  },
  emitted: {
    PLANNED: z.object({ legs: z.number(), via: z.string() }),
    ARRIVED: z.object({ at: z.string(), remaining: z.number() }),
    BLOCKED: z.object({ road: z.string() }),
    REPLANNED: z.object({ legs: z.number(), via: z.string() }),
  },
  actors: { driveLeg, planRoute },
  requests: {
    writeReport: {
      schemas: {
        input: z.object({ travelled: z.array(z.string()), delivered: z.boolean() }),
        output: z.string(),
      },
      model: "dispatcher",
      system:
        "You are a courier dispatcher writing a two-sentence delivery note. " +
        "Say where the parcel went and mention any road closure that forced a detour.",
      prompt: ({ input }) =>
        [
          `Delivered: ${input.delivered}`,
          "Legs travelled:",
          ...input.travelled.map((leg, index) => `${index + 1}. ${leg}`),
        ].join("\n"),
    },
  },
  states: {
    // Reachable only with a route to follow, so `route[0]` is never undefined.
    driving: { schemas: { context: z.object({ route: z.array(locationSchema).nonempty() }) } },
  },
});

export const routeReplanningMachine = agentSetup.createMachine({
  id: "route-replanning",
  context: ({ input }) => ({
    at: "depot" as const,
    route: [],
    closed: [],
    travelled: [],
    replans: 0,
    maxReplans: MAX_REPLANS,
    lastClosure: null,
    report: null,
    parcel: input.parcel,
  }),
  output: ({ context }) => ({
    delivered: context.at === "market",
    report: context.report ?? "No report was written.",
    legs: context.travelled.length,
    replans: context.replans,
    travelled: context.travelled,
  }),
  initial: "planning",
  states: {
    // The whole route, up front. Entered again only when the world contradicts
    // the plan — never between ordinary legs.
    planning: {
      invoke: {
        src: "planRoute",
        input: ({ context }) => ({ from: context.at, closed: context.closed }),
        onDone: ({ context, output }, enq) => {
          const replanned = context.replans > 0;
          enq.emit({
            type: replanned ? "REPLANNED" : "PLANNED",
            legs: output.length,
            via: output.join(" → "),
          });
          return { target: "driving", context: { route: output } };
        },
        onError: { target: "reporting" },
      },
    },
    // One leg at a time, straight down the plan. No model call and no
    // recomputation: the route in context is still believed to be true.
    driving: {
      invoke: {
        src: "driveLeg",
        input: ({ context }) => {
          const [next] = context.route;
          if (!next) throw new Error("driving with no route left");
          return { from: context.at, to: next };
        },
        onDone: ({ context, output }, enq) => {
          if (!output.arrived) {
            enq.emit({ type: "BLOCKED", road: output.closed });
            return {
              target: "blocked",
              // What the courier learned. It goes into the world, not into a
              // prompt: the next traversal routes around it for free.
              context: { closed: [...context.closed, output.closed], lastClosure: output.closed },
            };
          }
          const rest = context.route.slice(1);
          enq.emit({ type: "ARRIVED", at: output.at, remaining: rest.length });
          return {
            target: "arrived",
            context: {
              at: output.at,
              route: rest,
              travelled: [...context.travelled, `${context.at} → ${output.at}`],
            },
          };
        },
        onError: { target: "reporting" },
      },
    },
    // One hop of bookkeeping between legs: at the market, or drive the next
    // leg of the plan already in hand.
    arrived: {
      type: "choice",
      choice: ({ context }) =>
        context.at === "market" || context.route.length === 0
          ? { target: "reporting" }
          : { target: "driving" },
    },
    // The one judgement call worth a model: the plan is dead, a detour exists,
    // and someone has to decide whether the parcel is still worth delivering.
    blocked: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "dispatcher",
          system:
            "A road on the courier's route is closed. Reroute when a detour is " +
            "plausible and the replan budget allows it; abandon only when it is not.",
          prompt: [
            `Closed road: ${context.lastClosure}`,
            `Courier is at: ${context.at}`,
            `Legs travelled so far: ${context.travelled.length}`,
            `Replans used: ${context.replans} of ${context.maxReplans}`,
          ].join("\n"),
          allowedEvents: ["REROUTE", "ABANDON"],
          maxRetries: 2,
        }),
        onError: { target: "reporting" },
      },
      on: {
        // Bounded: past the budget the transition returns nothing, so REROUTE
        // is not an accepted event and the decision must abandon.
        REROUTE: ({ context }) =>
          context.replans >= context.maxReplans
            ? undefined
            : { target: "planning", context: { replans: context.replans + 1 } },
        ABANDON: { target: "reporting" },
      },
    },
    reporting: {
      invoke: {
        src: "writeReport",
        input: ({ context }) => ({
          travelled: context.travelled,
          delivered: context.at === "market",
        }),
        onDone: ({ output }) => ({ target: "done", context: { report: output } }),
        onError: ({ event }) => ({
          target: "done",
          context: { report: `No report: ${String(event.error)}` },
        }),
      },
    },
    done: { type: "final" },
  },
});

/** Runs the delivery. `options` lets a test inject executors. */
export async function runRouteReplanningExample(
  options: Partial<RunAgentOptions<typeof routeReplanningMachine>> = {},
) {
  const result = await runAgent(routeReplanningMachine, {
    input: { parcel: "a birthday cake" },
    executors: createAiSdkExecutors({ models }),
    ...options,
  });
  if (result.status !== "done") throw new Error(`Expected done, got '${result.status}'.`);
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  console.log(await runRouteReplanningExample());
}
