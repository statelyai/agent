import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
import { createChatbotMessagesExample } from '../../examples/index.js';

test('message-centric chatbot workflow accumulates structured messages across turns', async () => {
  const machine = createChatbotMessagesExample(async (messages) => ({
    message: {
      role: 'assistant',
      content: `Replying to: ${messages.at(-1)?.content ?? ''}`,
    },
  }));

  const afterFirstTurn = machine.transition(machine.getInitialState(), {
    type: 'messages.user',
    message: {
      role: 'user',
      content: 'Hello there',
    },
  });
  const firstResult = await execute(machine, afterFirstTurn);

  expect(firstResult.status).toBe('pending');
  if (firstResult.status === 'pending') {
    expect(firstResult.messages).toEqual([
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Replying to: Hello there' },
    ]);

    const afterSecondTurn = machine.transition(firstResult.state, {
      type: 'messages.user',
      message: {
        role: 'user',
        content: 'Can you expand on that?',
      },
    });
    const secondResult = await execute(machine, afterSecondTurn);

    expect(secondResult.status).toBe('pending');
    if (secondResult.status === 'pending') {
      expect(secondResult.messages).toEqual([
        { role: 'user', content: 'Hello there' },
        { role: 'assistant', content: 'Replying to: Hello there' },
        { role: 'user', content: 'Can you expand on that?' },
        { role: 'assistant', content: 'Replying to: Can you expand on that?' },
      ]);
    }
  }
});
