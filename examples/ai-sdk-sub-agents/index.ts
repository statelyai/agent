/**
 * Vercel AI SDK sub-agents as host-owned tools.
 *
 * The XState machine only sees tools on one request. The host decides those
 * tools delegate to AI SDK ToolLoopAgent workers.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-sub-agents/index.ts
 */
import assert from "node:assert/strict";
import { openai } from "@ai-sdk/openai";
import {
  generateText,
  type GenerateTextResult,
  Output,
  stepCountIs,
  type StreamTextResult,
  ToolLoopAgent,
  type Agent,
  type LanguageModel,
} from "ai";
import { z } from "zod";
import { setupAgent, type AgentTool, type AgentToolExecute, runAgent } from "../../src/index.js";
import { toAiSdkTools, defineModels } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";

const answerSchema = z.object({ answer: z.string() });
const taskInputSchema = z.object({ task: z.string() });

type SubAgentName = "researcher" | "writer";
type SubAgents = Record<SubAgentName, Agent>;

export const models = defineModels({
  supervisor: openai("gpt-5.4-mini"),
});

export function createAiSdkSubAgents(model: LanguageModel): SubAgents {
  return {
    researcher: new ToolLoopAgent({
      id: "researcher",
      model,
      instructions: "Research the topic. Return concise notes.",
      stopWhen: stepCountIs(3),
    }),
    writer: new ToolLoopAgent({
      id: "writer",
      model,
      instructions: "Turn notes into a short final answer.",
      stopWhen: stepCountIs(3),
    }),
  };
}

function createSubAgentExecute(subAgents: SubAgents, name: SubAgentName): AgentToolExecute {
  return async (input) => {
    const prompt = z.object({ prompt: z.string() }).parse(input).prompt;
    const result = await subAgents[name].generate({ prompt });
    return result.text;
  };
}

function executeTool(tool: AgentTool | undefined, input: unknown) {
  return typeof tool === "function" ? tool(input) : tool?.execute?.(input);
}

const subAgentContextSchema = z.object({
  task: z.string(),
  answer: z.string().nullable(),
});

function createAiSdkSubAgentWorkflow(subAgents: SubAgents) {
  const agentSetup = setupAgent({
    models,
    context: subAgentContextSchema,
    input: taskInputSchema,
    output: answerSchema,
    // supervising sets answer before done reads it — narrow it non-null there.
    states: {
      supervising: {},
      done: {
        schemas: { context: subAgentContextSchema.extend({ answer: z.string() }) },
      },
    },
    requests: {
      supervise: {
        schemas: {
          input: taskInputSchema,
          output: answerSchema,
        },
        model: "supervisor",
        system: [
          "You are a supervisor.",
          "Use askResearcher for facts and askWriter for the final wording.",
        ].join(" "),
        prompt: ({ input }) => input.task,
        tools: {
          askResearcher: {
            description: "Ask the researcher sub-agent for notes.",
            inputSchema: z.object({ prompt: z.string() }),
            execute: createSubAgentExecute(subAgents, "researcher"),
          },
          askWriter: {
            description: "Ask the writer sub-agent for final wording.",
            inputSchema: z.object({ prompt: z.string() }),
            execute: createSubAgentExecute(subAgents, "writer"),
          },
        },
      },
    },
  });

  const machine = agentSetup.createMachine({
    id: "ai-sdk-sub-agents",
    context: ({ input }) => ({ task: input.task, answer: null }),
    initial: "supervising",
    states: {
      supervising: {
        invoke: {
          src: "supervise",
          input: ({ context }) => ({ task: context.task }),
          onDone: ({ output }) => ({
            target: "done",
            context: { answer: output.answer },
          }),
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({ answer: context.answer }),
      },
    },
  });

  return {
    agentSetup,
    machine,
  };
}

export async function runAiSdkSubAgentsDemo(task: string) {
  const model = models.supervisor;
  const { machine } = createAiSdkSubAgentWorkflow(createAiSdkSubAgents(model));

  const result = await runAgent(machine, {
    input: { task },
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
    generateText: async (request) => {
      const { output } = await generateText({
        model,
        system: request.system,
        prompt: request.prompt ?? "",
        tools: toAiSdkTools(request.tools ?? {}),
        output: Output.object({ schema: answerSchema }),
        stopWhen: stepCountIs(8),
      });
      return { output };
    },
  });
  if (result.status !== "done") {
    throw new Error(`Sub-agents demo did not complete: ${result.status}`);
  }
  return result.output;
}

export async function runAiSdkSubAgentsDeterministicExample() {
  const calls: string[] = [];
  const fakeSubAgents: SubAgents = {
    researcher: {
      version: "agent-v1",
      id: "researcher",
      tools: {},
      generate: async ({ prompt }) => {
        calls.push(`researcher:${prompt}`);
        return { text: `notes:${prompt}` } as GenerateTextResult<{}, never>;
      },
      stream: async () => ({}) as StreamTextResult<{}, never>,
    },
    writer: {
      version: "agent-v1",
      id: "writer",
      tools: {},
      generate: async ({ prompt }) => {
        calls.push(`writer:${prompt}`);
        return { text: `final:${prompt}` } as GenerateTextResult<{}, never>;
      },
      stream: async () => ({}) as StreamTextResult<{}, never>,
    },
  };
  const { machine } = createAiSdkSubAgentWorkflow(fakeSubAgents);

  const result = await runAgent(machine, {
    input: { task: "compose agent note" },
    generateText: async (request) => {
      const notes = await executeTool(request.tools?.askResearcher, {
        prompt: request.prompt,
      });
      const answer = await executeTool(request.tools?.askWriter, {
        prompt: String(notes),
      });
      return { output: { answer: String(answer) } };
    },
  });

  assert.deepEqual(calls, ["researcher:compose agent note", "writer:notes:compose agent note"]);
  assert.equal(result.status, "done");
  assert.deepEqual(result.status === "done" ? result.output : undefined, {
    answer: "final:notes:compose agent note",
  });
}

runExampleMain(import.meta.url, async () => {
  console.log(await runAiSdkSubAgentsDemo("Explain composable agents."));
});
