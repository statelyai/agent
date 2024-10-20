import { z } from 'zod';
import { createAgent } from '../src';
import { openai } from '@ai-sdk/openai';
import { getFromTerminal } from './helpers/helpers';

const agent = createAgent({
  name: 'chatbot',
  model: openai('gpt-4o-mini'),
  events: {
    'agent.respond': z.object({
      response: z.string().describe('The response from the agent'),
    }),
    'agent.endConversation': z.object({}).describe('Stop the conversation'),
  },
  context: {
    userMessage: z.string(),
  },
});

async function main() {
  let status = 'listening';
  let userMessage = '';

  while (status !== 'finished') {
    switch (status) {
      case 'listening':
        userMessage = await getFromTerminal('User:');
        status = 'responding';
        break;

      case 'responding':
        const decision = await agent.decide({
          messages: agent.getMessages(),
          goal: 'Respond to the user, unless they want to end the conversation.',
          state: {
            value: status,
            context: {
              userMessage: 'User says: ' + userMessage,
            },
          },
        });

        if (decision?.nextEvent?.type === 'agent.respond') {
          console.log(`Agent: ${decision.nextEvent.response}`);
          status = 'listening';
        } else if (decision?.nextEvent?.type === 'agent.endConversation') {
          status = 'finished';
        }
        break;
    }
  }

  console.log('End of conversation.');
  process.exit();
}

main().catch(console.error);
