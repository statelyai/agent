import { expect, test } from 'vitest';
import { createRagExample } from '../../examples/index.js';

test('rag workflow retrieves documents and synthesizes a grounded answer', async () => {
  const machine = createRagExample({
    retrieve: async (question) => ({
      documents: [
        { id: 'doc-1', content: `${question} :: first fact` },
        { id: 'doc-2', content: `${question} :: second fact` },
      ],
    }),
    adapter: {
      generateText: async ({ prompt }) => ({
        answer: String(prompt)
          .replace('Question: ', '')
          .replace('\n\nDocuments:\n- [doc-1] ', ' => ')
          .replace('\n- [doc-2] ', ' | '),
      }),
    },
  });

  const result = await machine.execute(
    machine.getInitialState({ question: 'What is LangGraph?' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      question: 'What is LangGraph?',
      documents: [
        { id: 'doc-1', content: 'What is LangGraph? :: first fact' },
        { id: 'doc-2', content: 'What is LangGraph? :: second fact' },
      ],
      answer:
        'What is LangGraph? => What is LangGraph? :: first fact | What is LangGraph? :: second fact',
    });
  }
});
