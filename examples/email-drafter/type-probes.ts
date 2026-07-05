/**
 * Compile-only type probes for the email-drafter agent.
 *
 * Nothing here runs — the machines exist purely so `tsc` fails if the typed
 * authoring surface regresses (schema-typed meta, event payload inference,
 * output typing, named-logic onDone output). Kept out of the runnable
 * `email-drafter/index.ts` so that file reads as a clean example. Typechecked
 * via `examples/tsconfig.json` (`include: ["."]`).
 */
import { assistantMessage, setupAgent } from '../../src/index.js';
import {
  emailDrafterActors,
  emailDrafterSchemas,
  models,
} from './index.js';

// Rebuild the same agent the runnable machine uses. Rebuilt (not imported) so
// index.ts need not export the agent — exporting its full inferred type trips
// the declaration serializer (TS7056) under the root tsconfig's `declaration`.
const agent = setupAgent({
  schemas: emailDrafterSchemas,
  models,
  actorSources: emailDrafterActors,
});

// meta is schema-typed, and event payloads are inferred per event type.
agent.createMachine({
  context: {
    prompt: '',
    assessment: null,
    draft: null,
    sentEmails: [],
    messages: [],
  },
  initial: 'probe',
  states: {
    probe: {
      meta: {
        // @ts-expect-error meta is schema-typed: 'banner' is not a valid interaction type
        interaction: { type: 'banner' },
      },
      on: {
        MORE_INFO: ({ event }) => ({
          context: {
            // @ts-expect-error MORE_INFO carries `details`, not `changes`
            prompt: event.changes,
          },
        }),
      },
    },
    probeFinal: {
      type: 'final',
      output: ({ context }) => ({ sentEmails: context.sentEmails }),
    },
  },
});

// Root-level `output` is natively typed by XState against the output schema.
agent.createMachine({
  context: {
    prompt: '',
    assessment: null,
    draft: null,
    sentEmails: [],
    messages: [],
  },
  // @ts-expect-error machine output is { sentEmails: EmailDraft[] }
  output: () => ({ wrong: true }),
  initial: 'probe',
  states: {
    probe: {
      type: 'final',
      // @ts-expect-error top-level final state output is { sentEmails: EmailDraft[] }
      output: () => ({ wrong: true }),
    },
  },
});

// Named text logic: onDone output is typed from the logic output schema.
agent.createMachine({
  context: {
    prompt: '',
    assessment: null,
    draft: null,
    sentEmails: [],
    messages: [],
  },
  initial: 'streaming',
  states: {
    streaming: {
      invoke: {
        id: 'streamDraft',
        src: 'streamDraft',
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ context, output }) => ({
          context: {
            messages: [...context.messages, assistantMessage(output)],
          },
        }),
      },
    },
  },
});
