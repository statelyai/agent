/**
 * Machines as data — a support-ticket workflow authored entirely as JSON.
 *
 * `workflow.json` in this directory is a real `.json` file, validated by
 * `schemas/agent-workflow.json` — the kind of thing a database, a visual
 * editor, or an LLM could produce. `setupAgent.fromConfig(...)` lowers it to
 * the same XState machine `setupAgent(...)` (TS authoring) would build, and
 * `runAgent(...)` runs it exactly like any other agent machine:
 *
 *   - `agent.decide` (triaging): the model chooses ESCALATE or REPLY. JSON
 *     cannot express a function, so the lowering delivers the chosen event
 *     automatically (equivalent to `onDone: sendDecision()` in TS authoring)
 *     — only `onError` is configurable from the config.
 *   - `draftReply` (drafting): a plain text request, same as any
 *     `setupAgent({ requests: {...} })` request.
 *   - `awaitingApproval`: an idle state — no invoke, nothing left to do
 *     until a human sends APPROVE/REJECT. `runAgent` settles
 *     `{ status: 'idle', snapshot }`; the host persists that snapshot and
 *     resumes with `runAgent(machine, { snapshot, event, ...executors })`.
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/json-agent/index.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type LanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { runAgent, setupAgent, type AgentWorkflowConfig } from '../../src/index.js';
import { createAiSdkExecutors } from '../../src/ai-sdk/index.js';

const workflowPath = fileURLToPath(new URL('./workflow.json', import.meta.url));
export const workflowConfig: AgentWorkflowConfig = JSON.parse(
  readFileSync(workflowPath, 'utf-8')
);

export const jsonAgentMachine = setupAgent.fromConfig(workflowConfig);

function resolveModel(modelRef: string): LanguageModel {
  return openai(modelRef.replace(/^openai\//, ''));
}

export async function runJsonAgentDemo(ticket: string) {
  const { generateText, decide } = createAiSdkExecutors({ resolveModel });

  let result = await runAgent(jsonAgentMachine, {
    input: { ticket },
    generateText,
    decide,
  });

  if (result.status === 'idle') {
    // A human approves the drafted reply — in a real host this is a
    // separate request/process; here we simulate immediate approval.
    result = await runAgent(jsonAgentMachine, {
      snapshot: result.snapshot,
      event: { type: 'APPROVE' },
      generateText,
      decide,
    });
  }

  if (result.status !== 'done') {
    throw new Error(`JSON agent demo did not complete: ${result.status}`);
  }

  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runJsonAgentDemo('My invoice total looks wrong, please help.'));
}
