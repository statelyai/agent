/**
 * Tree of Thoughts — LangGraph's "Tree of Thoughts" tutorial (Yao et al. 2023)
 * on the Game of 24, as a beam search where the MACHINE is the referee.
 *
 * The puzzle: combine four numbers with + - * / to make 24, one step at a
 * time ("10 - 4 = 6" leaves 6, 9, 13). The model proposes steps; a search
 * keeps the most promising partial solutions (the beam) and expands them
 * again, up to a fixed depth.
 *
 * LangGraph shape (tutorials/tot/tot):
 *
 *   START → expand ──(Send, one per beam candidate)──→ score → prune → should_terminate ─┬─ END
 *             ▲                                                                         │
 *             └─────────────────────────────────────────────────────────────────────────┘
 *
 * Machine shape:
 *
 *   expanding ⇄ expanded ──→ scoring → pruning ─┬─ done        (a line reaches 24)
 *   (one request per       (all beam          ├─ failed      (beam empty, or depth >= MAX_DEPTH)
 *    beam entry)            entries asked)     └─ expanding   (next depth, top BEAM_SIZE kept)
 *
 * What maps to what:
 *   - expand (Send per candidate) → `expanding` + `expanded`: one `propose`
 *                                   request per beam entry, walked by a
 *                                   `beamIndex` counter (sequential, not
 *                                   parallel: simpler, same proposals)
 *   - score                       → `scoring`: a plain, hand-written actor
 *   - prune                       → `pruning`, a choice state keeping the
 *                                   top `BEAM_SIZE` candidates
 *   - should_terminate            → the same choice state's other targets
 *   - max_depth                   → `MAX_DEPTH`, compared to `depth` in context
 *
 * Differences from LangGraph worth calling out:
 *   - The scorer is the referee. It parses every proposed "a op b = c",
 *     REJECTS a step whose operands are not both in that line's remaining
 *     numbers or whose arithmetic is wrong, and records why. Only then does it
 *     score: 1 if the remaining numbers can still reach 24 (brute force over
 *     at most four numbers), else 0. A model that invents a number or
 *     miscounts cannot put an illegal line in the beam, and a solution is
 *     only ever a line the machine re-derived itself.
 *   - Pruning keeps the top BEAM_SIZE valid candidates by score; a live line
 *     (score 1) always outranks a dead one.
 *   - "No solution" is a `failed` final state with the reason (every step
 *     rejected, or the depth budget spent), never `done` with an empty answer.
 *   - Expansion is sequential over the beam rather than a parallel `Send`.
 *
 * No stand-ins: there is no tool here. Everything except the proposals is
 * deterministic machine code.
 *
 * Dual-mode: `runTreeOfThoughtsExample(options?)` takes an injectable
 * `generateText` (tests pass scripted proposers; no API key); the direct run
 * uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/tree-of-thoughts/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStatePath, runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const models = {
  proposer: openai("gpt-5.4-mini"),
};

/** Partial solutions kept after each depth. */
export const BEAM_SIZE = 3;

/** Expansion rounds. Four numbers need exactly three steps. */
export const MAX_DEPTH = 3;

/** Most next steps one `propose` call may return. */
export const MAX_PROPOSALS = 5;

const TARGET = 24;
const EPSILON = 1e-6;
/** How far a model's stated result or operand may be from the real value (rounding). */
const TOLERANCE = 0.005;

/** Numbers as the model sees them: at most 4 decimals. */
export function formatValue(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

/** Whether `values` can still make 24 with + - * /. Brute force; at most four numbers. */
export function canReach24(values: number[]): boolean {
  if (values.length === 1) return Math.abs(values[0]! - TARGET) < EPSILON;
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values.length; j++) {
      if (i === j) continue;
      const rest = values.filter((_, index) => index !== i && index !== j);
      const [a, b] = [values[i]!, values[j]!];
      const results = [a + b, a - b, a * b, ...(Math.abs(b) > EPSILON ? [a / b] : [])];
      if (results.some((result) => canReach24([...rest, result]))) return true;
    }
  }
  return false;
}

