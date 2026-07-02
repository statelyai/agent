/**
 * Human-in-the-loop approval, the idle-first way.
 *
 * LangGraph models this with `interrupt()`: a node call that pauses graph
 * execution mid-function and resumes it (re-running the node from the top)
 * when the host calls back in with a value.
 *
 * Here there is no interrupt — the machine simply has a state
 * (`reviewing`) with no invoke, so it has nothing left to do until a human
 * sends `APPROVE`/`REJECT`. `runAgent` detects this and settles
 * `{ status: 'idle', snapshot }` instead of hanging. The host persists that
 * snapshot (a plain, JSON-serializable object — verified by the
 * round-trip below) and, once the human has decided, resumes with
 * `runAgent(machine, { snapshot, event, ...executors })`. No special
 * "resume node" or replay semantics: it's the same state machine, given
 * one more event.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent, setupAgent } from '../../src/index.js';

export async function runLangGraphHumanInTheLoopExample() {
  const agent = setupAgent({
    context: z.object({
      topic: z.string(),
      draft: z.string().nullable(),
    }),
    input: z.object({ topic: z.string() }),
    output: z.object({ published: z.boolean(), draft: z.string() }),
    events: {
      APPROVE: z.object({}),
      REJECT: z.object({ reason: z.string() }),
    },
    requests: {
      writeDraft: {
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.string(),
        },
        model: 'writer',
        prompt: ({ input }) => input.topic,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-hitl',
    context: ({ input }) => ({ topic: input.topic, draft: null }),
    initial: 'drafting',
    states: {
      drafting: {
        invoke: {
          src: 'writeDraft',
          input: ({ context }: { context: { topic: string } }) => ({
            topic: context.topic,
          }),
          onDone: ({ output }) => ({
            target: 'reviewing',
            context: { draft: output },
          }),
        },
      },
      reviewing: {
        on: {
          APPROVE: { target: 'published' },
          REJECT: ({ context, event }) => ({
            target: 'drafting',
            context: {
              topic: `${context.topic}\nRevision: ${(event as unknown as { reason: string }).reason}`,
            },
          }),
        },
      },
      published: {
        type: 'final',
        output: ({ context }) => ({
          published: true,
          draft: context.draft ?? '',
        }),
      },
    },
  });

  const generateText = async ({ prompt }: { prompt?: string }) => `Draft: ${prompt ?? ''}`;

  const first = await runAgent(machine, {
    input: { topic: 'release notes' },
    generateText,
  });

  // No invoke in `reviewing`, nothing in flight: runAgent settles idle
  // instead of blocking. Persist the snapshot (host's choice of store) —
  // JSON round-trip it here to prove it survives a real persistence layer.
  assert.equal(first.status, 'idle');
  const persisted = JSON.parse(JSON.stringify(first.snapshot));

  // ...later, new process, human approved...
  const second = await runAgent(machine, {
    snapshot: persisted,
    event: { type: 'APPROVE' },
    generateText,
  });

  assert.equal(second.status, 'done');
  assert.deepEqual(second.status === 'done' ? second.output : undefined, {
    published: true,
    draft: 'Draft: release notes',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphHumanInTheLoopExample();
}
