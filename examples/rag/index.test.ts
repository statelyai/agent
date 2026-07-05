import { expect, test } from 'vitest';
import { runRAGExample } from './index.js';

test('retrieves relevant docs by keyword and answers grounded on them', async () => {
  // Mock model: echoes how many docs it was grounded on. Real model on direct run.
  const generateText = async ({ prompt }: { prompt?: string }) => {
    const count = (prompt ?? '').match(/^\[\d+\] /gm)?.length ?? 0;
    return { output: `grounded on ${count} docs` };
  };

  const result = await runRAGExample({
    question: 'What is context in a state machine?',
    generateText,
  });

  // Retrieval surfaced the context doc via keyword overlap.
  expect(result.documents.some((doc) => doc.includes('extended, quantitative state'))).toBe(true);
  expect(result.documents.length).toBeGreaterThan(0);
  expect(result.documents.length).toBeLessThanOrEqual(3);
  expect(result.answer).toBe(`grounded on ${result.documents.length} docs`);
});

test('accumulates conversational memory across a turn', async () => {
  const generateText = async () => ({ output: 'a guard is a condition' });

  const result = await runRAGExample({
    question: 'What is a guard?',
    memory: ['Q: earlier question', 'A: earlier answer'],
    generateText,
  });

  expect(result.memory).toEqual([
    'Q: earlier question',
    'A: earlier answer',
    'Q: What is a guard?',
    'A: a guard is a condition',
  ]);
});