const beamEntrySchema = z.object({
  /** The steps taken so far, e.g. "10 - 4 = 6; 13 - 9 = 4". */
  expression: z.string(),
  remaining: z.array(z.number()),
  /** Parallel to `remaining`: the expression each number came from. */
  terms: z.array(z.string()),
});
type BeamEntry = z.infer<typeof beamEntrySchema>;

const scoredSchema = beamEntrySchema.extend({ score: z.number() });
type Scored = z.infer<typeof scoredSchema>;

const proposalSchema = z.object({ parent: z.number(), operation: z.string() });
type Proposal = z.infer<typeof proposalSchema>;

const rejectionSchema = z.object({ depth: z.number(), operation: z.string(), reason: z.string() });

const STEP = /^\s*(-?\d+(?:\.\d+)?)\s*([-+*/x×÷])\s*(-?\d+(?:\.\d+)?)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/;

/** Removes one number close to `value` from the pool; `null` if it is not there. */
function takeFrom(
  pool: number[],
  terms: string[],
  value: number,
): { pool: number[]; terms: string[]; term: string; value: number } | null {
  const index = pool.findIndex((candidate) => Math.abs(candidate - value) < TOLERANCE);
  if (index === -1) return null;
  return {
    pool: pool.filter((_, position) => position !== index),
    terms: terms.filter((_, position) => position !== index),
    term: terms[index]!,
    value: pool[index]!,
  };
}

/** Applies one proposed step to a beam entry, or says why it is illegal. */
export function applyStep(
  entry: BeamEntry,
  operation: string,
): { entry: BeamEntry } | { reason: string } {
  const match = STEP.exec(operation);
  if (!match) return { reason: "not of the form 'a op b = c'" };
  const operator =
    ({ x: "*", "×": "*", "÷": "/" } as Record<string, string>)[match[2]!] ?? match[2]!;
  const pool = `[${entry.remaining.map(formatValue).join(", ")}]`;
  const first = takeFrom(entry.remaining, entry.terms, Number(match[1]));
  if (!first) return { reason: `${match[1]} is not in the remaining numbers ${pool}` };
  const second = takeFrom(first.pool, first.terms, Number(match[3]));
  if (!second) {
    return {
      reason: `${match[3]} is not in the remaining numbers ${pool} (after using ${match[1]})`,
    };
  }
  const [a, b] = [first.value, second.value];
  if (operator === "/" && Math.abs(b) < EPSILON) return { reason: "division by zero" };
  const actual =
    operator === "+" ? a + b : operator === "-" ? a - b : operator === "*" ? a * b : a / b;
  if (Math.abs(actual - Number(match[4])) > TOLERANCE) {
    return {
      reason: `wrong arithmetic: ${match[1]} ${operator} ${match[3]} = ${formatValue(actual)}`,
    };
  }
  const step = `${formatValue(a)} ${operator} ${formatValue(b)} = ${formatValue(actual)}`;
  return {
    entry: {
      expression: entry.expression ? `${entry.expression}; ${step}` : step,
      remaining: [...second.pool, actual],
      terms: [...second.terms, `(${first.term} ${operator} ${second.term})`],
    },
  };
}

/**
 * score: referee every proposal against its parent line, then score the
 * legal ones. Pure and deterministic — no model involved.
 */
export const scoreSteps = createAsyncLogic<
  { candidates: Scored[]; rejected: Array<{ operation: string; reason: string }> },
  { beam: BeamEntry[]; proposals: Proposal[] }
>({
  run: async ({ input }) => {
    const candidates: Scored[] = [];
    const rejected: Array<{ operation: string; reason: string }> = [];
    for (const proposal of input.proposals) {
      const parent = input.beam[proposal.parent];
      const applied = parent
        ? applyStep(parent, proposal.operation)
        : { reason: "unknown parent line" };
      if ("reason" in applied) {
        rejected.push({ operation: proposal.operation, reason: applied.reason });
      } else {
        candidates.push({ ...applied.entry, score: canReach24(applied.entry.remaining) ? 1 : 0 });
      }
    }
    return { candidates, rejected };
  },
});

