# Stately Agent

Stately Agent is the state machine authoring layer for AI agents. Author your AI agents as state machines. Run them anywhere.

The package owns these first-class authoring surfaces:

- `setupAgent({ requests })`: schema-bound, event-typed model request definitions.
- `createTextLogic(...)`: reusable, schema-typed model-call actors.
- `agent.generateText` / `agent.streamText`: built-in model-call actor sources auto-provided by `setupAgent(...)`.
- `setupAgent.fromConfig(...)`: static workflow config lowered to the same agent machine shape.

Use `setupAgent(...)` for schema-first control flow. Use normal host code for runtime execution. Stately Agent adds the batteries: reusable text logic, message helpers, examples, retained schemas, and visualization/export affordances.

You can still call the Vercel AI SDK, LangChain, Workers AI, or any other model/tool runtime yourself. The machine only declares behavior; hosts can either execute requests from pure XState transitions or provide actors with `machine.provide({ actors })`. That keeps runtime transparency while making the workflow typed, inspectable, and visualizable.

Choose this over LangGraph when you want agent workflows to be explicit state machines instead of framework-owned graphs: same workflow shapes, strong TypeScript for machine context/events/actors, first-class XState snapshots/guards, visualization by default, and no required runtime backend. Choose it over handrolled workflows when the control flow is important enough to inspect, persist, replay, test, and diagram.

For SDK integration, define request configs under `setupAgent({ requests })`, invoke the built-in `agent.generateText` / `agent.streamText` actors directly, or register reusable `createTextLogic(...)` actors. Your host reads returned requests and calls Vercel AI SDK, Cloudflare Workers AI, LangChain, local models, or custom code. Setup-bound requests can be tested standalone with `agent.requests.name.request(input)` and `agent.requests.name.execute(input, executors)`. Reusable text actors can also be tested standalone with `logic.request(input)` and `logic.execute(input, executors)`. See [`docs/host-actors.md`](/Users/davidkpiano/Code/agent/docs/host-actors.md).

## Agent Machines

<!-- setupAgent root export and helpers from src/index.ts and src/setup-agent.ts -->

Import `createAgentSchemas(...)` and `setupAgent(...)` from `@statelyai/agent`:

```ts
import {
  createAgentSchemas,
  parseOutput,
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
const agent = setupAgent({
  schemas,
  requests: {
    answerQuestion: {
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: answerSchema,
      },
      model: 'writer',
      prompt: ({ input }) => input.prompt,
    },
  },
});

const machine = agent.createMachine({
  context: ({ input }) => ({ prompt: input.prompt, answer: null }),
  initial: 'answering',
  states: {
    answering: {
      invoke: {
        id: 'answer',
        src: 'answerQuestion',
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: {
          target: 'done',
          actions: assign({
            answer: ({ event }) => parseOutput(answerSchema, event.output).answer,
          }),
        },
      },
    },
    done: { type: 'final' },
  },
});

let step = machine.initial({ prompt: 'Why XState?' });

while (!step.done) {
  for (const request of step.requests) {
    const result = await machine.execute(request, {
      generateText: (request) => generateText(request), // any SDK/framework
      streamText: (request) => streamText(request),
    });
    step = machine.resolve(step, request, result);
  }
}
```

Test a single setup-bound request without running the machine:

```ts
await agent.requests.answerQuestion.execute(
  { prompt: 'Why XState?' },
  { generateText }
);
```

This is normal XState underneath: use `machine.initial(...)`, `machine.transition(...)`, and `machine.resolve(...)` for the blessed step loop; drop down to pure `initialTransition(...)` / `transitionResult(...)`; or use `createActor(...)`, snapshots, persistence, guards, actions, and host-provided actors. `setupAgent(...)` adds schema-derived concrete types, retained schemas, built-in text actor sources, reusable text actors, `step.requests`, `machine.getRequests(...)`, and `machine.execute(...)`.

When a request declares `events`, `machine.getRequests(...)` returns `send_event_<TYPE>` tools for those events only if they are currently legal from the snapshot. That lets a model choose legal machine events, such as moves in a game, without exposing every transition.

## Static Workflow Definitions

<!-- static agent workflow JSON Schema export from package.json and schemas/agent-workflow.json -->

The package also publishes a JSON Schema for static, declarative agent workflow definitions:

```ts
import workflowSchema from '@statelyai/agent/agent-workflow.json';
```

Use `setupAgent.fromConfig(...)` to lower static definitions to the same agent machine shape as TS-first `setupAgent(...)` authoring. Static definitions separate model requests from XState-like control flow:

```yaml
requests:
  answerQuestion:
    model: openai/gpt-4.1
    system: "You answer for {{ context.userName }}."
    prompt: "Question: {{ input.question }}"
    input:
      type: object
      properties:
        question: { type: string }
      required: [question]
    output:
      type: object
      properties:
        answer: { type: string }
      required: [answer]

initial: thinking
states:
  thinking:
    invoke:
      src: answerQuestion
      input:
        question: "{{ context.question }}"
      onDone:
        target: done
        assign:
          answer: "{{ event.output.answer }}"
  done:
    type: final
```

Then:

```ts
const machine = setupAgent.fromConfig(config);
```

Values wrapped as whole strings, such as `"{{ context.question }}"`, are typed expressions. Text fields like `system` and `prompt` are templates and may embed `{{ }}` expressions inside larger strings. The current lowering supports simple dot-path expressions over `input`, `context`, and `event`.

Human input is a normal host-provided actor. Static workflows can invoke `agent.userInput`; the host decides whether that means a CLI prompt, UI form, Slack interaction, or webhook pause:

```yaml
states:
  askRecipient:
    invoke:
      src: agent.userInput
      input:
        prompt: "Who should receive this email?"
        schema:
          type: object
          properties:
            recipient: { type: string }
          required: [recipient]
      onDone:
        target: drafting
        assign:
          recipient: "{{ event.output.recipient }}"
```

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

Runtime is normal XState. Use the agent step helpers when you want the package to collect requests for you, pure `initialTransition(...)` / `transitionResult(...)` when a framework wants to own every transition detail, or `createActor(...)`, `toPromise(...)`, snapshots, persisted snapshots, `machine.provide({ actors })`, and your framework transport of choice. Model/tool execution stays under your control.

**Read the documentation: [stately.ai/docs/agents](https://stately.ai/docs/agents)**
