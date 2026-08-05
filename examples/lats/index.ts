/**
 * Language Agent Tree Search (LATS) — repeatedly select a promising leaf,
 * expand several candidate answers, evaluate them, and stop on a solved answer
 * or a bounded tree depth.
 *
 * This keeps LangGraph's selection/expansion/reflection topology while batching
 * sibling generation and evaluation into two typed requests per rollout.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/lats/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const treeNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  response: z.string(),
  depth: z.number(),
  score: z.number(),
  visits: z.number(),
  solved: z.boolean(),
});

type TreeNode = z.infer<typeof treeNodeSchema>;

/** Search bounds. Hardcoded so the machine input is just the problem statement. */
const DEFAULT_MAX_ROLLOUTS = 4;
const DEFAULT_MAX_DEPTH = 3;

export const models = defineModels({
  generator: openai("gpt-5.4-mini"),
  evaluator: openai("gpt-5.4-mini"),
});

function selectLeaf(nodes: TreeNode[], maxDepth: number): TreeNode {
  const parents = new Set(nodes.map(({ parentId }) => parentId).filter(Boolean));
  const leaves = nodes.filter((node) => !parents.has(node.id) && node.depth < maxDepth);
  const candidates = leaves.length > 0 ? leaves : nodes;
  const totalVisits = nodes.reduce((sum, node) => sum + node.visits, 0);
  return candidates.reduce((best, node) => {
    const ucb = node.score + Math.sqrt((2 * Math.log(totalVisits + 2)) / (node.visits + 1));
    const bestUcb = best.score + Math.sqrt((2 * Math.log(totalVisits + 2)) / (best.visits + 1));
    return ucb > bestUcb ? node : best;
  });
}

const setup = setupAgent({
  models,
  context: z.object({
    problem: z.string(),
    nodes: z.array(treeNodeSchema),
    selectedId: z.string(),
    candidates: z.array(z.string()),
    rollout: z.number(),
    maxRollouts: z.number(),
    maxDepth: z.number(),
  }),
  input: z.object({
    problem: z.string(),
  }),
  output: z.object({
    answer: z.string(),
    score: z.number(),
    solved: z.boolean(),
    nodes: z.array(treeNodeSchema),
  }),
  requests: {
    expand: {
      schemas: {
        input: z.object({ problem: z.string(), parent: z.string() }),
        output: z.object({ candidates: z.array(z.string()).min(2).max(5) }),
      },
      model: "generator",
      system:
        "Generate 2 to 5 distinct candidate next answers. Improve on the parent while exploring meaningfully different approaches.",
      prompt: ({ input }) => `Problem: ${input.problem}\nParent attempt: ${input.parent}`,
    },
    evaluate: {
      schemas: {
        input: z.object({ problem: z.string(), candidates: z.array(z.string()) }),
        output: z.object({
          evaluations: z.array(
            z.object({
              score: z.number().min(0).max(1),
              solved: z.boolean(),
              critique: z.string(),
            }),
          ),
        }),
      },
      model: "evaluator",
      system:
        "Evaluate each candidate in order. Score correctness from 0 to 1 and mark solved only for a complete answer.",
      prompt: ({ input }) =>
        `Problem: ${input.problem}\nCandidates:\n${JSON.stringify(input.candidates)}`,
    },
  },
});

export const latsMachine = setup.createMachine({
  id: "lats",
  context: ({ input }) => ({
    problem: input.problem,
    nodes: [
      { id: "root", parentId: null, response: "", depth: 0, score: 0, visits: 0, solved: false },
    ],
    selectedId: "root",
    candidates: [],
    rollout: 0,
    maxRollouts: DEFAULT_MAX_ROLLOUTS,
    maxDepth: DEFAULT_MAX_DEPTH,
  }),
  output: ({ context }) => {
    const best = context.nodes.reduce((left, right) => {
      if (right.solved !== left.solved) return right.solved ? right : left;
      if (right.score !== left.score) return right.score > left.score ? right : left;
      return right.depth > left.depth ? right : left;
    });
    return { answer: best.response, score: best.score, solved: best.solved, nodes: context.nodes };
  },
  initial: "selecting",
  states: {
    selecting: {
      always: ({ context }) => {
        const solved = context.nodes.find((node) => node.solved);
        if (solved || context.rollout >= context.maxRollouts) return { target: "done" };
        const selected = selectLeaf(context.nodes, context.maxDepth);
        if (selected.depth >= context.maxDepth) return { target: "done" };
        return {
          target: "expanding",
          context: { selectedId: selected.id },
        };
      },
    },
    expanding: {
      invoke: {
        src: "expand",
        input: ({ context }) => ({
          problem: context.problem,
          parent: context.nodes.find(({ id }) => id === context.selectedId)?.response ?? "",
        }),
        onDone: ({ output }) => ({
          target: "evaluating",
          context: { candidates: output.candidates },
        }),
      },
    },
    evaluating: {
      invoke: {
        src: "evaluate",
        input: ({ context }) => ({ problem: context.problem, candidates: context.candidates }),
        onDone: ({ output, context }) => {
          const parent = context.nodes.find(({ id }) => id === context.selectedId)!;
          const children = context.candidates.map((response, index): TreeNode => {
            const evaluation = output.evaluations[index] ?? {
              score: 0,
              solved: false,
              critique: "Missing evaluation",
            };
            return {
              id: `${context.rollout + 1}-${index}`,
              parentId: parent.id,
              response: `${response}\n\nReflection: ${evaluation.critique}`,
              depth: parent.depth + 1,
              score: evaluation.score,
              visits: 0,
              solved: evaluation.solved,
            };
          });
          const bestScore = children.reduce((best, child) => Math.max(best, child.score), 0);
          const ancestorIds = new Set<string>();
          let ancestor: TreeNode | undefined = parent;
          while (ancestor) {
            ancestorIds.add(ancestor.id);
            ancestor = ancestor.parentId
              ? context.nodes.find(({ id }) => id === ancestor?.parentId)
              : undefined;
          }
          const backpropagated = context.nodes.map((node) =>
            ancestorIds.has(node.id)
              ? {
                  ...node,
                  score: (node.score * node.visits + bestScore) / (node.visits + 1),
                  visits: node.visits + 1,
                }
              : node,
          );
          return {
            target: "selecting",
            context: {
              nodes: [...backpropagated, ...children],
              rollout: context.rollout + 1,
              candidates: [],
            },
          };
        },
      },
    },
    done: { type: "final" },
  },
});

export interface RunLatsOptions {
  problem?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export async function runLatsExample(options: RunLatsOptions = {}) {
  const {
    problem = "Design a safe retry policy for a payment workflow.",
    generateText,
    onProgress,
  } = options;
  const result = await runAgent(latsMachine, {
    input: { problem },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(onProgress ? { onTransition: (snapshot) => onProgress(String(snapshot.value)) } : {}),
  });
  if (result.status !== "done") throw new Error(`LATS did not complete: ${result.status}`);
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runLatsExample().then(console.log);
}