/** A candidate whose only remaining number is 24, as a full equation. */
function solutionOf(candidates: Scored[]): string | null {
  const solved = candidates.find(
    (candidate) =>
      candidate.remaining.length === 1 && Math.abs(candidate.remaining[0]! - TARGET) < EPSILON,
  );
  return solved ? `${solved.terms[0]!.replace(/^\((.*)\)$/, "$1")} = ${TARGET}` : null;
}

/** Top `BEAM_SIZE` by score; ties keep proposal order. */
function prune(candidates: Scored[]): BeamEntry[] {
  return [...candidates]
    .sort((left, right) => right.score - left.score)
    .slice(0, BEAM_SIZE)
    .map(({ expression, remaining, terms }) => ({ expression, remaining, terms }));
}

/** The deepest line still standing: this depth's best candidate, else the beam's. */
function bestLine(context: { candidates: Scored[]; beam: BeamEntry[] }): string {
  return (prune(context.candidates)[0] ?? context.beam[0])?.expression ?? "";
}

const contextSchema = z.object({
  numbers: z.array(z.number()),
  beam: z.array(beamEntrySchema),
  /** Which beam entry `expanding` asks about next. */
  beamIndex: z.number(),
  /** This depth's proposals, tagged with the beam entry they extend. */
  proposals: z.array(proposalSchema),
  /** This depth's legal, scored candidates, before pruning. */
  candidates: z.array(scoredSchema),
  depth: z.number(),
  candidatesConsidered: z.number(),
  rejected: z.array(rejectionSchema),
  solution: z.string().nullable(),
  failure: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ numbers: z.array(z.number().int().min(1).max(13)).length(4) }),
  output: z.object({
    notice: z.string(),
    solution: z.string().nullable(),
    depth: z.number(),
    candidatesConsidered: z.number(),
    rejectedSteps: z.array(z.string()),
  }),
  actors: { scoreSteps },
  requests: {
    // expand: next steps for ONE partial solution.
    propose: {
      schemas: {
        input: z.object({
          numbers: z.array(z.number()),
          steps: z.string(),
          remaining: z.array(z.number()),
        }),
        output: z.object({
          candidates: z
            .array(z.object({ operation: z.string() }))
            .min(1)
            .max(MAX_PROPOSALS),
        }),
      },
      model: "proposer",
      system:
        "You are playing the Game of 24: combine the numbers with + - * / to make exactly 24, " +
        "using each number once. Propose promising next steps. Each step combines TWO of the " +
        "remaining numbers and is written exactly as 'a op b = c', for example '10 - 4 = 6'. " +
        `Propose at most ${MAX_PROPOSALS} different steps.`,
      prompt: ({ input }) =>
        [
          `Puzzle: ${input.numbers.join(", ")}`,
          `Steps so far: ${input.steps || "(none)"}`,
          `Remaining numbers: ${input.remaining.map(formatValue).join(", ")}`,
        ].join("\n"),
    },
  },
});

export const treeOfThoughtsSchemas = agentSetup.schemas;

