import { describe, expect, test } from 'vitest';
import { createSelfEvaluationLoopFlowExample } from '../../examples/index.js';

describe('CrewAI self evaluation loop equivalent', () => {
  test('iterates until the generated post passes evaluation', async () => {
    const attempts: string[] = [];
    const machine = createSelfEvaluationLoopFlowExample({
      generatePost: async ({ feedback, attempt }) => {
        const post =
          attempt === 1
            ? 'A very long post with too much detail and maybe an emoji :)'
            : `Refined post after: ${feedback}`;
        attempts.push(post);
        return { post };
      },
      evaluatePost: async (post) =>
        post.includes('Refined')
          ? { valid: true, feedback: null }
          : {
            valid: false,
            feedback: 'Shorten it and remove emoji-like punctuation.',
          },
    });

    const result = await machine.execute(
      machine.getInitialState({
        topic: 'Flying cars',
      })
    );

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.output.valid).toBe(true);
      expect(result.output.attempt).toBe(2);
      expect(attempts).toHaveLength(2);
      expect(result.output.post).toContain('Refined post after');
    }
  });
});
