/**
 * Sketch against TanStack AI's chat interface — the real `@tanstack/ai`
 * package is not a dependency of this repo (it isn't installed here), so
 * this file typechecks against a small local `TanStackChat` interface
 * shaped after TanStack AI's chat call instead of the real package's types.
 * Treat this as an honest sketch, not a verified integration.
 *
 * Install the real peer SDKs in an app:
 *   pnpm add @tanstack/ai @tanstack/ai-openai
 *
 * Then run with an OpenAI-compatible TanStack adapter and swap this file's
 * `TanStackChat` type for the real one exported by `@tanstack/ai`.
 *
 * Drives the triage workflow (text-only: structured-output classification,
 * no decisions) since TanStack AI's chat call shape maps naturally onto a
 * single request/response, not the tool-forced-choice decision recipe used
 * by `../openai-sdk-host/index.ts` / `../anthropic-sdk-host/index.ts`.
 */
import {
  initialAgentStep,
  resolveAgentStep,
  type AgentRequest,
} from '../../src/index.js';
import { triageActors, triageMachine, triageSchemas } from '../triage/index.js';

type TanStackChat = (options: {
  adapter: unknown;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools?: unknown[];
  outputSchema?: unknown;
  stream?: false;
}) => Promise<unknown>;

async function runTanStackRequest(args: {
  chat: TanStackChat;
  adapter: unknown;
  request: AgentRequest;
}) {
  return args.chat({
    adapter: args.adapter,
    stream: false,
    messages: [
      ...(args.request.input.system
        ? [{ role: 'system' as const, content: args.request.input.system }]
        : []),
      { role: 'user', content: args.request.input.prompt ?? '' },
    ],
    outputSchema: args.request.input.outputSchema,
  });
}

export async function runTanStackTriageDemo(args: {
  chat: TanStackChat;
  adapter: unknown;
  ticket: string;
}) {
  let step = initialAgentStep(triageMachine, { ticket: args.ticket }, {
    schemas: triageSchemas,
    actorSources: triageActors,
  });

  while (!step.done) {
    const [request] = step.requests;
    if (!request) {
      throw new Error('Machine is waiting without an agent request.');
    }
    if (request.kind !== 'text') {
      throw new Error('Decision requests are not supported in this demo.');
    }

    const output = await runTanStackRequest({
      chat: args.chat,
      adapter: args.adapter,
      request,
    });

    step = resolveAgentStep(triageMachine, step, request, output, {
      schemas: triageSchemas,
      actorSources: triageActors,
    });
  }

  return step.snapshot.output;
}
