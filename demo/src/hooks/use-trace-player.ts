import { useCallback, useEffect, useRef, useState } from "react";
import type { ScenarioId } from "@/lib/scenarios";
import { scenarioVizConfig } from "@/lib/scenarios";
import type { TraceEntry } from "@/lib/agent-runner";

export type VizFrame = {
  value: unknown;
  status: string;
  context: Record<string, unknown>;
  event: { type: string; [key: string]: unknown } | null;
};

const STAGGER_MS = 300;

function initialFrame(scenarioId: ScenarioId): VizFrame {
  const config = scenarioVizConfig[scenarioId] as { initial?: unknown };
  return {
    value: typeof config.initial === "string" ? config.initial : "…",
    status: "active",
    context: {},
    event: null,
  };
}

/**
 * Replays the server's real transition trace into a single "current frame" the
 * viz panel posts to the Stately embed. The ~300ms stagger is purely for
 * animation — the data is the machine's actual run, not a simulation.
 */
export function useTracePlayer(scenarioId: ScenarioId) {
  const [frame, setFrame] = useState<VizFrame>(() => initialFrame(scenarioId));
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const clear = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  // Reset to the initial state whenever the scenario changes.
  useEffect(() => {
    clear();
    setFrame(initialFrame(scenarioId));
    return clear;
  }, [scenarioId, clear]);

  const play = useCallback(
    (trace: TraceEntry[]) => {
      trace.forEach((entry, index) => {
        timers.current.push(
          setTimeout(() => {
            setFrame({ value: entry.value, status: "active", context: entry.context, event: entry.event });
          }, index * STAGGER_MS),
        );
      });
    },
    [],
  );

  const reset = useCallback(() => {
    clear();
    setFrame(initialFrame(scenarioId));
  }, [clear, scenarioId]);

  return { frame, play, reset };
}
