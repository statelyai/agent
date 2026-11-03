/**
 * `checkParity` — one call that records a workflow, replays its port, and
 * compares their effects, per scenario.
 * @module
 */
import {
  compareRecordings,
  createRecorder,
  type CompareRecordingsOptions,
  type EffectDivergence,
  type Recorder,
  type Recording,
} from "./equivalence.js";
import { mapEffects } from "./internal/effects.js";

/** One scenario: an id and the workflow's input. Extra fields are yours. */
export interface CheckParityScenario<TInput = unknown> {
  id: string;
  input: TInput;
}

/** How one side of a scenario ended: what it returned, or what it threw. */
export type CheckParityOutcome<TOutput = unknown> = { output: TOutput } | { error: unknown };

/** Options for {@link checkParity}. */
export interface CheckParityOptions<
  TScenario extends CheckParityScenario,
  TEffects extends object,
  TOutput,
> {
  scenarios: readonly TScenario[];
  /**
   * Fresh effects for one scenario: fakes, stubs, or real clients. `before`
   * runs on them for real, recorded, so a write effect writes once per
   * scenario: point it at an isolated fixture, not production. `after` gets
   * replay stand-ins and never runs them. A class instance's prototype
   * methods count, bound to the instance.
   */
  effects: (scenario: TScenario) => TEffects;
  /** The original workflow. */
  before: (input: TScenario["input"], effects: TEffects) => PromiseLike<TOutput>;
  /** The port: a `wrapWorkflow` run (`(input, effects) => step.run(input, { effects })`) or any runner with the same signature. */
  after: (input: TScenario["input"], effects: TEffects) => PromiseLike<unknown>;
  /** Passed to `compareRecordings`. */
  compare?: CompareRecordingsOptions;
}

/** One scenario's row in a {@link CheckParityReport}. */
export interface CheckParityRow<TScenario extends CheckParityScenario, TOutput> {
  id: string;
  scenario: TScenario;
  /** No divergence, and both sides returned the same value or threw the same error. */
  equivalent: boolean;
  divergences: EffectDivergence[];
  before: CheckParityOutcome<TOutput>;
  after: CheckParityOutcome;
  /** The golden recording of `before`: save it as a fixture. */
  recording: Recording;
  /** What `after` did in replay. */
  replay: Recording;
}

/** The result of {@link checkParity}. */
export interface CheckParityReport<TScenario extends CheckParityScenario, TOutput> {
  /** Every scenario is equivalent. */
  equivalent: boolean;
  scenarios: CheckParityRow<TScenario, TOutput>[];
}

/** Each function effect wrapped with `recorder.fn`, by its key. */
function recordEffects<TEffects extends object>(recorder: Recorder, effects: TEffects): TEffects {
  return mapEffects(effects, (name, effect) => recorder.fn(name, effect));
}

async function settle<T>(run: () => PromiseLike<T>, recorder: Recorder) {
  try {
    const output = await run();
    recorder.output(output);
    return { output };
  } catch (error) {
    return { error };
  }
}

function errorIdentity(outcome: CheckParityOutcome): string | undefined {
  if (!("error" in outcome)) return undefined;
  const { error } = outcome;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Checks a port against the workflow it replaces, scenario by scenario: runs
 * `before` on fresh `effects` under `createRecorder`, replays `after` against
 * that recording (no effect really runs), and compares the two with
 * `compareRecordings`. Effects are compared by name, call order, arguments
 * and results; the output by value.
 *
 * Never throws for a port that misbehaves: an `after` that throws (a
 * `RecordingDivergenceError` for a call the original never made, or its own
 * error) is a row with `after: { error }`. When both sides throw, they match
 * on the error's name and message.
 *
 * @example
 * ```ts
 * const report = await checkParity({
 *   scenarios: [{ id: "refund", input: ticket }],
 *   effects: () => createFakeEffects(),
 *   before: (input, effects) => legacyRunTicket(input, effects),
 *   after: (input, effects) => step1.run(input, { effects }),
 * });
 * expect(report.equivalent).toBe(true);
 * ```
 */
export async function checkParity<
  TScenario extends CheckParityScenario,
  TEffects extends object,
  TOutput,
>(
  options: CheckParityOptions<TScenario, TEffects, TOutput>,
): Promise<CheckParityReport<TScenario, TOutput>> {
  const rows: CheckParityRow<TScenario, TOutput>[] = [];
  for (const scenario of options.scenarios) {
    const recorder = createRecorder();
    const effects = recordEffects(recorder, options.effects(scenario));
    const before = await settle(() => options.before(scenario.input, effects), recorder);
    const recording = recorder.recording;

    const replayer = createRecorder({ replay: recording });
    const stand = recordEffects(replayer, options.effects(scenario));
    const after = await settle(() => options.after(scenario.input, stand), replayer);
    const replay = replayer.recording;

    const { divergences } = compareRecordings(recording, replay, options.compare);
    const thrownBefore = errorIdentity(before);
    const thrownAfter = errorIdentity(after);
    if (thrownBefore !== undefined && thrownAfter !== undefined && thrownBefore !== thrownAfter) {
      divergences.push({
        index: recording.effects.length,
        reason: "output",
        message: `The original threw ${thrownBefore}; the port threw ${thrownAfter}.`,
      });
    }
    rows.push({
      id: scenario.id,
      scenario,
      equivalent: divergences.length === 0,
      divergences,
      before,
      after,
      recording,
      replay,
    });
  }
  return { equivalent: rows.every((row) => row.equivalent), scenarios: rows };
}
