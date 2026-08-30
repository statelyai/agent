/**
 * Preset agent machines: thin factories over `setupAgent(...).createMachine(...)`,
 * named after proven cross-framework agent shapes.
 *
 * Every preset returns an ORDINARY, fully inspectable XState machine — same
 * states, same lint, same snapshots as a hand-written one. Executors are still
 * supplied separately by the host (`runAgent`/`generateResult`), and nothing
 * here names an SDK.
 *
 * See docs/machines-presets.md.
 */
export { createToolLoopMachine } from "./tool-loop.js";
export type {
  CreateToolLoopMachineConfig,
  ToolLoopContext,
  ToolLoopInput,
  ToolLoopMachine,
  ToolLoopOutput,
} from "./tool-loop.js";

export { createSequentialMachine } from "./sequential.js";
export type {
  CreateSequentialMachineConfig,
  SequentialContext,
  SequentialInput,
  SequentialMachine,
  SequentialOutput,
  SequentialPromptArgs,
  SequentialStep,
} from "./sequential.js";

export { createRouterMachine, routeEventType } from "./router.js";
export type {
  CreateRouterMachineConfig,
  RouterContext,
  RouterEvent,
  RouterInput,
  RouterMachine,
  RouterOutput,
} from "./router.js";

export { createParallelMachine } from "./parallel.js";
export type {
  CreateParallelMachineConfig,
  ParallelContext,
  ParallelInput,
  ParallelMachine,
  ParallelOutput,
} from "./parallel.js";

export { createLoopMachine } from "./loop.js";
export type {
  CreateLoopMachineConfig,
  LoopContext,
  LoopInput,
  LoopMachine,
  LoopOutput,
  LoopState,
} from "./loop.js";

export { createSupervisorMachine, delegateEventType, FINISH_EVENT_TYPE } from "./supervisor.js";
export type {
  CreateSupervisorMachineConfig,
  SupervisorContext,
  SupervisorEvent,
  SupervisorInput,
  SupervisorMachine,
  SupervisorOutput,
} from "./supervisor.js";

export { createHandoffMachine, transferEventType } from "./handoff.js";
export type {
  CreateHandoffMachineConfig,
  HandoffContext,
  HandoffEvent,
  HandoffInput,
  HandoffMachine,
} from "./handoff.js";

export type {
  PresetEntry,
  PresetMachine,
  PresetMachineEntry,
  PresetRequestEntry,
} from "./internal.js";
