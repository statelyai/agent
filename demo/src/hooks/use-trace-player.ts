import { useCallback, useEffect, useRef, useState } from "react";
import type { TraceEntry } from "@/lib/agent-runner";

export type VizFrame = {
  value: unknown;
  status: string;
  context: Record<string, unknown>;
  event: { type: string; [key: string]: unknown } | null;
};

// Replay pacing: real per-transition durations, time-compressed to fit the
// total budget, with a floor so back-to-back transitions stay readable.
const MAX_REPLAY_MS = 5000;
const MIN_STEP_MS = 280;
const MAX_STEP_MS = 2200;

/**
 * Turns the server-side `at` stamps into replay delays that PRESERVE the
 * run's relative timing — a state the machine sat in for 4s gets visibly more
 * screen time than a 50ms hop — compressed so the whole replay fits ~5s.
 */
function replayDelays(trace: TraceEntry[]): number[] {
  const total = trace.length ? (trace[trace.length - 1].at ?? 0) : 0;
  const scale = total > 0 ? Math.min(1, MAX_REPLAY_MS / total) : 0;
  let previousAt = 0;
  let accumulated = 0;
  return trace.map((entry, index) => {
    // The viewer already watched the initial state during the request itself,
    // so the first transition shows promptly instead of re-waiting.
    const rawDelta = index === 0 ? 0 : Math.max(0, (entry.at ?? previousAt) - previousAt);
    previousAt = entry.at ?? previousAt;
    const delta = Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, rawDelta * scale));
    accumulated += delta;
    return accumulated;
  });
}

function initialFrame(initialValue: string | null): VizFrame {
  return {
    value: initialValue ?? "…",
    status: "active",
    context: {},
    event: null,
  };
}

/**
 * Replays the server's real transition trace into a single "current frame" the
 * viz panel posts to the Stately embed. The ~300ms stagger is purely for
 * animation — the data is the machine's actual run, not a simulation.
 *
 * `machineKey` identifies the inspected machine (scenario or example export);
 * `initialValue` is its initial state name for the resting frame.
 */
export function useTracePlayer(machineKey: string, initialValue: string | null) {
  const [frame, setFrame] = useState<VizFrame>(() => initialFrame(initialValue));
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const initialRef = useRef(initialValue);
  initialRef.current = initialValue;

  const clear = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  // Reset to the initial state whenever the inspected machine changes.
  useEffect(() => {
    clear();
    setFrame(initialFrame(initialRef.current));
    return clear;
  }, [machineKey, clear]);

  const play = useCallback((trace: TraceEntry[]) => {
    const delays = replayDelays(trace);
    trace.forEach((entry, index) => {
      timers.current.push(
        setTimeout(() => {
          setFrame({ value: entry.value, status: "active", context: entry.context, event: entry.event });
        }, delays[index]),
      );
    });
  }, []);

  const reset = useCallback(() => {
    clear();
    setFrame(initialFrame(initialRef.current));
  }, [clear]);

  return { frame, play, reset };
}
