/**
 * Hierarchical agent teams — LLM supervisors that dynamically route among
 * workers and loop, at two levels of a hierarchy.
 *
 * Ported from LangGraph's hierarchical-agent-teams tutorial. Its defining
 * feature is supervisors: a node that, each turn, decides which worker runs
 * next (or that the team is done), looping until satisfied — NOT a fixed
 * pipeline. Here every supervisor is an inline `agent.decide` state:
 *
 *   coordinator: researching → writing → reviewing ─┬─ REVISE → researching
 *                                                    └─ PUBLISH → done
 *   research team (supervising): ─┬─ SEARCH → searching → supervising
 *                                 ├─ SCRAPE → scraping  → supervising
 *                                 └─ FINISH → done
 *
 * What maps to what:
 *   - research supervisor  → `supervising` (`agent.decide` over SEARCH/SCRAPE/FINISH)
 *   - search / web-scraper → `searching` / `scraping` (model requests, stand-ins for tools)
 *   - team boundary        → the child machine's typed input/output
 *   - top coordinator      → invokes the two team machines, then a `reviewing`
 *                            supervisor that can send one round back to research
 *
 * Bounded by construction: the research team carries a worker-step `budget`;
 * when it hits zero the SEARCH/SCRAPE guards return `undefined`, so only FINISH
 * is legal and the loop must end. The coordinator carries `revisionsRemaining`,
 * capping REVISE at one round. A supervisor that never makes a legal choice
 * (retries exhausted) routes via `onError` to a clean finish.
 *
 * The web/file tools are represented by model requests; the hierarchy and the
 * routing loops are real child actors and real decisions.
 *
 * Each team returns a `log` of one-line worker results alongside its output, and
 * the coordinator folds those into a compact `teamReport` tree (team, worker,
 * result) as the teams finish. That tree, not the raw research prose, is what
 * the run leads with; the full research and report stay nested under `details`.
 *
 * Dual-mode: `runHierarchicalTeamsExample(options?)` takes injectable
 * `generateText`/`decide` (tests script them — keyless CI); the direct run
 * defaults real executors.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/hierarchical-teams/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

export const models = defineModels({
  supervisor: openai("gpt-5.4-mini"),
  searcher: openai("gpt-5.4-mini"),
  scraper: openai("gpt-5.4-mini"),
  outliner: openai("gpt-5.4-mini"),
  writer: openai("gpt-5.4-mini"),
});

/** Collapses a worker result to one short line for the team tree. */
function oneLine(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function renderResearchPrompt(context: { topic: string; notes: string[]; budget: number }): string {
  return [
    `Research topic: ${context.topic}`,
    `Worker steps remaining: ${context.budget}`,
    "Material gathered so far:",
    context.notes.length
      ? context.notes.map((note, i) => `[${i + 1}] ${note}`).join("\n")
      : "(none yet)",
    context.budget > 0
      ? "Choose SEARCH for more leads, SCRAPE to deepen the notes, or FINISH when the material is sufficient."
      : "The step budget is exhausted. You must FINISH now.",
  ].join("\n");
}

const researchSetup = setupAgent({
  models,
  context: z.object({
    topic: z.string(),
    notes: z.array(z.string()),
    // One line per worker step, handed up to the coordinator's team tree.
    log: z.array(z.string()),
    budget: z.number(),
  }),
  input: z.object({ topic: z.string(), priorNotes: z.array(z.string()).default([]) }),
  output: z.object({ research: z.string(), log: z.array(z.string()) }),
  events: {
    SEARCH: z.object({}),
    SCRAPE: z.object({}),
    FINISH: z.object({}),
  },
  requests: {
    search: {
      schemas: {
        input: z.object({ topic: z.string(), notes: z.array(z.string()) }),
        output: z.string(),
      },
      model: "searcher",
      system:
        "Find relevant source leads. Reply with at most two short leads on one " +
        "line each. Avoid repeating material already gathered.",
      prompt: ({ input }) =>
        `Topic: ${input.topic}\nAlready gathered:\n${input.notes.join("\n") || "(nothing yet)"}`,
    },
    scrape: {
      schemas: {
        input: z.object({ topic: z.string(), notes: z.array(z.string()) }),
        output: z.string(),
      },
      model: "scraper",
      system:
        "Turn source leads into factual research notes: at most two short " +
        "sentences. Preserve uncertainty.",
      prompt: ({ input }) =>
        `Topic: ${input.topic}\nLeads and notes so far:\n${input.notes.join("\n") || "(none)"}`,
    },
  },
});

export const researchTeamMachine = researchSetup.createMachine({
  id: "research-team",
  context: ({ input }) => ({
    topic: input.topic,
    notes: [...input.priorNotes],
    log: [],
    budget: 2,
  }),
  output: ({ context }) => ({ research: context.notes.join("\n"), log: context.log }),
  initial: "supervising",
  states: {
    // The research supervisor: each turn it routes to a worker or stops. The
    // budget guards make SEARCH/SCRAPE illegal once exhausted, so FINISH is the
    // only legal choice and the loop is bounded.
    supervising: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "supervisor",
          system:
            "You supervise a research team. Route work to a SEARCH worker (find " +
            "source leads) or a SCRAPE worker (turn leads into notes). Choose " +
            "FINISH once the gathered material is sufficient.",
          prompt: renderResearchPrompt(context),
          allowedEvents: ["SEARCH", "SCRAPE", "FINISH"],
          maxRetries: 2,
        }),
        onError: { target: "done" },
      },
      on: {
        SEARCH: ({ context }) => (context.budget > 0 ? { target: "searching" } : undefined),
        SCRAPE: ({ context }) => (context.budget > 0 ? { target: "scraping" } : undefined),
        FINISH: { target: "done" },
      },
    },
    searching: {
      invoke: {
        src: "search",
        input: ({ context }) => ({ topic: context.topic, notes: context.notes }),
        onDone: ({ context, output }) => ({
          target: "supervising",
          context: {
            notes: [...context.notes, output],
            log: [...context.log, `search. done. ${oneLine(output)}`],
            budget: context.budget - 1,
          },
        }),
        onError: ({ context }) => ({
          target: "supervising",
          context: { log: [...context.log, "search. failed"], budget: context.budget - 1 },
        }),
      },
    },
    scraping: {
      invoke: {
        src: "scrape",
        input: ({ context }) => ({ topic: context.topic, notes: context.notes }),
        onDone: ({ context, output }) => ({
          target: "supervising",
          context: {
            notes: [...context.notes, output],
            log: [...context.log, `scrape. done. ${oneLine(output)}`],
            budget: context.budget - 1,
          },
        }),
        onError: ({ context }) => ({
          target: "supervising",
          context: { log: [...context.log, "scrape. failed"], budget: context.budget - 1 },
        }),
      },
    },
    done: { type: "final" },
  },
});

