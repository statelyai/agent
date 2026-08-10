/**
 * Language Agent Tree Search (LATS) — repeatedly select a promising leaf,
 * expand several candidate answers, evaluate them, and stop on a solved answer
 * or a bounded tree depth.
 *
 * This keeps LangGraph's selection/expansion/reflection topology while batching
 * sibling generation and evaluation into two typed requests per rollout.
 *
 * The search itself is the interesting part, so the tree is rendered into a
 * `searchTree` context string as the run goes: one indented line per node with
 * its score, the branch the search chose, and the winning leaf. The full node
 * records stay nested under `details`.
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
const DEFAULT_MAX_ROLLOUTS = 2;
const DEFAULT_MAX_DEPTH = 2;

/**
 * Acceptance bar. A candidate counts as solved only when the evaluator marks it
 * solved AND scores it at or above this bar — a confident first draft with a
 * middling score keeps the search going instead of ending it after one
 * expansion (which is what makes the tree search visible at all).
 */
const ACCEPT_SCORE = 0.9;

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

/** The winner: solved beats unsolved, then score, then depth. */
function bestNode(nodes: TreeNode[]): TreeNode {
  return nodes.reduce((left, right) => {
    if (right.solved !== left.solved) return right.solved ? right : left;
    if (right.score !== left.score) return right.score > left.score ? right : left;
    return right.depth > left.depth ? right : left;
  });
}

function oneLine(text: string, max = 56): string {
  const flat = text.split("\n")[0]!.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The search tree as indented text: one line per node with its score, a `chosen`
 * marker on the branch that leads to the winner, and `best` on the winner
 * itself. This is what makes the search visible instead of implied.
 */
function renderTree(nodes: TreeNode[]): string {
  const best = bestNode(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const onPath = new Set<string>();
  for (
    let node: TreeNode | undefined = best;
    node;
    node = node.parentId ? byId.get(node.parentId) : undefined
  ) {
    onPath.add(node.id);
  }
  const children = (parentId: string | null) => nodes.filter((node) => node.parentId === parentId);

  const lines: string[] = [];
  const walk = (parentId: string | null, indent: string) => {
    for (const node of children(parentId)) {
      const marker =
        node.id === best.id
          ? "  <- best"
          : onPath.has(node.id) && node.parentId
            ? "  <- chosen"
            : "";
      const label = node.parentId === null ? "root" : `${node.id} ${oneLine(node.response)}`;
      lines.push(`${indent}${label}  (${node.score.toFixed(2)})${marker}`);
      walk(node.id, `${indent}  `);
    }
  };
  walk(null, "");
  return lines.join("\n");
}

const setup = setupAgent({
  models,
  context: z.object({
    problem: z.string(),
    nodes: z.array(treeNodeSchema),
    // The tree rendered as text, refreshed after every rollout.
    searchTree: z.string(),
    selectedId: z.string(),
    candidates: z.array(z.string()),
    rollout: z.number(),
    maxRollouts: z.number(),
    maxDepth: z.number(),
  }),
  input: z.object({
    problem: z.string(),
  }),
  // The tree (with the winning answer under it) is the one leading string; the
  // node records stay nested so they never lead.
  output: z.object({
    searchTree: z.string(),
    score: z.number(),
    solved: z.boolean(),
    rollouts: z.number(),
    details: z.object({
      answer: z.string(),
      nodes: z.array(treeNodeSchema),
    }),
  }),
  requests: {
    expand: {
      schemas: {
        input: z.object({ problem: z.string(), parent: z.string() }),
        output: z.object({ candidates: z.array(z.string()).min(2).max(3) }),
      },
      model: "generator",
      system:
        "Generate 2 or 3 distinct candidate next answers, each at most two short " +
        "sentences. Improve on the parent while exploring meaningfully different approaches.",
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
        "Evaluate each candidate in order against ALL of these criteria: " +
        "(1) it fully answers the problem as stated; " +
        "(2) it handles the obvious edge cases and failure modes; " +
        "(3) it is specific enough to act on without follow-up questions; " +
        "(4) it contains no factual, logical, or arithmetic errors. " +
        "Score correctness from 0 to 1 and reserve 0.9 or above for a candidate " +
        "that meets every criterion. Mark solved ONLY when you cannot name a " +
        "single concrete improvement — first-round candidates almost never clear " +
        "this bar. If you can name any improvement, solved is false and the " +
        "score is below 0.9. The critique must name that improvement in at most " +
        "twelve words.",
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
    searchTree: "",
    selectedId: "root",
    candidates: [],
    rollout: 0,
    maxRollouts: DEFAULT_MAX_ROLLOUTS,
    maxDepth: DEFAULT_MAX_DEPTH,
  }),
  output: ({ context }) => {
    const best = bestNode(context.nodes);
    return {
      searchTree: [
        `Search tree (${context.rollout} rollout${context.rollout === 1 ? "" : "s"}, ` +
          `${context.nodes.length - 1} candidate${context.nodes.length === 2 ? "" : "s"})`,
        renderTree(context.nodes),
        "",
        `Best answer (${best.score.toFixed(2)}, ${best.solved ? "solved" : "budget reached"})`,
        best.response || "(none)",
      ].join("\n"),
      score: best.score,
      solved: best.solved,
      rollouts: context.rollout,
      details: { answer: best.response, nodes: context.nodes },
    };
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
              // The acceptance bar, enforced in the machine: an evaluator that
              // says "solved" with a middling score does not stop the search.
              solved: evaluation.solved && evaluation.score >= ACCEPT_SCORE,
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
          const nodes = [...backpropagated, ...children];
          return {
            target: "selecting",
            context: {
              nodes,
              // Refresh the text tree every rollout, so the search is legible
              // while it runs and not only at the end.
              searchTree: renderTree(nodes),
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
  void runLatsExample().then((output) => console.log(output.searchTree));
}
