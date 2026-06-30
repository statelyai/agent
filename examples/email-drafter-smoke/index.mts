import { createActor, createAsyncLogic, waitFor } from 'xstate';
import {
  draftEmail,
  emailDrafter,
  evaluatePrompt,
} from '../email-drafter/index.js';
import type { AgentTextRequest } from '../../src/index.js';

const calls: AgentTextRequest[] = [];

const machine = emailDrafter.provide({
  actorSources: {
    evaluatePrompt: evaluatePrompt.withExecutor(async ({ request }) => {
      calls.push(request);
      // first evaluation: unsatisfied; second: satisfied
      const satisfied = calls.filter((c) => c.system?.includes('Evaluate')).length > 1;
      return { satisfied, missing: satisfied ? [] : ['recipient'], questions: satisfied ? [] : ['Who?'] };
    }),
    draftEmail: draftEmail.withExecutor(async ({ request }) => {
      calls.push(request);
      return { to: 'sam@example.com', subject: 'Hello', body: 'Hi Sam!' };
    }),
    sendEmail: createAsyncLogic({ run: async () => ({ sent: true }) }),
  },
});

const actor = createActor(machine);
actor.start();

actor.send({ type: 'PROMPT_SUBMITTED', prompt: 'email sam' });
await waitFor(actor, (s) => s.matches('needsMoreInfo'));
console.log('1. needsMoreInfo meta:', JSON.stringify(actor.getSnapshot().getMeta(), null, 0).slice(0, 80), '…');

actor.send({ type: 'MORE_INFO', details: 'sam@example.com, say hello' });
await waitFor(actor, (s) => s.matches('reviewing'));
console.log('2. reviewing, draft:', actor.getSnapshot().context.draft);
console.log('3. messages:', actor.getSnapshot().context.messages.map((m: any) => m.role));

actor.send({ type: 'SEND' });
await waitFor(actor, (s) => s.matches('sent'));
actor.send({ type: 'END' });
await waitFor(actor, (s) => s.status === 'done');
console.log('4. final output:', actor.getSnapshot().output);
console.log('5. generateText inputs seen by host:', calls.map((c) => ({ model: c.model, hasSchema: !!c.outputSchema })));