const writingSetup = setupAgent({
  models,
  context: z.object({
    research: z.string(),
    outline: z.string().nullable(),
    report: z.string().nullable(),
    log: z.array(z.string()),
  }),
  input: z.object({ research: z.string() }),
  output: z.object({ report: z.string(), log: z.array(z.string()) }),
  requests: {
    outline: {
      schemas: { input: z.object({ research: z.string() }), output: z.string() },
      model: "outliner",
      system: "Create a report outline from the research notes: at most three short bullets.",
      prompt: ({ input }) => `Research:\n${input.research || "(none gathered)"}`,
    },
    write: {
      schemas: {
        input: z.object({ research: z.string(), outline: z.string() }),
        output: z.string(),
      },
      model: "writer",
      system: "Write a report of at most four sentences. Use only the research notes.",
      prompt: ({ input }) => `Outline:\n${input.outline}\n\nResearch:\n${input.research}`,
    },
  },
});

export const writingTeamMachine = writingSetup.createMachine({
  id: "writing-team",
  context: ({ input }) => ({ research: input.research, outline: null, report: null, log: [] }),
  output: ({ context }) => ({ report: context.report ?? "", log: context.log }),
  initial: "outlining",
  states: {
    outlining: {
      invoke: {
        src: "outline",
        input: ({ context }) => ({ research: context.research }),
        onDone: ({ context, output }) => ({
          target: "writing",
          context: { outline: output, log: [...context.log, `outline. done. ${oneLine(output)}`] },
        }),
      },
    },
    writing: {
      invoke: {
        src: "write",
        input: ({ context }) => ({ research: context.research, outline: context.outline ?? "" }),
        onDone: ({ context, output }) => ({
          target: "done",
          context: { report: output, log: [...context.log, `write. done. ${oneLine(output)}`] },
        }),
      },
    },
    done: { type: "final" },
  },
});

/** Adds a team block to the tree: the team name, then its indented worker lines. */
function appendTeam(tree: string, team: string, log: string[]): string {
  const lines = log.length > 0 ? log : ["(no worker steps)"];
  return `${tree}${team}\n${lines.map((line) => `  ${line}`).join("\n")}\n`;
}

function renderReviewPrompt(context: {
  research: string;
  report: string;
  revisionsRemaining: number;
}): string {
  return [
    "Decide whether the draft report is well-supported by the research.",
    `Research notes:\n${context.research}`,
    `Draft report:\n${context.report}`,
    context.revisionsRemaining > 0
      ? "Choose REVISE to send it back to the research team for more material, or PUBLISH to accept it."
      : "No revisions remain. You must PUBLISH.",
  ].join("\n");
}

