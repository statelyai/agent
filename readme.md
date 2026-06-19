# Stately Agent

Stately Agent is the state machine authoring layer for AI agents. Author your AI agents as state machines. Run them anywhere.

The package owns one first-class authoring primitive:

- `setupAgent(...).withTasks(...)`: schema-first, SDK-agnostic agent task authoring.

Use `setupAgent(...)` for schema-first control flow. Use normal host code for runtime execution. Stately Agent adds the batteries: reusable text logic, message helpers, examples, retained schemas, and visualization/export affordances.

You can still call the Vercel AI SDK, LangChain, Workers AI, or any other model/tool runtime yourself. The machine only declares behavior; hosts can either execute effects from pure XState transitions or provide actors with `machine.provide({ actors })`. That keeps runtime transparency while making the workflow typed, inspectable, and visualizable.

Choose this over LangGraph when you want agent workflows to be explicit state machines instead of framework-owned graphs: same workflow shapes, strong TypeScript for machine context/events/actors, first-class XState snapshots/guards, visualization by default, and no required runtime backend. Choose it over handrolled workflows when the control flow is important enough to inspect, persist, replay, test, and diagram.

For SDK integration, define named tasks with `setupAgent({ schemas }).withTasks(...)`. The machine declares `invoke: { src: 'getSummary', input, onDone }`; your host reads that task and calls Vercel AI SDK, Cloudflare Workers AI, LangChain, local models, or custom code. Source ids, invoke input, `event.output`, and machine schemas are typed from the registered tasks and schemas. See [`docs/host-actors.md`](/Users/davidkpiano/Code/agent/docs/host-actors.md).

## Agent Machines

<!-- setupAgent root export and helpers from src/index.ts and src/setup-agent.ts -->

Import `createAgentSchemas(...)` and `setupAgent(...)` from `@statelyai/agent`:

```ts
import {
  createAgentSchemas,
  setupAgent,
} from '@statelyai/agent';
import { assign } from 'xstate';
import { z } from 'zod';

const contextSchema = z.object({
  prompt: z.string(),
  answer: z.string().nullable(),
});
const inputSchema = z.object({ prompt: z.string() });
const answerSchema = z.object({ answer: z.string() });

const schemas = createAgentSchemas({
  context: contextSchema,
  input: inputSchema,
  output: answerSchema,
});

const agent = setupAgent({ schemas }).withTasks({
  getAnswer: {
    schemas: {
      input: z.object({ prompt: z.string() }),
      output: answerSchema,
    },
    model: 'writer',
    prompt: ({ input }) => input.prompt,
  },
});

const machine = agent.createMachine({
  context: ({ input }) => ({ prompt: input.prompt, answer: null }),
  initial: 'answering',
  states: {
    answering: {
      invoke: {
        id: 'answer',
        src: 'getAnswer',
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: {
          target: 'done',
          actions: assign({
            answer: ({ event }) => event.output.answer,
          }),
        },
      },
    },
    done: { type: 'final' },
  },
});

let step = machine.initial({ prompt: 'Why XState?' });

while (!step.done) {
  for (const task of step.tasks) {
    const result = await machine.execute(task, {
      generateText: (request) => generateText(request), // any SDK/framework
      streamText: (request) => streamText(request),
    });
    step = machine.resolve(step, task, result);
  }
}
```

This is normal XState underneath: use `machine.initial(...)`, `machine.transition(...)`, and `machine.resolve(...)` for the blessed step loop; drop down to pure `initialTransition(...)` / `transitionResult(...)`; or use `createActor(...)`, snapshots, persistence, guards, actions, and host-provided actors. `setupAgent(...)` adds schema-derived concrete types and retained schemas; `withTasks(...)` adds reusable typed task construction, strongly typed source names, typed invoke input, typed `event.output`, `step.tasks`, `machine.getTasks(...)`, and `machine.execute(...)`.

When a task declares `events`, `machine.getTasks(...)` returns `event.<TYPE>` tools for those events only if they are currently legal from the snapshot. That lets a model choose legal machine events, such as moves in a game, without exposing every transition.

## Examples

<!-- curated examples and CLI commands from examples/index.ts and package.json#scripts -->

The examples in [`examples/`](/Users/davidkpiano/Code/agent/examples) are intentionally small. Most run in the CLI and use real OpenAI calls when `OPENAI_API_KEY` is set. Runtime-specific examples call out extra environment requirements inline.

If you want examples grouped by intent instead of a flat list, start with [`examples/README.md`](/Users/davidkpiano/Code/agent/examples/README.md). It separates XState authoring, host adapters, app integrations, and parity coverage.

Run them with `node --import tsx examples/<name>.ts`.

Convert a machine file to diagram output with `pnpm agent:convert <file> --format mermaid` or `pnpm agent:convert <file> --format xstate`. Static analysis warnings are printed to stderr. For programmatic access, use `analyzeGraph(...)` from `@statelyai/agent/graph`; warnings are returned explicitly instead of being hidden in graph metadata.

Start here:

- Agent authoring: [`examples/setup-agent/email-drafter.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/email-drafter.ts)
- Host adapters: [`examples/setup-agent/hosts/ai-sdk.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/hosts/ai-sdk.ts), [`examples/setup-agent/hosts/cloudflare-agent.ts`](/Users/davidkpiano/Code/agent/examples/setup-agent/hosts/cloudflare-agent.ts)
- Local smoke test: [`examples/setup-agent/smoke.mts`](/Users/davidkpiano/Code/agent/examples/setup-agent/smoke.mts)
- LangGraph parity: [`src/langgraph-equivalents/raw-xstate.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/raw-xstate.test.ts), [`docs/langgraph-parity.md`](/Users/davidkpiano/Code/agent/docs/langgraph-parity.md), [`docs/langgraph-gaps.md`](/Users/davidkpiano/Code/agent/docs/langgraph-gaps.md)
- Burr parity: [`src/burr-equivalents/raw-xstate.test.ts`](/Users/davidkpiano/Code/agent/src/burr-equivalents/raw-xstate.test.ts), [`docs/burr-parity.md`](/Users/davidkpiano/Code/agent/docs/burr-parity.md)

CrewAI Flow parity is tracked in [`docs/crewai-parity.md`](/Users/davidkpiano/Code/agent/docs/crewai-parity.md), the same way LangGraph parity is tracked separately.

Burr parity is tracked in [`docs/burr-parity.md`](/Users/davidkpiano/Code/agent/docs/burr-parity.md), focused on action-like authoring patterns without adopting Burr's runtime.

## Runtime

Runtime is normal XState. Use the agent step helpers when you want the package to collect tasks for you, pure `initialTransition(...)` / `transitionResult(...)` when a framework wants to own every transition detail, or `createActor(...)`, `toPromise(...)`, snapshots, persisted snapshots, `machine.provide({ actors })`, and your framework transport of choice. Model/tool execution stays under your control.

**Read the documentation: [stately.ai/docs/agents](https://stately.ai/docs/agents)**
