import type { ScenarioId } from "./scenarios";

/** What the workspace is showing: a runnable scenario or a library example. */
export type Selection =
  | { type: "scenario"; id: ScenarioId }
  | { type: "example"; id: string };
