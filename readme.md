# Stately Agent

Stately Agent is the state machine authoring layer for AI agents. Author your AI agents as state machines. Run them anywhere.

The package owns these first-class authoring surfaces:

- `createAgentSchemas(...)`: schema bundle for normal XState `setup(...)`.
- `setupAgent(...)`: XState setup with built-in text actor sources.
- `createTextLogic(...)`: reusable, schema-typed model-call actors when a request deserves a name.
- XState `setup({ schemas, actorSources })`: typed machine authoring with normal XState.
- `agent.generateText` / `agent.streamText`: built-in model-call actor sources for inline text-only workflows.
- `setupAgent.fromConfig(...)`: static workflow config lowered to a normal XState machine.
- `runAgent(...)`: host-owned execution loop for request-driven machines.
- `initialAgentStep(...)`, `transitionAgentStep(...)`, `resolveAgentStep(...)`, `executeAgentRequest(...)`: lower-level helpers for custom host loops.

Use `setupAgent(...)` for the fastest text-agent path. Use normal XState `setup(...)` when you want the thinnest possible XState surface. Use normal host code for runtime execution. Stately Agent adds the batteries: built-in text actors, reusable text logic, message helpers, examples, and retained schemas.

You can still call the Vercel AI SDK, LangChain, Workers AI, or any other model/tool runtime yourself. The machine only declares behavior; hosts can either execute requests from pure XState transitions or provide actors with `machine.provide({ actorSources })`. That keeps runtime transparency while making the workflow typed and inspectable.

Choose this over LangGraph when you want agent workflows to be explicit state machines instead of framework-owned graphs: same workflow shapes, strong TypeScript for machine context/events/actors, first-class XState snapshots/guards, and no required runtime backend. Choose it over handrolled workflows when the control flow is important enough to inspect, persist, replay, and test.

Visualization is intentionally outside this package. Stately Studio, and the upcoming VS Code extension, own rendering, inspection, and diagramming for authored machines. `@statelyai/agent` focuses on authoring and execution seams.

For SDK integration, your host reads returned requests and calls Vercel AI SDK, Cloudflare Workers AI, LangChain, local models, or custom code. Start with inline `agent.generateText`; move to reusable `createTextLogic(...)` actors when the model-call shape should be named, shared, or tested standalone. See [`docs/host-actors.md`](/Users/davidkpiano/Code/agent/docs/host-actors.md).

## Agent Machines

<!-- setupAgent built-in agent.generateText quickstart from src/setup-agent.ts -->

For text-only workflows, `setupAgent(...)` gives you typed schemas plus built-in `agent.generateText` / `agent.streamText` actor sources:

```ts
import {
  createAgentSchemas,
  parseOutput,
  runAgent,
  setupAgent,
} from '@statelyai/agent';
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

const agent = setupAgent({ schemas });
const machine = agent.createMachine({
  context: ({ input }) => ({ prompt: input.prompt, answer: null }),
  initial: 'answering',
  states: {
    answering: {
      invoke: {
        id: 'answer',
        src: 'agent.generateText',
        input: ({ context }) => ({
          model: 'writer',
          prompt: context.prompt,
          outputSchema: answerSchema,
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { answer: parseOutput(answerSchema, output).answer },
        }),
      },
    },
    done: { type: 'final' },
  },
});

const result = await runAgent(machine, {
  input: { prompt: 'Why XState?' },
  generateText: (request) => generateText(request), // any SDK/framework
  streamText: (request) => streamText(request),
});
if (result.status === 'done') {
  console.log(result.output);
}
```

When a request becomes reusable, extract it:

```ts
import { createTextLogic } from '@statelyai/agent';

const answerQuestion = createTextLogic({
  schemas: {
    input: z.object({ prompt: z.string() }),
    output: answerSchema,
  },
  model: 'writer',
  prompt: ({ input }) => input.prompt,
});

await answerQuestion.execute({ prompt: 'Why XState?' }, { generateText });
```

This is normal XState. Use `runAgent(...)` for request-driven local execution; use `initialAgentStep(...)`, `transitionAgentStep(...)`, `resolveAgentStep(...)`, and `executeAgentRequest(...)` for custom host loops; drop down to pure `initialTransition(...)` / `transitionResult(...)`; or use `createActor(...)`, snapshots, persistence, guards, actions, and host-provided actor sources. Stately Agent adds schema bundles, reusable text actors, message helpers, and request extraction.

Use `createDecisionLogic(...)` to let a model choose exactly one legal machine event, such as a move in a game, without exposing every transition. `allowedEvents` narrows the candidates; `getAgentRequests(...)` intersects them with the events currently legal from the snapshot (via `getAcceptedEvents(...)`) and returns the surviving candidates on the decision request's `events` field.

## Static Workflow Definitions

<!-- static agent workflow JSON Schema export from package.json and schemas/agent-workflow.json -->