export const treeOfThoughtsMachine = agentSetup.createMachine({
  id: "tree-of-thoughts",
  context: ({ input }) => ({
    numbers: input.numbers,
    beam: [{ expression: "", remaining: input.numbers, terms: input.numbers.map(String) }],
    beamIndex: 0,
    proposals: [],
    candidates: [],
    depth: 0,
    candidatesConsidered: 0,
    rejected: [],
    solution: null,
    failure: null,
  }),
  initial: "expanding",
  states: {
    // expand: one proposal request for the beam entry at `beamIndex`.
    expanding: {
      invoke: {
        src: "propose",
        input: ({ context }) => ({
          numbers: context.numbers,
          steps: context.beam[context.beamIndex]?.expression ?? "",
          remaining: context.beam[context.beamIndex]?.remaining ?? [],
        }),
        onDone: ({ context, output }) => ({
          target: "expanded",
          context: {
            proposals: [
              ...context.proposals,
              ...output.result.candidates.map((candidate) => ({
                parent: context.beamIndex,
                operation: candidate.operation,
              })),
            ],
            beamIndex: context.beamIndex + 1,
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `propose failed: ${String(event.error)}` },
        }),
      },
    },
    // Next beam entry, or score the whole depth. Bounded by the beam, which
    // pruning caps at BEAM_SIZE.
    expanded: {
      type: "choice",
      choice: ({ context }) =>
        context.beamIndex < Math.min(context.beam.length, BEAM_SIZE)
          ? { target: "expanding" }
          : { target: "scoring" },
    },
    // score: the machine referees every proposal.
    scoring: {
      invoke: {
        src: "scoreSteps",
        input: ({ context }) => ({ beam: context.beam, proposals: context.proposals }),
        onDone: ({ context, output }) => ({
          target: "pruning",
          context: {
            candidates: output.candidates,
            depth: context.depth + 1,
            candidatesConsidered: context.candidatesConsidered + context.proposals.length,
            rejected: [
              ...context.rejected,
              ...output.rejected.map((rejection) => ({ ...rejection, depth: context.depth + 1 })),
            ],
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `scoring failed: ${String(event.error)}` },
        }),
      },
    },
    // prune + should_terminate.
    pruning: {
      type: "choice",
      choice: ({ context }) =>
        solutionOf(context.candidates) !== null
          ? { target: "done", context: { solution: solutionOf(context.candidates) } }
          : context.candidates.length === 0
            ? {
                target: "failed",
                context: { failure: `every proposed step at depth ${context.depth} was illegal` },
              }
            : context.depth >= MAX_DEPTH
              ? {
                  target: "failed",
                  context: { failure: `no line reached 24 within ${MAX_DEPTH} steps` },
                }
              : {
                  target: "expanding",
                  context: { beam: prune(context.candidates), beamIndex: 0, proposals: [] },
                },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        notice: `Solved ${context.numbers.join(", ")}: ${context.solution ?? ""}`,
        solution: context.solution,
        depth: context.depth,
        candidatesConsidered: context.candidatesConsidered,
        rejectedSteps: context.rejected.map(
          (rejection) => `depth ${rejection.depth}: "${rejection.operation}" — ${rejection.reason}`,
        ),
      }),
    },
    // No solution: the reason, and the best line still standing.
    failed: {
      type: "final",
      output: ({ context }) => ({
        notice:
          `No solution for ${context.numbers.join(", ")}: ${context.failure ?? "unknown failure"}.` +
          (bestLine(context) ? ` Best line: ${bestLine(context)}.` : ""),
        solution: null,
        depth: context.depth,
        candidatesConsidered: context.candidatesConsidered,
        rejectedSteps: context.rejected.map(
          (rejection) => `depth ${rejection.depth}: "${rejection.operation}" — ${rejection.reason}`,
        ),
      }),
    },
  },
});

export interface RunTreeOfThoughtsOptions {
  numbers?: number[];
  /** Injected for tests; the direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export interface TreeOfThoughtsResult {
  notice: string;
  solution: string | null;
  depth: number;
  candidatesConsidered: number;
  rejectedSteps: string[];
  /** Every state the run settled in; the last one is `done` or `failed`. */
  progress: string[];
}

/** Runs the beam search and records its state progress. */
export async function runTreeOfThoughtsExample(
  options: RunTreeOfThoughtsOptions = {},
): Promise<TreeOfThoughtsResult> {
  const { numbers = [4, 9, 10, 13], generateText, onProgress } = options;

  const progress: string[] = [];
  const result = await runAgent(treeOfThoughtsMachine, {
    input: { numbers },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Tree-of-thoughts example did not complete: ${result.status}`);
  }
  return { ...result.output, progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runTreeOfThoughtsExample({
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n${result.notice}`);
    console.log(
      `Depth ${result.depth}, ${result.candidatesConsidered} candidate step(s) considered.`,
    );
    if (result.rejectedSteps.length) console.log(`Rejected:\n${result.rejectedSteps.join("\n")}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
