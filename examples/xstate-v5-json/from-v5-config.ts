/**
 * Loads an XState v5-style machine config (the JSON `createMachine` takes,
 * or a Stately Studio export) as an XState v6 machine.
 *
 * v6's `createMachineFromConfig` reads almost the same JSON. The differences
 * this bridges:
 *
 *   - Shorthands: v5 allows `"onError": "failed"`, `"actions": "save"` and
 *     `"guard": "canRevise"`; v6 JSON spells them `{ target }` and `{ type }`.
 *   - Context updates: v5 updates context with named `assign(...)` actions
 *     implemented in code. A v6 action is a side effect, so each named assign
 *     is rewritten to a `@code` reference that a lookup-only evaluator resolves
 *     to your function's return value — the new context fields. Nothing is
 *     evaluated as source text; the name only selects a function you passed.
 *   - Invoke input: v5 computes it in code (`input: ({ context }) => ...`),
 *     which JSON cannot hold, so `inputs` supplies it per `src`, the same way.
 *   - Actors: passed by `src` name; the invokes keep those names, so the
 *     agent runtime can still bind its executors to the requests.
 */
import {
  createMachineFromConfig,
  type AnyActorLogic,
  type AnyStateMachine,
  type MachineJSON,
} from "xstate";

type Scope = { context: any; event: any };
type Json = any;

export interface V5Implementations {
  /** Invoked actors by `src` name — model requests, async logic, child machines. */
  actors?: Record<string, AnyActorLogic>;
  /** Named guards: `(args) => boolean`. */
  guards?: Record<string, (args: Scope) => boolean>;
  /** Named `assign` actions: return the context fields to update. */
  assigns?: Record<string, (args: Scope) => Record<string, unknown>>;
  /** Invoke input per `src` name. */
  inputs?: Record<string, (args: Scope) => unknown>;
  /** Named side-effect actions (logging, notifications). */
  actions?: Record<string, (...args: any[]) => unknown>;
}

const LANG = "v5-named";

export function fromV5Config(config: object, impl: V5Implementations): AnyStateMachine {
  const assigns = impl.assigns ?? {};
  const inputs = impl.inputs ?? {};

  const action = (entry: Json): Json => {
    const named = typeof entry === "string" ? { type: entry } : entry;
    return named.type in assigns ? { "@code": named.type } : named;
  };
  const actions = (value: Json): Json[] => (Array.isArray(value) ? value : [value]).map(action);
  const transition = (value: Json): Json => {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value.map(transition);
    if (typeof value === "string") return { target: value };
    return {
      ...value,
      ...(value.actions !== undefined ? { actions: actions(value.actions) } : {}),
      ...(typeof value.guard === "string" ? { guard: { type: value.guard } } : {}),
    };
  };
  const transitions = (map: Json): Json =>
    map && Object.fromEntries(Object.entries(map).map(([key, value]) => [key, transition(value)]));
  const invoke = (value: Json): Json => ({
    ...value,
    ...(value.input === undefined && value.src in inputs ? { input: { "@code": value.src } } : {}),
    ...(value.onDone !== undefined ? { onDone: transition(value.onDone) } : {}),
    ...(value.onError !== undefined ? { onError: transition(value.onError) } : {}),
  });
  const state = (node: Json): Json => ({
    ...node,
    ...(node.on ? { on: transitions(node.on) } : {}),
    ...(node.after ? { after: transitions(node.after) } : {}),
    ...(node.always !== undefined ? { always: transition(node.always) } : {}),
    ...(node.onDone !== undefined ? { onDone: transition(node.onDone) } : {}),
    ...(node.entry !== undefined ? { entry: actions(node.entry) } : {}),
    ...(node.exit !== undefined ? { exit: actions(node.exit) } : {}),
    ...(node.invoke
      ? { invoke: Array.isArray(node.invoke) ? node.invoke.map(invoke) : invoke(node.invoke) }
      : {}),
    ...(node.states
      ? {
          states: Object.fromEntries(
            Object.entries(node.states).map(([key, child]) => [key, state(child)]),
          ),
        }
      : {}),
  });

  const actors = impl.actors ?? {};
  return createMachineFromConfig({ ...state(config), "@exprLang": LANG } as MachineJSON, {
    // Invokes keep their string srcs, so the agent runtime can bind them.
    actors,
    guards: impl.guards as never,
    actions: impl.actions,
    evaluators: {
      [LANG]: ({ source, slot, scope }) =>
        slot === "input"
          ? inputs[source]!(scope as Scope)
          : { context: assigns[source]!(scope as Scope) },
    },
  });
}
