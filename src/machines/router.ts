import { setupAgent } from "../setup-agent.js";
import {
  assertEntryNames,
  DECIDE_SRC,
  emptyPayload,
  entryInput,
  entrySrc,
  jsonAny,
  jsonString,
  machineActors,
  objectSchema,
  renderEntryList,
  type PresetEntry,
  type PresetMachine,
} from "./internal.js";

/** Config for {@link createRouterMachine}. */
export interface CreateRouterMachineConfig<
  TRoutes extends Record<string, PresetEntry> = Record<string, PresetEntry>,
> {
  /** Model ref for the routing decision, and the default for request routes. */
  model: string;
  /** System prompt for the routing decision. */
  instructions?: string;
  /** The legal destinations, keyed by route name. Each is an inline request or a child machine. */
  routes: TRoutes;
  /** Route taken when the routing decision errors. Without it, a failed decision ends the run. */
  fallback?: keyof TRoutes & string;
}

/** Context of a {@link createRouterMachine} machine. */
export type RouterContext<TRoute extends string = string> = {
  prompt: string;
  route: TRoute | null;
  result: unknown;
};

/** Machine input of a {@link createRouterMachine} machine. */
export type RouterInput = { prompt: string };
/** Machine output of a {@link createRouterMachine} machine. */
export type RouterOutput<TRoute extends string = string> = {
  route: TRoute | null;
  result: unknown;
};
/** The events a {@link createRouterMachine} machine accepts: one per declared route. */
export type RouterEvent<TRoute extends string = string> = { type: `ROUTE_${TRoute}` };
/** The machine {@link createRouterMachine} returns. */
export type RouterMachine<TRoute extends string = string> = PresetMachine<
  RouterContext<TRoute>,
  RouterInput,
  RouterOutput<TRoute>,
  RouterEvent<TRoute>
>;

const contextSchema = objectSchema<RouterContext>(
  { prompt: jsonString, route: { type: ["string", "null"] }, result: jsonAny },
  ["prompt"],
);
const inputSchema = objectSchema<{ prompt: string }>({ prompt: jsonString }, ["prompt"]);
const outputSchema = objectSchema<{ route: string | null; result: unknown }>(
  { route: { type: ["string", "null"] }, result: jsonAny },
  ["route"],
);

/** The event a route decision chooses: `ROUTE_<name>`. */
export function routeEventType(route: string): string {
  return `ROUTE_${route}`;
}

/**
 * One `agent.decide` picks exactly one declared route, then the machine runs
 * it. Only the declared routes have events and transitions, so a model naming
 * anything else is rejected before any work happens — illegal routes are
 * impossible, not discouraged.
 *
 * States: `routing` → one state per route → `done`.
 *
 * ```ts
 * const machine = createRouterMachine({
 *   model: "quick",
 *   routes: {
 *     billing: { description: "Payments and invoices", instructions: "Answer the billing question." },
 *     technical: { description: "Bugs and outages", machine: technicalMachine },
 *   },
 *   fallback: "technical",
 * });
 * ```
 */
export function createRouterMachine<const TRoutes extends Record<string, PresetEntry>>(
  config: CreateRouterMachineConfig<TRoutes>,
): RouterMachine<keyof TRoutes & string> {
  const { model, instructions, routes, fallback } = config;
  const names = Object.keys(routes);
  assertEntryNames("route", names, ["routing", "done"]);
  if (fallback !== undefined && !names.includes(fallback)) {
    throw new Error(
      `createRouterMachine: fallback '${fallback}' is not a declared route (${names.join(", ")}).`,
    );
  }

  const agentSetup = setupAgent({
    context: contextSchema,
    input: inputSchema,
    output: outputSchema,
    events: Object.fromEntries(names.map((name) => [routeEventType(name), emptyPayload])),
    actors: machineActors(routes),
  });

  const routeList = renderEntryList(routes);
  const states: Record<string, unknown> = {
    routing: {
      invoke: {
        id: "route",
        src: DECIDE_SRC,
        input: ({ context }: { context: RouterContext }) => ({
          model,
          system:
            instructions ??
            "Route the request to exactly one destination. Choose the single best fit.",
          prompt: `Request:\n${context.prompt}\n\nDestinations:\n${routeList}`,
          allowedEvents: names.map(routeEventType),
        }),
        ...(fallback ? { onError: { target: fallback, context: { route: fallback } } } : {}),
      },
      on: Object.fromEntries(
        names.map((name) => [routeEventType(name), { target: name, context: { route: name } }]),
      ),
    },
    done: {
      type: "final",
      output: ({ context }: { context: RouterContext }) => ({
        route: context.route,
        result: context.result,
      }),
    },
  };

  for (const [name, entry] of Object.entries(routes)) {
    states[name] = {
      invoke: {
        id: name,
        src: entrySrc(name, entry),
        input: ({ context }: { context: RouterContext }) =>
          entryInput(name, entry, model, context.prompt),
        onDone: ({ output }: { output: unknown }) => ({
          target: "done",
          context: { result: output },
        }),
      },
    };
  }

  const machineConfig = {
    id: "router",
    // Stamped by runAgent onto snapshots/logs instead of the structural hash;
    // bumped only on a topology change a snapshot could not resume into.
    version: "1",
    context: ({ input }: { input: { prompt: string } }) => ({
      prompt: input.prompt,
      route: null,
      result: null,
    }),
    initial: "routing",
    states,
  } as unknown as Parameters<typeof agentSetup.createMachine>[0];

  const machine = agentSetup.createMachine(machineConfig);

  return machine as unknown as RouterMachine<keyof TRoutes & string>;
}