The package also publishes a JSON Schema for static, declarative agent workflow definitions:

```ts
import workflowSchema from '@statelyai/agent/agent-workflow.json';
```

Use `setupAgent.fromConfig(...)` to lower static JSON/YAML definitions to a normal XState machine with retained agent request metadata. JS authoring should pass Standard Schema-compatible schemas, such as Zod, directly to `setupAgent(...)`; static configs use JSON Schema and are adapted at the boundary.

```yaml
requests:
  answerQuestion:
    model: openai/gpt-4.1
    system: "Answer the user's question."
    prompt: "{{ input.question }}"
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

Values wrapped as whole strings, such as `"{{ context.question }}"`, are typed expressions. The current lowering supports simple dot-path expressions over `input`, `context`, and `event`.

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

Examples are flat directories under [`examples/`](/Users/davidkpiano/Code/agent/examples). Each directory includes `metadata.json` with origin and comparison notes.

Run them with `node --import tsx examples/<name>/index.ts`.

Visualize these machines in Stately Studio or the upcoming VS Code extension. This package does not ship diagram converters or graph-export APIs.

Start here:

- Agent authoring: [`examples/email-drafter/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter/index.ts)
- Framework comparisons: [`examples/langgraph-conditional-routing/index.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.ts), [`examples/burr-conversational-rag/index.ts`](/Users/davidkpiano/Code/agent/examples/burr-conversational-rag/index.ts), [`examples/crewai-content-creator/index.ts`](/Users/davidkpiano/Code/agent/examples/crewai-content-creator/index.ts)
- Host adapters: [`examples/ai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-host/index.ts), [`examples/ai-sdk-sub-agents/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-sub-agents/index.ts), [`examples/cloudflare-agent-host/index.ts`](/Users/davidkpiano/Code/agent/examples/cloudflare-agent-host/index.ts)
- AI SDK workflows: [`examples/ai-sdk-marketing-chain/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-marketing-chain/index.ts), [`examples/ai-sdk-routing/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-routing/index.ts), [`examples/ai-sdk-parallel-review/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-parallel-review/index.ts), [`examples/ai-sdk-orchestrator-worker/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-orchestrator-worker/index.ts), [`examples/ai-sdk-evaluator-optimizer/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-evaluator-optimizer/index.ts)
- Sub-agents: [`examples/ai-sdk-sub-agents/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-sub-agents/index.ts), [`examples/xstate-sub-agents/index.ts`](/Users/davidkpiano/Code/agent/examples/xstate-sub-agents/index.ts), [`examples/debate-sub-agents/index.ts`](/Users/davidkpiano/Code/agent/examples/debate-sub-agents/index.ts)
- Local smoke test: [`examples/email-drafter-smoke/index.mts`](/Users/davidkpiano/Code/agent/examples/email-drafter-smoke/index.mts)
- LangGraph parity: [`examples/langgraph-conditional-routing/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.test.ts), [`examples/langgraph-rewoo/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-rewoo/index.test.ts), [`docs/langgraph-parity.md`](/Users/davidkpiano/Code/agent/docs/langgraph-parity.md), [`docs/langgraph-gaps.md`](/Users/davidkpiano/Code/agent/docs/langgraph-gaps.md)
- Burr parity: [`examples/burr-counter/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-counter/index.test.ts), [`examples/burr-tool-calling/index.test.ts`](/Users/davidkpiano/Code/agent/examples/burr-tool-calling/index.test.ts), [`docs/burr-parity.md`](/Users/davidkpiano/Code/agent/docs/burr-parity.md)
- CrewAI parity: [`examples/crewai-content-creator/index.test.ts`](/Users/davidkpiano/Code/agent/examples/crewai-content-creator/index.test.ts), [`examples/crewai-write-a-book/index.test.ts`](/Users/davidkpiano/Code/agent/examples/crewai-write-a-book/index.test.ts), [`docs/crewai-parity.md`](/Users/davidkpiano/Code/agent/docs/crewai-parity.md)

CrewAI Flow parity is tracked in [`docs/crewai-parity.md`](/Users/davidkpiano/Code/agent/docs/crewai-parity.md), the same way LangGraph parity is tracked separately.

Burr parity is tracked in [`docs/burr-parity.md`](/Users/davidkpiano/Code/agent/docs/burr-parity.md), focused on action-like authoring patterns without adopting Burr's runtime.

## Runtime

Runtime is normal XState. Use `runAgent(...)` when you want the package to collect and resolve requests for you, pure `initialTransition(...)` / `transitionResult(...)` when a framework wants to own every transition detail, or `createActor(...)`, `toPromise(...)`, snapshots, persisted snapshots, `machine.provide({ actorSources })`, and your framework transport of choice. Model/tool execution stays under your control.

**Read the documentation: [stately.ai/docs/agents](https://stately.ai/docs/agents)**