const coordinatorSetup = setupAgent({
  models,
  context: z.object({
    topic: z.string(),
    research: z.string().nullable(),
    report: z.string().nullable(),
    // The team tree, one line per team and per worker, grown as teams finish.
    teamReport: z.string(),
    revisionsRemaining: z.number(),
  }),
  input: z.object({ topic: z.string() }),
  // One leading string (the tree, with the report under it); the raw research
  // and report stay nested so neither becomes the lead.
  output: z.object({
    teamReport: z.string(),
    details: z.object({ research: z.string(), report: z.string() }),
  }),
  events: {
    REVISE: z.object({}),
    PUBLISH: z.object({}),
  },
  actors: { researchTeam: researchTeamMachine, writingTeam: writingTeamMachine },
});

export const hierarchicalTeamsMachine = coordinatorSetup.createMachine({
  id: "hierarchical-teams",
  context: ({ input }) => ({
    topic: input.topic,
    research: null,
    report: null,
    teamReport: "",
    revisionsRemaining: 1,
  }),
  output: ({ context }) => ({
    teamReport: [context.teamReport.trimEnd(), "", "Report", context.report || "(none)"].join("\n"),
    details: { research: context.research ?? "", report: context.report ?? "" },
  }),
  initial: "researching",
  states: {
    researching: {
      invoke: {
        id: "researchTeam",
        src: "researchTeam",
        input: ({ context }) => ({
          topic: context.topic,
          priorNotes: context.research ? [context.research] : [],
        }),
        onDone: ({ context, output }) => ({
          target: "writing",
          context: {
            research: output.research,
            teamReport: appendTeam(
              context.teamReport,
              context.revisionsRemaining === 0 ? "research team (revision)" : "research team",
              output.log,
            ),
          },
        }),
      },
    },
    writing: {
      invoke: {
        id: "writingTeam",
        src: "writingTeam",
        input: ({ context }) => ({ research: context.research ?? "" }),
        onDone: ({ context, output }) => ({
          target: "reviewing",
          context: {
            report: output.report,
            teamReport: appendTeam(context.teamReport, "writing team", output.log),
          },
        }),
      },
    },
    // The top-level supervisor: accept the report, or send one round back to
    // the research team for more material. `revisionsRemaining` bounds REVISE.
    reviewing: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "supervisor",
          system: "You are the coordinator over a research team and a writing team.",
          prompt: renderReviewPrompt({
            research: context.research ?? "",
            report: context.report ?? "",
            revisionsRemaining: context.revisionsRemaining,
          }),
          allowedEvents: ["REVISE", "PUBLISH"],
          maxRetries: 2,
        }),
        onError: { target: "done" },
      },
      on: {
        REVISE: ({ context }) =>
          context.revisionsRemaining > 0
            ? {
                target: "researching",
                context: {
                  revisionsRemaining: context.revisionsRemaining - 1,
                  teamReport: `${context.teamReport}coordinator. revise\n`,
                },
              }
            : undefined,
        PUBLISH: ({ context }) => ({
          target: "done",
          context: { teamReport: `${context.teamReport}coordinator. publish\n` },
        }),
      },
    },
    done: { type: "final" },
  },
});

export interface RunHierarchicalTeamsOptions {
  topic?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Injected for tests; drives the supervisor routing decisions. */
  decide?: AgentRequestExecutors["decide"];
  /** Observes each coordinator-level transition. */
  onProgress?: (state: string) => void;
}

/** Runs the hierarchy; real executors default, overrides merge on top. */
export async function runHierarchicalTeamsExample(options: RunHierarchicalTeamsOptions = {}) {
  const {
    topic = "One reason explicit state makes AI agents easier to debug",
    generateText,
    decide,
    onProgress,
  } = options;

  const result = await runAgent(hierarchicalTeamsMachine, {
    input: { topic },
    executors: {
      ...createAiSdkExecutors({ models }),
      ...(generateText ? { generateText } : {}),
      ...(decide ? { decide } : {}),
    },
    ...(onProgress ? { onTransition: (snapshot) => onProgress(String(snapshot.value)) } : {}),
  });

  if (result.status !== "done") {
    throw new Error(`Hierarchical teams did not complete: ${result.status}`);
  }
  return result.output;
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runHierarchicalTeamsExample({ onProgress: (state) => console.log(`  → ${state}`) }).then(
    ({ teamReport }) => console.log("\n" + teamReport),
  );
}
