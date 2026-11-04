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
  stableStringify,
} from "./equivalence.js";
import { mapEffects } from "./internal/effects.js";
import { toJsonValue } from "./run-agent.js";

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
  /**
   * Maps each side's output before it is compared: drop or pin what differs
   * run to run (a duration, a generated id). Rows keep the raw outputs.
   */
  normalizeOutput?: (output: unknown, scenario: TScenario) => unknown;
  /**
   * Maps each side's thrown error before it is compared: drop what differs
   * run to run (an embedded stack line, a generated id). An `Error` result
   * matches on name and message, anything else on its JSON. Rows keep the
   * raw errors.
   */
  normalizeError?: (error: unknown, scenario: TScenario) => unknown;
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

async function settle<T>(
  run: () => PromiseLike<T>,
  recorder: Recorder,
  normalize: (output: unknown) => unknown,
) {
  try {
    const output = await run();
    recorder.output(normalize(output));
    return { output };
  } catch (error) {
    return { error };
  }
}

function errorIdentity(
  outcome: CheckParityOutcome,
  normalize?: (error: unknown) => unknown,
): string | undefined {
  if (!("error" in outcome)) return undefined;
  const error = normalize ? normalize(outcome.error) : outcome.error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (!normalize) return String(error);
  try {
    return stableStringify(toJsonValue(error) ?? null);
  } catch {
    return String(error);
  }
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
 * on the error's name and message, after `normalizeError` when given.
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
    const normalize = (output: unknown) =>
      options.normalizeOutput ? options.normalizeOutput(output, scenario) : output;
    const before = await settle(() => options.before(scenario.input, effects), recorder, normalize);
    const recording = recorder.recording;

    const replayer = createRecorder({ replay: recording });
    const stand = recordEffects(replayer, options.effects(scenario));
    const after = await settle(() => options.after(scenario.input, stand), replayer, normalize);
    const replay = replayer.recording;

    const { divergences } = compareRecordings(recording, replay, options.compare);
    const normalizeError =
      options.normalizeError && ((error: unknown) => options.normalizeError!(error, scenario));
    const thrownBefore = errorIdentity(before, normalizeError);
    const thrownAfter = errorIdentity(after, normalizeError);
    if (thrownBefore !== undefined && thrownAfter !== undefined && thrownBefore !== thrownAfter) {
      divergences.push({
        index: recording.effects.length,
        reason: "output",
        message: `The original threw ${thrownBefore}; the port threw ${thrownAfter}.`,
      });
    } else if ((thrownBefore === undefined) !== (thrownAfter === undefined)) {
      // One side returned, the other threw: name the error in the divergence.
      const returned = (thrownBefore === undefined ? recording : replay).effects
        .filter((effect) => effect.kind === "output")
        .at(-1);
      const value = JSON.stringify(returned?.kind === "output" ? returned.value : undefined);
      const message =
        thrownAfter !== undefined
          ? `The original returned ${value}; the port threw ${thrownAfter}.`
          : `The original threw ${thrownBefore}; the port returned ${value}.`;
      const existing = divergences.find(
        (d) =>
          d.reason === "output" &&
          (d.expected?.kind === "output") !== (d.actual?.kind === "output"),
      );
      if (existing) existing.message = message;
      else divergences.push({ index: recording.effects.length, reason: "output", message });
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
